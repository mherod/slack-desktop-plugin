import { expect, test } from 'bun:test';
import { runSaveMedia } from './slack-save-protocol.mjs';
import { failedSaveMediaOutput } from './slack-save-runner.mjs';
import { foregroundEvidence } from './slack-interaction.mjs';
import { formatOutput } from './slack-format.mjs';

// Synthetic native peers only: no Slack process, AX input, network or downloads.
const preflight = { operation: 'save-media', phase: 'select', requested: 'FDEMO', pid: 123 };
const started = {
  operation: 'save-media',
  phase: 'started',
  requested: 'FDEMO',
  pid: 123,
  action: { attempted: true, accepted: true, startedAt: 1700000000123 },
};
const final = { ...started, phase: 'result', status: 'ok' };
const command = (source) => [process.execPath, '--eval', source];
const emit = (value) => `console.log(JSON.stringify(${JSON.stringify(value)}));`;
const selection = () => ({ token: 'verified-token', context: { ref: 'FDEMO' } });
const transfer = { artifact: { path: '/tmp/synthetic-saved-file', verified: true } };
const complete = async () => transfer;
const peer = ({
  onOpenViewer = 'process.exit(2);',
  onToken = emit(started),
  onCheckpoint = 'process.exit(2);',
  onFinish = emit(final),
  onCancel = emit({ phase: 'result', status: 'stopped', error: 'Cancelled by wrapper' }),
} = {}) =>
  command(`
  import { createInterface } from 'node:readline';
  ${emit(preflight)}
  const inputs=[];
  for await (const line of createInterface({input:process.stdin})) {
    const input=JSON.parse(line); inputs.push(input);
    if(input.openViewer) { ${onOpenViewer} }
    else if(input.token) { ${onToken} }
    else if(input.verifyWorkspace) { ${onCheckpoint} }
    else if(input.finish) { ${onFinish} break; }
    else if(input.cancel) { ${onCancel} process.exitCode=1; break; }
    else process.exit(2);
  }
`);

function abortable(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('Completion interrupted'));
    else
      signal.addEventListener('abort', () => reject(new Error('Completion interrupted')), {
        once: true,
      });
  });
}

test('scoped publication waits for one native checkpoint before publishing and finishing', async () => {
  const checkpoint = {
    ...started,
    phase: 'publish',
    workspaceScope: { contextId: 'TDEMO', windowId: 42 },
  };
  let published = false;
  const result = await runSaveMedia(
    peer({
      onCheckpoint: emit(checkpoint),
      onFinish: `console.log(JSON.stringify({...${JSON.stringify(final)},inputs}));`,
    }),
    {
      select: selection,
      complete: async (_value, _context, _signal, verifyWorkspace) => {
        expect(published).toBe(false);
        expect(await verifyWorkspace()).toEqual(checkpoint);
        published = true;
        return transfer;
      },
    }
  );
  expect(result.code).toBe(0);
  expect(published).toBe(true);
  expect(result.receipt.inputs).toEqual([
    { token: 'verified-token' },
    { verifyWorkspace: true },
    { finish: true },
  ]);
  expect(result.receipt.publicationPreflight).toEqual(checkpoint);
});

for (const [name, checkpoint] of [
  ['operation', { ...started, phase: 'publish', operation: 'read-media' }],
  ['reference', { ...started, phase: 'publish', requested: 'FOTHER' }],
  ['process', { ...started, phase: 'publish', pid: 456 }],
  [
    'download timing',
    { ...started, phase: 'publish', action: { ...started.action, startedAt: 1 } },
  ],
  [
    'scope refusal',
    { ...started, phase: 'publish', status: 'stopped', error: 'Selected workspace changed' },
  ],
  [
    'stopped result',
    { ...started, phase: 'result', status: 'stopped', error: 'Selected workspace changed' },
  ],
  ['missing acknowledgment', null],
]) {
  test(`publication is withheld after checkpoint ${name}`, async () => {
    let published = false;
    const result = await runSaveMedia(
      peer({
        onCheckpoint: checkpoint ? emit(checkpoint) : 'process.exit(1);',
      }),
      {
        select: selection,
        complete: async (_value, _context, _signal, verifyWorkspace) => {
          await verifyWorkspace();
          published = true;
          return transfer;
        },
        timeoutMs: 2000,
      }
    );
    expect(result.code).toBe(1);
    expect(published).toBe(false);
    expect(result.transfer).toBeNull();
    expect(result.receipt.downloadMayHaveStarted).toBe(true);
  });
}

