import { expect, test } from 'bun:test';
import { runTranscript } from './slack-transcript-protocol.mjs';
import { compactOutput } from './slack-output.mjs';
import { formatOutput } from './slack-format.mjs';
import { foregroundEvidence, nativeInteractionArgs } from './slack-interaction.mjs';
import { collectTranscriptPages } from './slack-transcript-pages.mjs';

const preflight = { operation: 'read-transcript', phase: 'select', requested: 'FFILE' };
const emit = `console.log(JSON.stringify(${JSON.stringify(preflight)}));`;
const command = (source) => [process.execPath, '--eval', source];
const selection = () => ({ token: 'verified-token', context: { ref: 'FFILE' } });

function expectFailureFormats(result, opening, interaction = 'background') {
  const original = structuredClone(result.receipt);
  const receipt = {
    ...result.receipt,
    ...(interaction === 'foreground' ? { interaction: foregroundEvidence(result.receipt) } : {}),
  };
  const compact = compactOutput(receipt, 'read-transcript', 'FFILE');
  expect(compact.status).toBe('stopped');
  expect(compact.error).toBe(result.receipt.error);
  expect(compact.next).toBe(result.receipt.next);
  const json = JSON.parse(formatOutput(compact, 'json', receipt));
  expect(json.openingMayHaveBeenRequested).toBe(opening);
  expect(Object.hasOwn(json, 'openingMayHaveBeenRequested')).toBe(opening !== undefined);
  const output = formatOutput(compact, 'text', receipt);
  if (opening === true) {
    expect(output).toContain('Transcript opening may have been requested.');
    expect(output).not.toContain('No transcript-opening token was sent.');
  } else if (opening === false) {
    expect(output).toContain('No transcript-opening token was sent.');
    expect(output).not.toContain('Transcript opening may have been requested.');
  } else {
    expect(output).not.toContain('No transcript-opening token was sent.');
    expect(output).not.toContain('Transcript opening may have been requested.');
  }
  if (interaction === 'foreground') {
    expect(json.interaction).toEqual(foregroundEvidence(result.receipt));
    expect(output.match(/Foreground interaction requested/g)).toHaveLength(1);
  } else expect(json.interaction).toBeUndefined();
  expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
  expect(result.receipt).toEqual(original);
}