test('an unsolicited publication checkpoint cannot authorize publishing', async () => {
  let published = false;
  const result = await runSaveMedia(
    peer({ onToken: emit(started) + emit({ ...started, phase: 'publish' }) }),
    {
      select: selection,
      complete: async (_value, _context, signal, verifyWorkspace) => {
        await abortable(signal);
        await verifyWorkspace();
        published = true;
      },
    }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('Unsolicited');
  expect(published).toBe(false);
});

test('a second checkpoint request is refused without replay', async () => {
  let published = false;
  const result = await runSaveMedia(
    peer({ onCheckpoint: emit({ ...started, phase: 'publish' }) }),
    {
      select: selection,
      complete: async (_value, _context, _signal, verifyWorkspace) => {
        await verifyWorkspace();
        await verifyWorkspace();
        published = true;
      },
    }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('already requested');
  expect(published).toBe(false);
});

test('keeps one helper alive through asynchronous selection and publication before finish', async () => {
  const stages = [];
  const result = await runSaveMedia(
    peer({ onFinish: `console.log(JSON.stringify({...${JSON.stringify(final)},inputs}));` }),
    {
      select: async (value) => {
        expect(value).toEqual(preflight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        stages.push('selected');
        return selection();
      },
      complete: async (value, context, signal) => {
        expect(value).toEqual(started);
        expect(context).toEqual({ ref: 'FDEMO' });
        expect(signal.aborted).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 10));
        stages.push('published');
        return transfer;
      },
    }
  );
  expect(result.code).toBe(0);
  expect(stages).toEqual(['selected', 'published']);
  expect(result.receipt.inputs).toEqual([{ token: 'verified-token' }, { finish: true }]);
  expect(result.receipt.preflight).toEqual(preflight);
  expect(result.receipt.started).toEqual(started);
  expect(result.context).toEqual({ ref: 'FDEMO' });
  expect(result.transfer).toEqual(transfer);
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
});

test('failed reference verification sends only cancellation and never starts completion', async () => {
  let calls = 0;
  const result = await runSaveMedia(
    peer({
      onCancel: `console.log(JSON.stringify({phase:'result',status:'stopped',error:'cancelled',inputs}));`,
    }),
    {
      select: () => {
        throw new Error('stale media reference');
      },
      complete: () => {
        calls++;
        throw new Error('must not complete');
      },
    }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.error).toBe('stale media reference');
  expect(result.receipt.inputs).toEqual([{ cancel: true }]);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(calls).toBe(0);
});

test('pretty early permission errors retain native diagnostics without selection', async () => {
  let calls = 0;
  const result = await runSaveMedia(
    command(
      `console.log(JSON.stringify({status:'permission-required',next:'Grant access'},null,2));process.exit(3);`
    ),
    {
      select: () => {
        calls++;
        return selection();
      },
      complete,
    }
  );
  expect(result.code).toBe(3);
  expect(result.receipt.status).toBe('permission-required');
  expect(result.receipt.next).toBe('Grant access');
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(calls).toBe(0);
});

test('AX preflight failures retain their setup remedy without source selection or completion', async () => {
  for (const [status, code, exitCode] of [
    ['api-disabled', -25211, 3],
    ['unavailable', -25204, 1],
  ]) {
    let selected = 0,
      completed = 0;
    const failed = {
      status: 'stopped',
      accessStatus: exitCode === 3 ? 'permission-required' : 'unavailable',
      error: 'AX application read failed',
      next: 'Check host access or app state, then rerun permissions.',
      accessibilityProbe: {
        status,
        checkedAttributes: ['AXRole'],
        error: { code, operation: 'AXRole' },
      },
    };
    const result = await runSaveMedia(command(`${emit(failed)}process.exit(${exitCode});`), {
      select: () => {
        selected++;
        return selection();
      },
      complete: () => {
        completed++;
        return transfer;
      },
    });
    expect(result.code).toBe(exitCode);
    expect(result.receipt.next).toBe(failed.next);
    expect(result.receipt.accessibilityProbe).toEqual(failed.accessibilityProbe);
    expect(result.receipt.downloadMayHaveStarted).toBe(false);
    expect(result.receipt.viewerMayHaveOpened).toBe(false);
    expect([selected, completed]).toEqual([0, 0]);
  }
});

test('native failure after input but before started retains attempted-action evidence', async () => {
  const failed = {
    ...started,
    phase: 'result',
    status: 'stopped',
    error: 'Unexpected modal after input',
    desktop: { samples: [{ stage: 'after-download' }] },
  };
  let calls = 0;
  const result = await runSaveMedia(peer({ onToken: `${emit(failed)}process.exit(1);` }), {
    select: selection,
    complete: () => {
      calls++;
    },
  });
  expect(result.code).toBe(1);
  expect(result.receipt.action.attempted).toBe(true);
  expect(result.receipt.desktop).toEqual(failed.desktop);
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
  expect(result.receipt.error).toContain('Unexpected modal');
  expect(result.receipt.next).toContain('do not replay');
  expect(calls).toBe(0);
});

test('publication failure cancels instead of finishing and retains the started receipt', async () => {
  const result = await runSaveMedia(
    peer({
      onCancel: `console.log(JSON.stringify({phase:'result',status:'stopped',error:'cancelled',inputs}));`,
    }),
    {
      select: selection,
      complete: () => {
        throw new Error('Destination already exists');
      },
    }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.error).toBe('Destination already exists');
  expect(result.receipt.inputs).toEqual([{ token: 'verified-token' }, { cancel: true }]);
  expect(result.receipt.started).toEqual(started);
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
  expect(result.transfer).toBeNull();
});

test('native monitor failure interrupts pending completion and preserves its own failure', async () => {
  const failed = { ...final, status: 'stopped', error: 'Pinned workspace changed' };
  let completionSignal;
  const result = await runSaveMedia(
    peer({ onToken: `${emit(started)}setTimeout(()=>{${emit(failed)}process.exit(1);},40);` }),
    {
      select: selection,
      complete: (_value, _context, signal) => {
        completionSignal = signal;
        return abortable(signal);
      },
    }
  );
  expect(result.code).toBe(1);
  expect(completionSignal.aborted).toBe(true);
  expect(result.receipt.error).toBe('Pinned workspace changed');
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
  expect(result.receipt.started).toEqual(started);
});

test('cancellation interrupts pending selection before any token is sent', async () => {
  const abort = new AbortController();
  const result = await runSaveMedia(peer(), {
    signal: abort.signal,
    select: () => {
      setTimeout(() => abort.abort(), 10);
      return new Promise(() => {});
    },
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.status).toBe('stopped');
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
});

test('cancellation during completion retains context and does not claim an unverified file', async () => {
  const abort = new AbortController();
  const result = await runSaveMedia(peer(), {
    signal: abort.signal,
    select: selection,
    complete: (_value, _context, signal) => {
      setTimeout(() => abort.abort(), 10);
      return abortable(signal);
    },
  });
  expect(result.code).toBe(1);
  expect(result.context).toEqual({ ref: 'FDEMO' });
  expect(result.receipt.started).toEqual(started);
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
  expect(result.transfer).toBeNull();
});

test('timeout bounds pending selection without requesting a download', async () => {
  const start = Date.now();
  const result = await runSaveMedia(peer(), {
    timeoutMs: 80,
    terminationGraceMs: 20,
    select: () => new Promise(() => {}),
    complete,
  });
  expect(result.code).toBe(1);
  expect(Date.now() - start).toBeLessThan(2000);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
});

test('timeout bounds even a completion callback that ignores cancellation', async () => {
  let release,
    reachedCompletion = false,
    completionSignal,
    stream,
    finish,
    peerExited = false;
  const writes = [],
    signals = [];
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  // Exercise the completion drain, not subprocess startup. A busy machine can
  // spend the entire short timeout starting a real peer before it emits started.
  const running = runSaveMedia(['fake-native'], {
    timeoutMs: 120,
    terminationGraceMs: 20,
    select: selection,
    complete: (_value, _context, signal) => {
      reachedCompletion = true;
      completionSignal = signal;
      return pending;
    },
    spawn: () => ({
      stdin: {
        write(value) {
          const input = JSON.parse(value);
          writes.push(input);
          if (input.token) stream.enqueue(new TextEncoder().encode(JSON.stringify(started) + '\n'));
        },
        flush() {},
        end() {},
      },
      stdout: new ReadableStream({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(preflight) + '\n'));
        },
      }),
      exited: new Promise((resolve) => {
        finish = resolve;
      }),
      kill(signal) {
        if (peerExited) return;
        peerExited = true;
        signals.push(signal);
        stream.close();
        finish(143);
      },
    }),
  });
  let timer;
  const sentinel = Symbol('deadline');
  const first = await Promise.race([
    running,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(sentinel), 1900);
    }),
  ]);
  clearTimeout(timer);
  release(transfer);
  const result = await running;
  expect(reachedCompletion).toBe(true);
  expect(completionSignal.aborted).toBe(true);
  expect(first).not.toBe(sentinel);
  expect(result.code).toBe(1);
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
  expect(result.receipt.started).toEqual(started);
  expect(result.transfer).toBeNull();
  expect(writes).toEqual([{ token: 'verified-token' }]);
  expect(signals).toEqual(['SIGTERM']);
});

test('an already cancelled request spawns no native process', async () => {
  const abort = new AbortController();
  abort.abort();
  let spawned = false;
  await expect(
    runSaveMedia(['must-not-spawn'], {
      signal: abort.signal,
      select: selection,
      complete,
      spawn: () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    })
  ).rejects.toThrow('before native work');
  expect(spawned).toBe(false);
});

test.each([
  ['result before preflight', command(emit(final)), 'before verified completion'],
  ['started before selection', command(emit(started)), 'without one verified selection'],
  [
    'repeated preflight',
    command(`${emit(preflight)}${emit(preflight)}await Bun.stdin.text();`),
    'Repeated',
  ],
  [
    'repeated started',
    peer({ onToken: `${emit(started)}${emit(started)}` }),
    'without one verified selection',
  ],
  ['unexpected phase', command(emit({ phase: 'unexpected', status: 'ok' })), 'phase'],
])('rejects %s', async (_name, native, message) => {
  const result = await runSaveMedia(native, { select: selection, complete, timeoutMs: 1000 });
  expect(result.code).toBe(1);
  expect(result.receipt.error.toLowerCase()).toContain(message.toLowerCase());
});

test('a missing result never converts a completed publication into protocol success', async () => {
  const result = await runSaveMedia(peer({ onFinish: 'process.exit(0);' }), {
    select: selection,
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('result is missing');
  expect(result.transfer).toEqual(transfer);
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
});

test('a native final failure retains an already published artifact for recovery', async () => {
  const failed = { ...final, status: 'stopped', error: 'Desktop changed after publication' };
  const result = await runSaveMedia(peer({ onFinish: `${emit(failed)}process.exitCode=1;` }), {
    select: selection,
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.status).toBe('stopped');
  expect(result.receipt.error).toBe(failed.error);
  expect(result.transfer).toEqual(transfer);
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
});

test('uncertain token delivery preserves attempted-input state without sending cancellation', async () => {
  const writes = [];
  let stream, finish;
  const result = await runSaveMedia(['fake-native'], {
    select: selection,
    complete,
    spawn: () => ({
      stdin: {
        write: (value) => writes.push(JSON.parse(value)),
        flush() {
          stream.close();
          finish(1);
          throw new Error('Token delivery uncertain');
        },
        end() {},
      },
      stdout: new ReadableStream({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(preflight) + '\n'));
        },
      }),
      exited: new Promise((resolve) => {
        finish = resolve;
      }),
      kill() {},
    }),
  });
  expect(writes).toEqual([{ token: 'verified-token' }]);
  expect(result.code).toBe(1);
  expect(result.receipt.error).toBe('Token delivery uncertain');
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
  expect(result.receipt.next).toContain('do not replay');
});

test('uncertain finish delivery retains the publication and a later native result as diagnostics', async () => {
  const writes = [];
  let stream,
    finish,
    uncertain = false;
  const result = await runSaveMedia(['fake-native'], {
    select: selection,
    complete,
    spawn: () => ({
      stdin: {
        write(value) {
          const input = JSON.parse(value);
          writes.push(input);
          if (input.token) stream.enqueue(new TextEncoder().encode(JSON.stringify(started) + '\n'));
          if (input.finish) {
            uncertain = true;
            stream.enqueue(new TextEncoder().encode(JSON.stringify(final) + '\n'));
          }
        },
        flush() {
          if (uncertain) {
            uncertain = false;
            stream.close();
            finish(0);
            throw new Error('Finish delivery uncertain');
          }
        },
        end() {},
      },
      stdout: new ReadableStream({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(preflight) + '\n'));
        },
      }),
      exited: new Promise((resolve) => {
        finish = resolve;
      }),
      kill() {},
    }),
  });
  expect(result.code).toBe(1);
  expect(result.receipt.error).toBe('Finish delivery uncertain');
  expect(result.transfer).toEqual(transfer);
  expect(result.receipt.nativeResult).toEqual(final);
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
  expect(writes.filter((value) => value.token)).toHaveLength(1);
  expect(writes.filter((value) => value.finish)).toHaveLength(1);
});