test('sends only the selected token after asynchronous verification, retaining both receipts', async () => {
  let verified = false;
  const result = await runTranscript(
    command(`${emit}
    const input = JSON.parse(await Bun.stdin.text());
    if (input.token !== 'verified-token' || Object.keys(input).length !== 1) process.exit(2);
    console.log(JSON.stringify({operation:'read-transcript',phase:'result',selected:input.token}));
  `),
    {
      select: async (value) => {
        expect(value).toEqual(preflight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        verified = true;
        return selection();
      },
    }
  );
  expect(verified).toBe(true);
  expect(result.code).toBe(0);
  expect(result.receipt.preflight).toEqual(preflight);
  expect(result.receipt.selected).toBe('verified-token');
  expect(result.context).toEqual({ ref: 'FFILE' });
});

test('failed reference verification never sends an opener token', async () => {
  const result = await runTranscript(
    command(`${emit}
    const input=JSON.parse(await Bun.stdin.text());
    if(input.token || input.cancel!==true) process.exit(2);
    console.log(JSON.stringify({status:'stopped',error:'Selection cancelled',inputWasCancelled:true}));
    process.exit(1);
  `),
    {
      select: () => {
        throw new Error('stale binding');
      },
    }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.error).toBe('stale binding');
  expect(result.receipt.inputWasCancelled).toBe(true);
  expect(result.receipt.preflight).toEqual(preflight);
  expectFailureFormats(result, false);
});

test('a later native paging failure retains the verified selection context and page receipts', async () => {
  const partial = {
    operation: 'read-transcript',
    phase: 'result',
    requested: 'FFILE',
    status: 'partial',
    error: 'Transcript source changed before the next scroll',
    transcriptPages: [{ pagination: { index: 1 }, retained: true }],
    transcriptBatch: {
      requestedPages: 3,
      completedPages: 1,
      attemptedPages: 2,
      direction: 'down',
      stopReason: 'error',
    },
  };
  const result = await runTranscript(
    command(`${emit}
      const input=JSON.parse(await Bun.stdin.text());
      if(input.token!=='verified-token') process.exit(2);
      console.log(JSON.stringify(${JSON.stringify(partial)}));
      process.exit(1);
    `),
    { select: selection }
  );
  expect(result.code).toBe(1);
  expect(result.context).toEqual({ ref: 'FFILE' });
  expect(result.receipt).toEqual({ ...partial, preflight });
});

test('pretty native permission errors preserve exit status without requesting selection', async () => {
  const result = await runTranscript(
    command(
      `console.log(JSON.stringify({status:'permission-required',next:'Grant access'},null,2));process.exit(3);`
    ),
    {
      select: () => {
        throw new Error('must not select');
      },
    }
  );
  expect(result.code).toBe(3);
  expect(result.receipt).toEqual({ status: 'permission-required', next: 'Grant access' });
});

test('a result without a verified preflight cannot claim success', async () => {
  const result = await runTranscript(
    command(`console.log(JSON.stringify({phase:'result',status:'ok'}));`),
    { select: selection }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('no verified selection');
});

test('a repeated preflight stops the same process', async () => {
  const result = await runTranscript(command(`${emit}${emit}await Bun.stdin.text();`), {
    select: selection,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('Repeated');
});

test('cancellation interrupts pending verification without sending an opener token', async () => {
  const abort = new AbortController();
  const result = await runTranscript(command(`${emit}await Bun.stdin.text();`), {
    signal: abort.signal,
    select: () => {
      setTimeout(() => abort.abort(), 10);
      return new Promise(() => {});
    },
  });
  expect(result.code).toBe(1);
  expect(result.receipt.status).toBe('stopped');
  expect(result.receipt.error).toContain('cancelled');
  expectFailureFormats(result, false);
});

test('the process deadline also bounds pending selection and missing receipts', async () => {
  const start = Date.now();
  const result = await runTranscript(command(`${emit}await Bun.stdin.text();`), {
    timeoutMs: 150,
    select: () => new Promise(() => {}),
  });
  expect(result.code).toBe(1);
  expect(Date.now() - start).toBeLessThan(2000);
  expect(result.receipt.status).toBe('stopped');
  expect(result.receipt.error).toContain('timed out');
});

test('an already cancelled operation starts no native helper', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    runTranscript(['/path/that/must/not/be/executed'], {
      signal: abort.signal,
      select: selection,
    })
  ).rejects.toThrow('before native work');
});

test('uncertain token delivery never sends a cancel as if it could recall the opening', async () => {
  const writes = [];
  const result = await runTranscript(['fake-native'], {
    select: selection,
    spawn: () => ({
      stdin: {
        write: (value) => writes.push(JSON.parse(value)),
        flush: async () => {
          throw new Error('Token delivery uncertain');
        },
        end() {},
      },
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(preflight) + '\n'));
          controller.close();
        },
      }),
      exited: Promise.resolve(1),
      kill() {},
    }),
  });
  expect(writes).toEqual([{ token: 'verified-token' }]);
  expect(result.code).toBe(1);
  expect(result.receipt.openingMayHaveBeenRequested).toBe(true);
  expect(result.receipt.error).toBe('Token delivery uncertain');
  expect(result.receipt.next).toContain('Inspect');
  expect(result.receipt.next).not.toContain('no transcript-opening token');
  expectFailureFormats(result, true);
});

test('a helper ignoring SIGTERM is killed before the lease can be released', async () => {
  const signals = [];
  let finish, stream;
  const started = Date.now();
  const result = await runTranscript(['fake-native'], {
    timeoutMs: 20,
    terminationGraceMs: 20,
    select: selection,
    spawn: () => ({
      stdin: { write() {}, flush() {}, end() {} },
      stdout: new ReadableStream({
        start(controller) {
          stream = controller;
        },
      }),
      exited: new Promise((resolve) => {
        finish = resolve;
      }),
      kill(signal) {
        signals.push(signal);
        if (signal === 'SIGKILL') {
          stream.close();
          finish(137);
        }
      },
    }),
  });
  expect(result.code).toBe(1);
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(Date.now() - started).toBeLessThan(1000);
});