test('an uncooperative native helper receives SIGKILL before the protocol returns', async () => {
  const signals = [];
  let stream, finish;
  const result = await runSaveMedia(['fake-native'], {
    select: selection,
    complete,
    timeoutMs: 20,
    terminationGraceMs: 20,
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
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
});

const viewerPreflight = {
  ...preflight,
  phase: 'viewer-select',
  viewerAction: { attempted: true, accepted: true, token: 'verified-open-token' },
  viewer: { fileId: 'FDEMO' },
};
const openSelection = () => ({ openViewer: 'verified-open-token', context: { ref: 'FDEMO' } });
const viewerSelection = (_value, context) => ({
  token: 'viewer-download-token',
  context: { ...context, viewerVerified: true },
});
const viewerPeer = (options = {}) => peer({ onOpenViewer: emit(viewerPreflight), ...options });
const cancelWithInputs = `console.log(JSON.stringify({phase:'result',status:'stopped',error:'cancelled',inputs}));`;

test('one verified viewer opening precedes a separately authorized download and publication', async () => {
  const stages = [];
  const result = await runSaveMedia(
    viewerPeer({
      onFinish: `console.log(JSON.stringify({...${JSON.stringify(final)},inputs}));`,
    }),
    {
      select: (value) => {
        expect(value).toEqual(preflight);
        stages.push('source');
        return openSelection();
      },
      selectViewer: async (value, context, signal) => {
        expect(value).toEqual(viewerPreflight);
        expect(context).toEqual({ ref: 'FDEMO' });
        expect(signal.aborted).toBe(false);
        await Bun.sleep(10);
        stages.push('viewer');
        return viewerSelection(value, context);
      },
      complete: async (value, context) => {
        expect(value).toEqual(started);
        expect(context).toEqual({ ref: 'FDEMO', viewerVerified: true });
        stages.push('publication');
        return transfer;
      },
    }
  );
  expect(result.code).toBe(0);
  expect(stages).toEqual(['source', 'viewer', 'publication']);
  expect(result.receipt.inputs).toEqual([
    { openViewer: 'verified-open-token' },
    { token: 'viewer-download-token' },
    { finish: true },
  ]);
  expect(result.receipt.preflight).toEqual(preflight);
  expect(result.receipt.viewerPreflight).toEqual(viewerPreflight);
  expect(result.receipt.started).toEqual(started);
  expect(result.receipt.viewerMayHaveOpened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
  expect(result.transfer).toEqual(transfer);
});

test('missing viewer verification callback refuses opening before input', async () => {
  const result = await runSaveMedia(peer({ onCancel: cancelWithInputs }), {
    select: openSelection,
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.inputs).toEqual([{ cancel: true }]);
  expect(result.receipt.error).toContain('requires a verified viewer-selection callback');
  expect(result.receipt.viewerMayHaveOpened).toBe(false);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
});

test.each([
  ['mixed action tokens', { ...selection(), openViewer: 'open-token' }],
  ['extra instruction', { ...openSelection(), retry: true }],
  ['missing context', { token: 'download-token' }],
  ['null context', { token: 'download-token', context: null }],
  ['array context', { token: 'download-token', context: [] }],
  ['empty token', { token: '', context: {} }],
  ['whitespace token', { openViewer: 'open token', context: {} }],
  ['overlong token', { token: 'x'.repeat(201), context: {} }],
  ['array selection', []],
  ['null selection', null],
])('rejects %s without any action token', async (_name, selected) => {
  let viewerCalls = 0;
  const result = await runSaveMedia(peer({ onCancel: cancelWithInputs }), {
    select: () => selected,
    selectViewer: () => {
      viewerCalls++;
      return selection();
    },
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.inputs).toEqual([{ cancel: true }]);
  expect(result.receipt.error).toContain('exactly one verified action and context');
  expect(result.receipt.viewerMayHaveOpened).toBe(false);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(viewerCalls).toBe(0);
});

test('viewer source rejection cancels without requesting Download and preserves discovery evidence', async () => {
  let completionCalls = 0;
  const result = await runSaveMedia(viewerPeer({ onCancel: cancelWithInputs }), {
    select: openSelection,
    selectViewer: () => {
      throw new Error('Viewer file identity differs from source');
    },
    complete: () => {
      completionCalls++;
      return transfer;
    },
  });
  expect(result.code).toBe(1);
  expect(result.receipt.inputs).toEqual([{ openViewer: 'verified-open-token' }, { cancel: true }]);
  expect(result.receipt.error).toContain('Viewer file identity differs');
  expect(result.receipt.nativeResult.error).toBe('cancelled');
  expect(result.receipt.viewerPreflight).toEqual(viewerPreflight);
  expect(result.context).toEqual({ ref: 'FDEMO' });
  expect(result.receipt.viewerMayHaveOpened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(result.receipt.next).toContain('file viewer may be open');
  expect(completionCalls).toBe(0);
});

test('viewer callback cannot request another opener or mix opener and Download tokens', async () => {
  for (const selected of [openSelection(), { ...selection(), openViewer: 'second-open-token' }]) {
    const result = await runSaveMedia(viewerPeer({ onCancel: cancelWithInputs }), {
      select: openSelection,
      selectViewer: () => selected,
      complete,
    });
    expect(result.code).toBe(1);
    expect(result.receipt.inputs).toEqual([
      { openViewer: 'verified-open-token' },
      { cancel: true },
    ]);
    expect(result.receipt.viewerMayHaveOpened).toBe(true);
    expect(result.receipt.downloadMayHaveStarted).toBe(false);
  }
});

test.each([
  ['viewer phase before source selection', command(emit(viewerPreflight))],
  ['viewer phase after direct Download token', peer({ onToken: emit(viewerPreflight) })],
])('rejects %s without invoking viewer verification', async (_name, native) => {
  let calls = 0;
  const result = await runSaveMedia(native, {
    select: selection,
    selectViewer: () => {
      calls++;
      return selection();
    },
    complete,
    timeoutMs: 1000,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('out-of-order viewer');
  expect(result.receipt.rejectedViewerPreflight).toEqual(viewerPreflight);
  expect(result.receipt.viewerMayHaveOpened).toBe(true);
  expect(calls).toBe(0);
});

test('a repeated viewer phase never authorizes a second viewer or Download action', async () => {
  let calls = 0;
  const result = await runSaveMedia(
    viewerPeer({ onOpenViewer: emit(viewerPreflight) + emit(viewerPreflight) }),
    {
      select: openSelection,
      selectViewer: (value, context) => {
        calls++;
        return viewerSelection(value, context);
      },
      complete,
    }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('Repeated or out-of-order viewer');
  expect(result.receipt.viewerPreflight).toEqual(viewerPreflight);
  expect(result.receipt.rejectedViewerPreflight).toEqual(viewerPreflight);
  expect(calls).toBe(1);
});

test('an opener token alone never authorizes Download completion', async () => {
  let calls = 0;
  const result = await runSaveMedia(viewerPeer({ onOpenViewer: emit(started) }), {
    select: openSelection,
    selectViewer: viewerSelection,
    complete: () => {
      calls++;
      return transfer;
    },
  });
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('without one verified selection');
  expect(result.receipt.viewerMayHaveOpened).toBe(true);
  // The unverified native receipt still claims attempted Download input.
  expect(result.receipt.downloadMayHaveStarted).toBe(true);
  expect(calls).toBe(0);
});

test('native opener failure preserves its action evidence without implying Download', async () => {
  const failed = {
    operation: 'save-media',
    phase: 'result',
    status: 'stopped',
    error: 'Viewer opener action may have been delivered',
    viewerAction: { attempted: true, accepted: false },
    action: { attempted: false, accepted: false },
  };
  let calls = 0;
  const result = await runSaveMedia(
    viewerPeer({ onOpenViewer: emit(failed) + 'process.exit(1);' }),
    {
      select: openSelection,
      selectViewer: () => {
        calls++;
        return selection();
      },
      complete,
    }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.nativeResult).toEqual(failed);
  expect(result.receipt.viewerMayHaveOpened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(result.context).toEqual({ ref: 'FDEMO' });
  expect(calls).toBe(0);
});

test.each(
  ['image', 'file', 'audio', 'video'].flatMap((kind) =>
    ['closed', 'withheld', 'unverified'].map((status) => [kind, status])
  )
)(
  'native %s viewer rejection with %s cleanup never requests Download or replays its opener',
  async (kind, status) => {
    const details = kind !== 'image';
    const failed = {
      operation: 'save-media',
      phase: 'result',
      status: 'stopped',
      error: details
        ? 'File details has no unique source-matched Download control'
        : 'Opened viewer image does not match the retained source URL',
      viewerAction: {
        attempted: true,
        accepted: true,
        opened: true,
        closed: status === 'closed',
        closeAttempted: status !== 'withheld',
      },
      action: { attempted: false, accepted: false },
      viewerFailure: {
        phase: 'viewer-capture',
        reason: details ? 'source-matched-download-unavailable' : 'source-url-mismatch',
        capturedAt: '2026-11-15T14:42:25Z',
        captureComplete: false,
        sourceVerifiedAtCaptureStart: true,
        windowVerifiedAtCaptureStart: true,
        ...(details
          ? {
              family: 'file-details',
              mediaKind: kind,
              cardCount: 1,
              cards: [{ index: 4, parent: 3, role: 'AXGroup', fileMatchesSource: true }],
              downloadControlCount: 0,
              downloadControls: [],
            }
          : {
              activeImageCount: 1,
              images: [{ index: 4, parent: 3, role: 'AXImage', urlMatchesSource: false }],
            }),
      },
      viewerCleanup: {
        status,
        closeAttempted: status !== 'withheld',
        closed: status === 'closed',
      },
    };
    let viewerCalls = 0,
      completionCalls = 0;
    const result = await runSaveMedia(
      viewerPeer({
        onOpenViewer: `console.log(JSON.stringify({...${JSON.stringify(failed)},inputs})); process.exit(1);`,
      }),
      {
        select: openSelection,
        selectViewer: () => {
          viewerCalls++;
          return selection();
        },
        complete: () => {
          completionCalls++;
          return transfer;
        },
      }
    );
    expect(result.code).toBe(1);
    expect(result.receipt.inputs).toEqual([{ openViewer: 'verified-open-token' }]);
    expect(result.receipt.error).toBe(failed.error);
    expect(result.receipt.viewerFailure).toEqual(failed.viewerFailure);
    expect(result.receipt.viewerCleanup).toEqual(failed.viewerCleanup);
    expect(result.receipt.viewerMayHaveOpened).toBe(true);
    expect(result.receipt.downloadMayHaveStarted).toBe(false);
    expect(viewerCalls).toBe(0);
    expect(completionCalls).toBe(0);
    expect(result.transfer).toBeNull();
    const compact = failedSaveMediaOutput({
      requested: 'FDEMO',
      error: result.receipt.error,
      receipt: result.receipt,
      context: result.context,
    });
    expect(compact.status).toBe('stopped');
    expect(compact).not.toHaveProperty('saved');
    expect(JSON.parse(formatOutput(compact, 'json')).viewer.cleanup).toEqual(failed.viewerCleanup);
    const full = JSON.parse(formatOutput(compact, 'full-json', result.receipt));
    expect(full.viewerFailure).toEqual(failed.viewerFailure);
    expect(full.nativeResult.viewerCleanup).toEqual(failed.viewerCleanup);
    expect(formatOutput(compact)).toContain(`Viewer check: ${failed.viewerFailure.reason}`);
    expect(formatOutput(compact)).toContain(
      details ? '1 observed file card' : '1 observed active image'
    );
    expect(formatOutput(compact)).not.toContain('may have started a download');
  }
);

test('wrapper viewer rejection keeps later native cleanup without replacing the original error', async () => {
  const cleanup = { status: 'closed', closeAttempted: true, closed: true };
  const result = await runSaveMedia(
    viewerPeer({
      onCancel: emit({
        operation: 'save-media',
        phase: 'result',
        status: 'stopped',
        error: 'Cancelled by wrapper',
        viewerAction: { attempted: true, opened: true, closed: true, closeAttempted: true },
        viewerCleanup: cleanup,
      }),
    }),
    {
      select: openSelection,
      selectViewer: () => {
        throw new Error('Viewer source changed during selection');
      },
      complete: () => {
        throw new Error('Download completion must not run');
      },
    }
  );
  expect(result.code).toBe(1);
  expect(result.receipt.error).toBe('Viewer source changed during selection');
  expect(result.receipt.viewerCleanup).toEqual(cleanup);
  expect(result.receipt.nativeResult.error).toBe('Cancelled by wrapper');
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(result.transfer).toBeNull();
});

test('native attempted-viewer evidence survives an early failure without authorizing follow-up', async () => {
  const failed = {
    operation: 'save-media',
    phase: 'result',
    status: 'stopped',
    error: 'Unexpected native action',
    viewerAction: { attempted: true },
  };
  let calls = 0;
  const result = await runSaveMedia(command(emit(failed)), {
    select: () => {
      calls++;
      return selection();
    },
    selectViewer: viewerSelection,
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.viewerMayHaveOpened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(result.receipt.nativeResult).toEqual(failed);
  expect(calls).toBe(0);
});

test('cancellation while viewer verification waits retains source context and sends no Download', async () => {
  const abort = new AbortController();
  const result = await runSaveMedia(viewerPeer(), {
    signal: abort.signal,
    select: openSelection,
    selectViewer: (_value, _context, signal) => {
      setTimeout(() => abort.abort(), 10);
      return abortable(signal);
    },
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.viewerMayHaveOpened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(result.receipt.preflight).toEqual(preflight);
  expect(result.receipt.viewerPreflight).toEqual(viewerPreflight);
  expect(result.context).toEqual({ ref: 'FDEMO' });
});

test('timeout between opening and viewer preflight retains opening uncertainty only', async () => {
  const result = await runSaveMedia(viewerPeer({ onOpenViewer: '' }), {
    select: openSelection,
    selectViewer: viewerSelection,
    complete,
    timeoutMs: 100,
    terminationGraceMs: 20,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.viewerMayHaveOpened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(result.receipt).not.toHaveProperty('viewerPreflight');
  expect(result.context).toEqual({ ref: 'FDEMO' });
});

for (const failAt of ['openViewer', 'token']) {
  test(`uncertain ${failAt} delivery preserves only reached action states and never replays`, async () => {
    const writes = [];
    let stream,
      finish,
      uncertain = false;
    const result = await runSaveMedia(['fake-native'], {
      select: openSelection,
      selectViewer: viewerSelection,
      complete,
      spawn: () => ({
        stdin: {
          write(value) {
            const input = JSON.parse(value);
            writes.push(input);
            if (input.openViewer && failAt !== 'openViewer')
              stream.enqueue(new TextEncoder().encode(JSON.stringify(viewerPreflight) + '\n'));
            uncertain = Object.hasOwn(input, failAt);
          },
          flush() {
            if (uncertain) {
              stream.close();
              finish(1);
              throw new Error('Action token delivery uncertain');
            }
          },
          end() {},
        },
        stdout: new ReadableStream({
          start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode(JSON.stringify(preflight) + '\n'));
          },
        }),
        exited: new Promise((resolve) => {
          finish = resolve;
        }),
        kill() {},
      }),
    });
    expect(result.code).toBe(1);
    expect(result.receipt.error).toBe('Action token delivery uncertain');
    expect(writes).toEqual(
      failAt === 'openViewer'
        ? [{ openViewer: 'verified-open-token' }]
        : [{ openViewer: 'verified-open-token' }, { token: 'viewer-download-token' }]
    );
    expect(result.receipt.viewerMayHaveOpened).toBe(true);
    expect(result.receipt.downloadMayHaveStarted).toBe(failAt === 'token');
    expect(result.receipt.preflight).toEqual(preflight);
    if (failAt === 'token') expect(result.receipt.viewerPreflight).toEqual(viewerPreflight);
    expect(result.receipt.next).toMatch(/not.*replay/);
  });
}

const sourcePlan = { workspace: 'EDEMO', messageRef: 'CDEMO:1700000000.000001' };
const sourcePreflight = {
  ...preflight,
  phase: 'source-select',
  sourceRequest: sourcePlan,
  sourceAction: { attempted: true, accepted: true, opened: true },
};
const reopenSelection = () => ({ reopenSource: sourcePlan, context: { ref: 'FDEMO' } });
const sourcePeer = ({
  initial = preflight,
  onReopenSource = emit(sourcePreflight),
  onOpenViewer = emit(viewerPreflight),
  onToken = emit(started),
  onFinish = `console.log(JSON.stringify({...${JSON.stringify(final)},inputs}));`,
  onCancel = `console.log(JSON.stringify({phase:'result',status:'stopped',error:'cancelled',inputs}));process.exitCode=1;break;`,
} = {}) =>
  command(`
  import { createInterface } from 'node:readline';
  ${emit(initial)}
  const inputs=[];
  for await (const line of createInterface({input:process.stdin})) {
    const input=JSON.parse(line); inputs.push(input);
    if(input.reopenSource) { ${onReopenSource} }
    else if(input.openViewer) { ${onOpenViewer} }
    else if(input.token) { ${onToken} }
    else if(input.finish) { ${onFinish} break; }
    else if(input.cancel) { ${onCancel} }
    else process.exit(2);
  }
`);

test.each([false, true])(
  'one source reopening can precede a verified save (viewer=%s)',
  async (viewer) => {
    const stages = [];
    const result = await runSaveMedia(sourcePeer(), {
      select: reopenSelection,
      selectSource: (value, context, signal) => {
        expect(value).toEqual(sourcePreflight);
        expect(context).toEqual({ ref: 'FDEMO' });
        expect(signal.aborted).toBe(false);
        stages.push('source');
        return {
          ...(viewer ? { openViewer: 'verified-open-token' } : { token: 'verified-token' }),
          context: { ...context, fresh: true },
        };
      },
      selectViewer: (_value, context) => {
        expect(context.fresh).toBe(true);
        stages.push('viewer');
        return { token: 'viewer-download-token', context };
      },
      complete: (_value, context) => {
        expect(context.fresh).toBe(true);
        stages.push('complete');
        return transfer;
      },
    });
    expect(result.code).toBe(0);
    expect(stages).toEqual(viewer ? ['source', 'viewer', 'complete'] : ['source', 'complete']);
    expect(result.receipt.inputs).toEqual([
      { reopenSource: sourcePlan },
      ...(viewer
        ? [{ openViewer: 'verified-open-token' }, { token: 'viewer-download-token' }]
        : [{ token: 'verified-token' }]),
      { finish: true },
    ]);
    expect(result.receipt.preflight).toEqual(preflight);
    expect(result.receipt.sourcePreflight).toEqual(sourcePreflight);
    expect(result.receipt.sourceRequest).toEqual(sourcePlan);
    expect(result.receipt.sourceMayHaveReopened).toBe(true);
    expect(result.receipt.downloadMayHaveStarted).toBe(true);
  }
);

test('foreground source reopening and viewer save retain a published file after final ownership loss', async () => {
  const interaction = {
    mode: 'foreground',
    state: 'activated',
    activationRequested: true,
    activated: true,
    ownershipLost: false,
    focusRestoration: 'none',
    pid: preflight.pid,
  };
  const reopened = { ...sourcePreflight, interaction };
  const opened = {
    ...viewerPreflight,
    interaction,
    viewerAction: { attempted: true, accepted: true, opened: true, closed: false },
  };
  const failed = {
    ...final,
    status: 'stopped',
    error: 'Synthetic foreground ownership loss after publication',
    interaction: { ...interaction, ownershipLost: true },
    sourceRequest: sourcePlan,
    sourceAction: reopened.sourceAction,
    viewerAction: { ...opened.viewerAction, closed: true },
  };
  const stages = [];
  // The publication receipt is synthetic: this protocol test creates no artifact.
  const artifact = {
    path: '/tmp/synthetic-saved-file',
    published: true,
    verified: true,
    bytes: 10,
    sha256: 'a'.repeat(64),
  };
  const result = await runSaveMedia(
    sourcePeer({
      initial: { ...preflight, interaction },
      onReopenSource: emit(reopened),
      onOpenViewer: emit(opened),
      onToken: emit({ ...started, interaction }),
      onFinish: `console.log(JSON.stringify({...${JSON.stringify(failed)},inputs}));process.exitCode=1;`,
    }),
    {
      select: reopenSelection,
      selectSource: (value, context) => {
        expect(value).toEqual(reopened);
        stages.push('source');
        return { openViewer: 'verified-open-token', context };
      },
      selectViewer: (value, context) => {
        expect(value).toEqual(opened);
        stages.push('viewer');
        context.selected = {
          scope: 'viewer',
          url: null,
          routeKind: 'unknown',
          sourceURL: 'https://files.slack.com/files-pri/TDEMO-FDEMO/example.png',
          fileId: 'FDEMO',
          ownerTeamId: 'TDEMO',
          contextId: 'EDEMO',
          route: { teamId: 'TDEMO', fileId: 'FDEMO' },
          correlation: 'viewer-file-identity',
          fileDownloadEvidence: null,
        };
        return { token: 'viewer-download-token', context };
      },
      complete: (_value, context, signal) => {
        expect(signal.aborted).toBe(false);
        stages.push('published');
        context.publication = { artifact };
        return { publication: context.publication };
      },
    }
  );
  expect(result.code).toBe(1);
  expect(stages).toEqual(['source', 'viewer', 'published']);
  expect(result.receipt.inputs).toEqual([
    { reopenSource: sourcePlan },
    { openViewer: 'verified-open-token' },
    { token: 'viewer-download-token' },
    { finish: true },
  ]);
  const receipt = { ...result.receipt, interaction: foregroundEvidence(result.receipt) };
  const compact = failedSaveMediaOutput({
    requested: 'FDEMO',
    error: receipt.error,
    receipt,
    context: result.context,
  });
  expect(compact).toMatchObject({
    status: 'stopped',
    sourceMayHaveReopened: true,
    source: { opened: true, messageRef: sourcePlan.messageRef },
    viewerMayHaveOpened: true,
    viewer: { opened: true, closed: true },
    downloadMayHaveStarted: true,
    saved: {
      ...artifact,
      representation: 'observed-viewer-download',
      originalSelection: { status: 'unavailable', basis: 'viewer-download-route-unexposed' },
      originalFile: null,
    },
  });
  const json = JSON.parse(formatOutput(compact, 'json', receipt));
  expect(json.saved).toEqual(compact.saved);
  expect(json.source).toEqual(compact.source);
  expect(json.viewer).toEqual(compact.viewer);
  expect(json.interaction).toEqual({ ...interaction, pid: undefined, ownershipLost: true });
  expect(json.interaction).not.toHaveProperty('pid');
  const output = formatOutput(compact, 'text', receipt);
  expect(output).toContain(`Saved: ${artifact.path}`);
  expect(output).toContain(`Stopped: ${failed.error}`);
  expect(output).toContain('Original route was not exposed; viewer Download target selected.');
  expect(output).toContain('Do not replay it automatically.');
  expect(output).not.toContain('The file viewer may be open.');
  expect(output.match(/Foreground interaction requested/g)).toHaveLength(1);
  expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
});

test('source reopening requires a verification callback before input', async () => {
  const result = await runSaveMedia(sourcePeer(), { select: reopenSelection, complete });
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('verified source-selection callback');
  expect(result.receipt.inputs).toEqual([{ cancel: true }]);
  expect(result.receipt).not.toHaveProperty('sourceMayHaveReopened');
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
});

for (const plan of [
  null,
  [],
  {},
  { ...sourcePlan, query: 'arbitrary query' },
  { ...sourcePlan, workspace: 'EDEMO\n' },
  { ...sourcePlan, workspace: 'FDEMO' },
  { ...sourcePlan, workspace: 'E' + 'A'.repeat(64) },
  { ...sourcePlan, messageRef: 'CDEMO:1700000000.000001\n' },
  { ...sourcePlan, messageRef: 'CDEMO:1700000000.000001/m1' },
  { ...sourcePlan, messageRef: 'https://example.slack.com/archives/CDEMO/p1700000000000001' },
  { ...sourcePlan, messageRef: 'FDEMO:1700000000.000001' },
  { ...sourcePlan, messageRef: 'C' + 'A'.repeat(64) + ':1700000000.000001' },
]) {
  test(`malformed source plan stops before input: ${JSON.stringify(plan)}`, async () => {
    const result = await runSaveMedia(sourcePeer(), {
      select: () => ({ reopenSource: plan, context: {} }),
      selectSource: selection,
      complete,
    });
    expect(result.code).toBe(1);
    expect(result.receipt.inputs).toEqual([{ cancel: true }]);
    expect(result.receipt).not.toHaveProperty('sourceMayHaveReopened');
    expect(result.receipt.downloadMayHaveStarted).toBe(false);
  });
}

test.each([{ operation: 'read-media' }, { requested: 'FOTHER' }, { pid: 456 }])(
  'source preflight must retain the original native request identity: %j',
  async (changed) => {
    let calls = 0;
    const value = { ...sourcePreflight, ...changed };
    const result = await runSaveMedia(sourcePeer({ onReopenSource: emit(value) }), {
      select: reopenSelection,
      selectSource: () => {
        calls++;
        return selection();
      },
      complete,
    });
    expect(result.code).toBe(1);
    expect(result.receipt.rejectedSourcePreflight).toEqual(value);
    expect(result.receipt.sourceMayHaveReopened).toBe(true);
    expect(result.receipt.downloadMayHaveStarted).toBe(false);
    expect(calls).toBe(0);
  }
);

test('a rejected reopened source sends cancellation without a Download or second navigation', async () => {
  const result = await runSaveMedia(sourcePeer(), {
    select: reopenSelection,
    selectSource: () => {
      throw new Error('Source digest changed');
    },
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.error).toBe('Source digest changed');
  expect(result.receipt.inputs).toEqual([{ reopenSource: sourcePlan }, { cancel: true }]);
  expect(result.receipt.sourceMayHaveReopened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(result.receipt.next).toMatch(/not.*replay/);
});

test('a reopened source cannot request another reopening', async () => {
  const result = await runSaveMedia(sourcePeer(), {
    select: reopenSelection,
    selectSource: reopenSelection,
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.inputs).toEqual([{ reopenSource: sourcePlan }, { cancel: true }]);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
});

test.each([
  ['before initial preflight', command(emit(sourcePreflight))],
  ['after direct Download request', sourcePeer({ onToken: emit(sourcePreflight) })],
  ['after viewer request', sourcePeer({ onOpenViewer: emit(sourcePreflight) })],
  [
    'repeated after reopening',
    sourcePeer({ onReopenSource: emit(sourcePreflight) + emit(sourcePreflight) }),
  ],
])('rejects source preflight %s', async (name, native) => {
  const result = await runSaveMedia(native, {
    select: name.includes('viewer')
      ? openSelection
      : name.includes('repeated')
        ? reopenSelection
        : selection,
    selectSource: selection,
    selectViewer: viewerSelection,
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.error).toContain('out-of-order source');
  expect(result.receipt.rejectedSourcePreflight).toEqual(sourcePreflight);
});

test('uncertain source request delivery is not cancelled or replayed and cannot authorize a Download', async () => {
  const writes = [];
  let stream, finish;
  const result = await runSaveMedia(['fake-native'], {
    select: reopenSelection,
    selectSource: selection,
    complete,
    spawn: () => ({
      stdin: {
        write(value) {
          writes.push(JSON.parse(value));
        },
        flush() {
          stream.close();
          finish(1);
          throw new Error('Source delivery uncertain');
        },
        end() {},
      },
      stdout: new ReadableStream({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(preflight) + '\n'));
        },
      }),
      exited: new Promise((resolve) => {
        finish = resolve;
      }),
      kill() {},
    }),
  });
  expect(result.code).toBe(1);
  expect(writes).toEqual([{ reopenSource: sourcePlan }]);
  expect(result.receipt.sourceRequest).toEqual(sourcePlan);
  expect(result.receipt.sourceMayHaveReopened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(result.receipt.next).toMatch(/not.*replay/);
});

test('cancellation while verifying a reopened source sends no Download', async () => {
  const abort = new AbortController();
  const result = await runSaveMedia(sourcePeer(), {
    signal: abort.signal,
    select: reopenSelection,
    selectSource: (_value, _context, signal) => {
      setTimeout(() => abort.abort(), 10);
      return abortable(signal);
    },
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.sourcePreflight).toEqual(sourcePreflight);
  expect(result.receipt.sourceMayHaveReopened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
});

test('native source-attempt evidence is retained without authorizing another action', async () => {
  const failed = {
    operation: 'save-media',
    phase: 'result',
    status: 'stopped',
    error: 'Source navigation stopped',
    sourceAction: { attempted: true, accepted: false, opened: false },
  };
  let calls = 0;
  const result = await runSaveMedia(command(emit(failed)), {
    select: () => {
      calls++;
      return selection();
    },
    selectSource: selection,
    complete,
  });
  expect(result.code).toBe(1);
  expect(result.receipt.sourceMayHaveReopened).toBe(true);
  expect(result.receipt.downloadMayHaveStarted).toBe(false);
  expect(result.receipt.nativeResult).toEqual(failed);
  expect(calls).toBe(0);
});

for (const evidence of [
  { sourceAction: { attempted: true } },
  { viewerAction: { attempted: true } },
  { action: { attempted: true } },
]) {
  test(`source reopening cannot follow unsolicited attempted-action evidence ${JSON.stringify(evidence)}`, async () => {
    const native = command(`
      import {createInterface} from 'node:readline';
      ${emit({ ...preflight, ...evidence })}
      const inputs=[];
      for await(const line of createInterface({input:process.stdin})) {
        inputs.push(JSON.parse(line));
        console.log(JSON.stringify({phase:'result',status:'stopped',error:'cancelled',inputs}));
        process.exitCode=1;break;
      }
    `);
    const result = await runSaveMedia(native, {
      select: reopenSelection,
      selectSource: selection,
      complete,
    });
    expect(result.code).toBe(1);
    expect(result.receipt.error).toContain('cannot follow an attempted or uncertain action');
    expect(result.receipt.inputs).toEqual([{ cancel: true }]);
    expect(result.receipt).not.toHaveProperty('sourceRequest');
  });
}

test.each([{ viewerAction: { attempted: true } }, { action: { attempted: true } }])(
  'source verification stops on unexpected later-action evidence %j',
  async (evidence) => {
    let calls = 0;
    const result = await runSaveMedia(
      sourcePeer({ onReopenSource: emit({ ...sourcePreflight, ...evidence }) }),
      {
        select: reopenSelection,
        selectSource: () => {
          calls++;
          return selection();
        },
        complete,
      }
    );
    expect(result.code).toBe(1);
    expect(result.receipt.error).toContain('out-of-order source');
    expect(calls).toBe(0);
  }
);