test('cancellation after a result retains received after-open diagnostics', async () => {
  const abort = new AbortController();
  const nativeResult = {
    operation: 'read-transcript',
    phase: 'result',
    desktop: { samples: [{ stage: 'after-open' }] },
    transcript: { content: { nodes: [] } },
  };
  let stream, finish;
  const result = await runTranscript(['fake-native'], {
    signal: abort.signal,
    select: selection,
    spawn: () => ({
      stdin: {
        write(value) {
          if (JSON.parse(value).token) {
            stream.enqueue(new TextEncoder().encode(JSON.stringify(nativeResult) + '\n'));
            setTimeout(() => abort.abort(), 10);
          }
        },
        flush() {},
        end() {},
      },
      stdout: new ReadableStream({
        start(controller) {
          stream = controller;
          stream.enqueue(new TextEncoder().encode(JSON.stringify(preflight) + '\n'));
        },
      }),
      exited: new Promise((resolve) => {
        finish = resolve;
      }),
      kill() {
        stream.close();
        finish(143);
      },
    }),
  });
  expect(result.code).toBe(1);
  expect(result.receipt.status).toBe('stopped');
  expect(result.receipt.nativeResult).toEqual(nativeResult);
  expect(result.receipt.openingMayHaveBeenRequested).toBe(true);
  expectFailureFormats(result, true);
});

test('uncertain token delivery retains a subsequently received native result as diagnostics only', async () => {
  const nativeResult = {
    operation: 'read-transcript',
    phase: 'result',
    transcript: { stable: true },
  };
  let stream;
  const result = await runTranscript(['fake-native'], {
    select: selection,
    spawn: () => ({
      stdin: {
        write() {},
        flush() {
          stream.enqueue(new TextEncoder().encode(JSON.stringify(nativeResult) + '\n'));
          stream.close();
          throw new Error('Token delivery uncertain');
        },
        end() {},
      },
      stdout: new ReadableStream({
        start(controller) {
          stream = controller;
          stream.enqueue(new TextEncoder().encode(JSON.stringify(preflight) + '\n'));
        },
      }),
      exited: Promise.resolve(0),
      kill() {},
    }),
  });
  expect(result.code).toBe(1);
  expect(result.receipt.error).toBe('Token delivery uncertain');
  expect(result.receipt.openingMayHaveBeenRequested).toBe(true);
  expect(result.receipt.nativeResult).toEqual(nativeResult);
  expectFailureFormats(result, true);
});

const foregroundPreflight = {
  ...preflight,
  interaction: {
    mode: 'foreground',
    state: 'activated',
    activated: true,
    activationRequested: true,
    ownershipLost: false,
    focusRestoration: 'none',
  },
};

test('foreground source rejection retains confirmed no-token evidence in every format', async () => {
  const result = await runTranscript(
    command(`console.log(JSON.stringify(${JSON.stringify(foregroundPreflight)}));
      const input=JSON.parse(await Bun.stdin.text());
      if(input.token || input.cancel!==true) process.exit(2);
      console.log(JSON.stringify({status:'stopped',error:'Selection cancelled'}));
      process.exit(1);
    `),
    {
      select: () => {
        throw new Error('Source media binding changed');
      },
    }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.error).toBe('Source media binding changed');
  expectFailureFormats(result, false, 'foreground');
});

test('foreground uncertain token delivery retains observed activation and the no-replay warning', async () => {
  const writes = [];
  const result = await runTranscript(['fake-native'], {
    select: selection,
    spawn: () => ({
      stdin: {
        write: (value) => writes.push(JSON.parse(value)),
        flush: async () => {
          throw new Error('Token delivery uncertain');
        },
        end() {},
      },
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(foregroundPreflight) + '\n'));
          controller.close();
        },
      }),
      exited: Promise.resolve(1),
      kill() {},
    }),
  });
  expect(writes).toEqual([{ token: 'verified-token' }]);
  expect(result.code).toBe(1);
  expectFailureFormats(result, true, 'foreground');
});

for (const opening of [undefined, null]) {
  test(`known native failure preserves ${opening === null ? 'explicit' : 'absent'} unknown opening evidence`, async () => {
    const nativeResult = {
      operation: 'read-transcript',
      status: 'stopped',
      error: 'Selected message/media identity or order changed; transcript withheld',
      ...(opening === null ? { openingMayHaveBeenRequested: null } : {}),
      interaction: foregroundPreflight.interaction,
      verification: { sourceMatched: false },
      transcript: { content: { nodes: [{ label: 'Unverified synthetic content' }] } },
    };
    const result = await runTranscript(
      command(`console.log(JSON.stringify(${JSON.stringify(foregroundPreflight)}));
        const input=JSON.parse(await Bun.stdin.text());
        if(input.token!=='verified-token') process.exit(2);
        console.log(JSON.stringify(${JSON.stringify(nativeResult)}));
        process.exit(1);
      `),
      { select: selection }
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toEqual({ ...nativeResult, preflight: foregroundPreflight });
    expectFailureFormats(result, opening, 'foreground');
    const compact = compactOutput(result.receipt, 'read-transcript', 'FFILE');
    expect(compact.transcript).toBeUndefined();
    expect(formatOutput(compact)).not.toContain('Unverified synthetic content');
  });
}

test('malformed opening evidence remains unknown instead of becoming a no-token claim', () => {
  for (const value of ['true', 'false', '', 0, 1, {}, []]) {
    expectFailureFormats(
      {
        receipt: {
          operation: 'read-transcript',
          status: 'stopped',
          error: 'Unverified opener state',
          openingMayHaveBeenRequested: value,
        },
      },
      undefined
    );
  }
  const unrelated = compactOutput(
    { status: 'stopped', error: 'Unrelated operation', openingMayHaveBeenRequested: true },
    'read-thread'
  );
  expect(unrelated).not.toHaveProperty('openingMayHaveBeenRequested');
});

const unavailableError =
  'Slack reports that no transcript is available for this attachment. Use read-media with the same reference, or choose another attachment with an existing transcript. No transcript was generated.';

for (const interaction of ['background', 'foreground']) {
  for (const pages of [1, 3]) {
    test(`initial unavailable transcript stays stopped with --pages=${pages} in ${interaction} mode`, async () => {
      const selectionReceipt = interaction === 'foreground' ? foregroundPreflight : preflight;
      const native = {
        status: 'stopped',
        error: unavailableError,
        next: 'Inspect current Slack state before another command; do not replay input blindly.',
        ...(interaction === 'foreground' ? { interaction: foregroundPreflight.interaction } : {}),
        observation: {
          nodes: [{ role: 'AXStaticText', label: 'Synthetic unavailable-panel diagnostic' }],
        },
      };
      const args = nativeInteractionArgs(
        ['read-transcript', 'FFILE', `--pages=${pages}`],
        interaction
      );
      const result = await runTranscript(
        [
          ...command(`
            if (!process.argv.includes(${JSON.stringify(`--pages=${pages}`)})) process.exit(2);
            console.log(JSON.stringify(${JSON.stringify(selectionReceipt)}));
            const input=JSON.parse(await Bun.stdin.text());
            if(input.token!=='verified-token') process.exit(2);
            console.log(JSON.stringify(${JSON.stringify(native)}));
            process.exit(1);
          `),
          '--',
          ...args,
        ],
        { select: () => ({ token: 'verified-token', context: { requested: 'FFILE' } }) }
      );
      expect(result.code).toBe(1);
      expect(result.context).toEqual({ requested: 'FFILE' });
      expect(result.receipt).toEqual({ ...native, preflight: selectionReceipt });
      expect(result.receipt.phase).toBeUndefined();
      expect(result.receipt.transcriptPages).toBeUndefined();
      expect(result.receipt.transcriptBatch).toBeUndefined();
      expectFailureFormats(result, undefined, interaction);
      const receipt = {
        ...result.receipt,
        ...(interaction === 'foreground'
          ? { interaction: foregroundEvidence(result.receipt) }
          : {}),
      };
      const compact = compactOutput(receipt, 'read-transcript', 'FFILE');
      const json = JSON.parse(formatOutput(compact, 'json', receipt));
      expect(json.status).toBe('stopped');
      expect(json.error).toBe(unavailableError);
      expect(json).not.toHaveProperty('transcript');
      expect(json).not.toHaveProperty('pagination');
      const output = formatOutput(compact, 'text', receipt);
      expect(output).toContain(`Stopped: ${unavailableError}`);
      expect(output).not.toContain('No transcript segments were exposed');
      expect(output).not.toContain('0 captured transcript segments');
      expect(output).not.toContain('0 unique transcript segments');
      expect(output).not.toContain('Synthetic unavailable-panel diagnostic');
      expect(JSON.parse(formatOutput(compact, 'full-json', receipt)).error).toBe(unavailableError);
      if (pages > 1) {
        expect(() => collectTranscriptPages(result.receipt, result.context, pages)).toThrow(
          'page budget, identity or counters are invalid'
        );
      }
    });
  }
}
