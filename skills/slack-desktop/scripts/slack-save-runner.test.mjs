import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  prepareDestination,
  publishDownload,
  failedSaveMediaOutput,
  createSaveWorkspaceVerifier,
  sourceSaveState,
  verifySourceReopening,
} from './slack-save-runner.mjs';
import { formatOutput } from './slack-format.mjs';

const folders = [];

const saveWorkspaceTarget = 'workspace:target.slack.com';
const saveWorkspaceURL = 'https://app.slack.com/client/TTARGET/channel/CCONTEXT';
const saveWorkspacePhases = [
  'select',
  'source-select',
  'viewer-select',
  'started',
  'publish',
  'result',
];
function saveWorkspaceReceipt(phase = 'select') {
  const rows = [
    { name: 'Source', domain: 'source.enterprise.slack.com', current: true },
    { name: 'Target', domain: 'target.slack.com', current: false },
  ];
  return {
    operation: 'save-media',
    pid: 123,
    requested: 'FFILE',
    phase,
    ...(phase === 'result' ? { status: 'ok' } : {}),
    requestedWorkspace: saveWorkspaceTarget,
    workspaceSelection: {
      operation: 'switch-workspace',
      pid: 123,
      status: 'ok',
      requested: saveWorkspaceTarget,
      before: {
        url: 'https://app.slack.com/client/ESOURCE/search',
        name: 'Source',
        windowId: 42,
        entries: structuredClone(rows),
      },
      after: {
        url: saveWorkspaceURL,
        name: 'Target',
        windowId: 42,
        entries: rows.map((row) => ({ ...row, current: !row.current })),
      },
      selection: { name: 'Target', domain: 'target.slack.com' },
      switchAttempted: true,
      workspaceSwitchMayHaveBeenRequested: true,
      selector: { opened: true, reused: false, verificationOpened: true, closed: true },
    },
    workspaceSwitchMayHaveBeenRequested: true,
    workspaceScope: { contextId: 'TTARGET', windowId: 42 },
  };
}

describe('save workspace phase verification', () => {
  test('one stable selection authorizes each freshly pinned save phase', () => {
    const verify = createSaveWorkspaceVerifier(saveWorkspaceTarget);
    for (const phase of saveWorkspacePhases) {
      const value = saveWorkspaceReceipt(phase);
      const unchanged = structuredClone(value);
      expect(() => verify(value)).not.toThrow();
      expect(value).toEqual(unchanged);
    }
  });
  test('unscoped saves leave ordinary and failed receipts untouched', () => {
    const verify = createSaveWorkspaceVerifier();
    for (const value of [
      undefined,
      null,
      {},
      { status: 'stopped', workspaceScopeError: 'drift' },
    ]) {
      const unchanged = structuredClone(value);
      expect(() => verify(value)).not.toThrow();
      expect(value).toEqual(unchanged);
    }
  });
  test.each([undefined, 456])('initial selection process %s must match the save child', (pid) => {
    const receipt = saveWorkspaceReceipt();
    if (pid === undefined) delete receipt.workspaceSelection.pid;
    else receipt.workspaceSelection.pid = pid;
    expect(() => createSaveWorkspaceVerifier(saveWorkspaceTarget)(receipt)).toThrow();
  });
  for (const phase of saveWorkspacePhases) {
    test.each([
      [
        'missing selection process',
        (value) => {
          delete value.workspaceSelection.pid;
        },
      ],
      [
        'different selection process',
        (value) => {
          value.workspaceSelection.pid = 456;
        },
      ],
      [
        'missing process',
        (value) => {
          delete value.pid;
        },
      ],
      [
        'zero process',
        (value) => {
          value.pid = 0;
        },
      ],
      [
        'fractional process',
        (value) => {
          value.pid = 123.5;
        },
      ],
      [
        'boolean process',
        (value) => {
          value.pid = true;
        },
      ],
      [
        'missing pin',
        (value) => {
          delete value.workspaceScope;
        },
      ],
      [
        'wrong context',
        (value) => {
          value.workspaceScope.contextId = 'TOTHER';
        },
      ],
      [
        'wrong native window',
        (value) => {
          value.workspaceScope.windowId = 43;
        },
      ],
      [
        'missing selection',
        (value) => {
          delete value.workspaceSelection;
        },
      ],
      [
        'missing requested workspace',
        (value) => {
          delete value.requestedWorkspace;
        },
      ],
      [
        'wrong requested workspace',
        (value) => {
          value.requestedWorkspace = 'Other';
        },
      ],
      [
        'wrong operation',
        (value) => {
          value.operation = 'read-media';
        },
      ],
    ])(`${phase} refuses %s`, (_name, mutate) => {
      const verify = createSaveWorkspaceVerifier(saveWorkspaceTarget);
      verify(saveWorkspaceReceipt());
      const value = saveWorkspaceReceipt(phase);
      mutate(value);
      expect(() => verify(value)).toThrow();
    });
    for (const status of [undefined, 'stopped']) {
      test(`${phase} refuses explicit scope failure with status ${status ?? 'absent'}`, () => {
        const value = saveWorkspaceReceipt(phase);
        if (status === undefined) delete value.status;
        else value.status = status;
        value.workspaceScopeError = 'Native workspace pin changed';
        expect(() => createSaveWorkspaceVerifier(saveWorkspaceTarget)(value)).toThrow(
          'Native workspace pin changed'
        );
      });
    }
    test(`${phase} refuses a stopped receipt with only historical selection proof`, () => {
      const value = saveWorkspaceReceipt(phase);
      value.status = 'stopped';
      delete value.workspaceScope;
      expect(() => createSaveWorkspaceVerifier(saveWorkspaceTarget)(value)).toThrow();
    });
  }
  test.each([
    [
      'process',
      (value) => {
        value.pid = 124;
        value.workspaceSelection.pid = 124;
      },
    ],
    [
      'native window',
      (value) => {
        value.workspaceSelection.before.windowId = 43;
        value.workspaceSelection.after.windowId = 43;
        value.workspaceScope.windowId = 43;
      },
    ],
    [
      'initial source URL',
      (value) => {
        value.workspaceSelection.before.url = 'https://app.slack.com/client/ESOURCE/channel/COTHER';
      },
    ],
    [
      'selected destination URL',
      (value) => {
        value.workspaceSelection.after.url = 'https://app.slack.com/client/TTARGET/channel/COTHER';
      },
    ],
    [
      'selected workspace context',
      (value) => {
        value.workspaceSelection.after.url = 'https://app.slack.com/client/TOTHER/channel/CCONTEXT';
        value.workspaceScope.contextId = 'TOTHER';
      },
    ],
  ])('individually valid %s drift cannot replace the initial selection', (_name, mutate) => {
    const initial = saveWorkspaceReceipt();
    const changed = saveWorkspaceReceipt('publish');
    mutate(changed);
    expect(() => createSaveWorkspaceVerifier(saveWorkspaceTarget)(changed)).not.toThrow();
    const verify = createSaveWorkspaceVerifier(saveWorkspaceTarget);
    verify(initial);
    expect(() => verify(changed)).toThrow(/selection changed/i);
  });
  test('selection pin is an immutable snapshot of the accepted receipt', () => {
    const value = saveWorkspaceReceipt();
    const verify = createSaveWorkspaceVerifier(saveWorkspaceTarget);
    verify(value);
    value.phase = 'publish';
    value.workspaceSelection.before.windowId = 43;
    value.workspaceSelection.after.windowId = 43;
    value.workspaceScope.windowId = 43;
    expect(() => verify(value)).toThrow(/selection changed/i);
  });
  test('live source navigation may change while the selection receipt remains exact', () => {
    const verify = createSaveWorkspaceVerifier(saveWorkspaceTarget);
    verify(saveWorkspaceReceipt());
    const changed = saveWorkspaceReceipt('source-select');
    changed.observations = ['CONE', 'CTWO'].map((channel) => {
      const url = `https://app.slack.com/client/TTARGET/channel/${channel}`;
      return {
        before: { url },
        after: { url },
        content: { nodes: [{ index: 0, parent: null, role: 'AXWebArea', url }] },
      };
    });
    expect(() => verify(changed)).not.toThrow();
    changed.observations[1].after.url = 'https://app.slack.com/client/TOTHER/channel/COTHER';
    expect(() => verify(changed)).toThrow(/context differs/i);
  });
  test('late workspace failure retains the verified publication artifact', () => {
    const artifact = {
      path: '/tmp/synthetic-scoped-save.png',
      published: true,
      verified: true,
      bytes: 123,
      sha256: 'a'.repeat(64),
    };
    const receipt = {
      ...saveWorkspaceReceipt('result'),
      status: 'stopped',
      workspaceScopeError: 'Workspace changed after publication',
      downloadMayHaveStarted: true,
    };
    delete receipt.workspaceScope;
    expect(() => createSaveWorkspaceVerifier(saveWorkspaceTarget)(receipt)).toThrow();
    const output = failedSaveMediaOutput({
      requested: 'FFILE',
      error: receipt.workspaceScopeError,
      receipt,
      context: { publication: { artifact } },
    });
    expect(output.status).toBe('stopped');
    expect(output.saved).toEqual(artifact);
    expect(output.downloadMayHaveStarted).toBe(true);
    expect(output.next).toContain('No automatic retry or overwrite');
  });
});

test('save preflight access failures retain the AX remedy in every output format', () => {
  const receipt = {
    status: 'stopped',
    accessStatus: 'permission-required',
    error: 'Slack accessibility API is disabled',
    next: 'Check host access, then rerun permissions.',
    accessibilityProbe: {
      status: 'api-disabled',
      pid: 123,
      checkedAttributes: ['AXRole'],
      error: { code: -25211, name: 'api-disabled', operation: 'AXRole' },
    },
  };
  const compact = failedSaveMediaOutput({ requested: 'FDEMO', error: receipt.error, receipt });
  expect(compact.next).toBe(receipt.next);
  expect(compact.downloadMayHaveStarted).toBe(false);
  expect(formatOutput(compact)).toContain('Slack AX: API disabled (-25211)');
  const json = JSON.parse(formatOutput(compact, 'json'));
  expect(json.accessStatus).toBe('permission-required');
  expect(json.accessibilityProbe.error).toEqual(receipt.accessibilityProbe.error);
  expect(json.accessibilityProbe.pid).toBeUndefined();
  expect(JSON.parse(formatOutput(compact, 'full-json', receipt))).toEqual(receipt);
  const uncertain = failedSaveMediaOutput({
    requested: 'FDEMO',
    error: receipt.error,
    receipt: { ...receipt, downloadMayHaveStarted: true },
  });
  expect(uncertain.next).toContain('native download may still complete');
});
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))
  );
});

function reopenedSourceFixture(route = 'conversation') {
  const plan = { workspace: 'TDEMO', messageRef: 'CDEMO:1700000000.000001' };
  const initial = { operation: 'save-media', phase: 'select', pid: 123, requested: 'FDEMO' };
  const receipt = {
    ...initial,
    phase: 'source-select',
    sourceRequest: { ...plan },
    sourceAction: { attempted: true, accepted: true, opened: true },
    sourceNavigation: {
      route,
      conversationId: 'CDEMO',
      query: route === 'conversation' ? null : 'in:demo after:2023-11-13',
      pages: route === 'conversation' ? 0 : 2,
      matchedMessageRef: plan.messageRef,
      complete: true,
    },
  };
  const resolved = {
    status: 'ok',
    requested: 'FDEMO',
    workspace: { id: 'TDEMO', contextId: 'TDEMO' },
    sources: [{ messageRef: plan.messageRef }, { messageRef: 'COTHER:1700000000.000002' }],
    coverage: { sourceCount: 2, complete: false },
  };
  return { plan, initial, receipt, resolved };
}

test('reopened selection is restricted to the exact remembered message in either verified route', () => {
  for (const route of ['conversation', 'conversation-search']) {
    const f = reopenedSourceFixture(route);
    const result = verifySourceReopening(f.receipt, f.initial, f.plan, f.resolved);
    expect(result.sources).toEqual([{ messageRef: f.plan.messageRef }]);
    expect(result.coverage).toEqual({ sourceCount: 1, complete: false });
    expect(f.resolved.sources).toHaveLength(2);
  }
});

for (const [name, mutate] of [
  [
    'process',
    (f) => {
      f.receipt.pid++;
    },
  ],
  [
    'request',
    (f) => {
      f.receipt.requested = 'FOTHER';
    },
  ],
  [
    'workspace',
    (f) => {
      f.resolved.workspace.contextId = 'TOTHER';
    },
  ],
  [
    'plan echo',
    (f) => {
      f.receipt.sourceRequest.messageRef = 'COTHER:1700000000.000001';
    },
  ],
  [
    'unbounded plan',
    (f) => {
      f.plan.query = 'unexpected';
    },
  ],
  [
    'phase',
    (f) => {
      f.receipt.phase = 'select';
    },
  ],
  [
    'accepted input',
    (f) => {
      f.receipt.sourceAction.accepted = false;
    },
  ],
  [
    'opened evidence',
    (f) => {
      f.receipt.sourceAction.opened = null;
    },
  ],
  [
    'partial navigation',
    (f) => {
      f.receipt.sourceNavigation.complete = false;
    },
  ],
  [
    'wrong destination',
    (f) => {
      f.receipt.sourceNavigation.conversationId = 'COTHER';
    },
  ],
  [
    'wrong matched message',
    (f) => {
      f.receipt.sourceNavigation.matchedMessageRef = 'CDEMO:1700000000.000002';
    },
  ],
  [
    'unknown route',
    (f) => {
      f.receipt.sourceNavigation.route = 'guessed';
    },
  ],
  [
    'missing exact source',
    (f) => {
      f.resolved.sources = [{ messageRef: 'COTHER:1700000000.000002' }];
    },
  ],
  [
    'prior Download',
    (f) => {
      f.receipt.action = { attempted: true };
    },
  ],
  [
    'prior viewer',
    (f) => {
      f.receipt.viewerAction = { attempted: true };
    },
  ],
  [
    'page bound',
    (f) => {
      f.receipt.sourceNavigation.pages = 6;
    },
  ],
  [
    'query control characters',
    (f) => {
      f.receipt.sourceNavigation.query += '\n';
    },
  ],
]) {
  test(`reopened selection rejects changed ${name}`, () => {
    const f = reopenedSourceFixture('conversation-search');
    mutate(f);
    expect(() => verifySourceReopening(f.receipt, f.initial, f.plan, f.resolved)).toThrow();
  });
}

test('source navigation uncertainty survives refusal without implying Download or publication', () => {
  for (const opened of [true, false, null]) {
    const receipt = {
      sourceMayHaveReopened: true,
      sourceRequest: { workspace: 'TDEMO', messageRef: 'CDEMO:1700000000.000001' },
      ...(opened === null ? {} : { sourceAction: { attempted: true, opened } }),
      downloadMayHaveStarted: false,
    };
    const result = failedSaveMediaOutput({ requested: 'FDEMO', error: 'Source stopped', receipt });
    expect(result.source).toEqual({ opened, messageRef: 'CDEMO:1700000000.000001' });
    expect(result.sourceMayHaveReopened).toBe(true);
    expect(result.downloadMayHaveStarted).toBe(false);
    expect(result).not.toHaveProperty('saved');
    expect(result.next).toContain('Inspect the current Slack source');
    expect(result.next).toContain('no Download token was sent');
  }
  expect(sourceSaveState({})).toEqual({});
  expect(
    sourceSaveState({
      sourceMayHaveReopened: true,
      nativeResult: { sourceAction: { opened: true } },
    })
  ).toEqual({ sourceMayHaveReopened: true, source: { opened: true, messageRef: null } });
});

test('uncertain Download and viewer states take priority over source navigation recovery', () => {
  const source = { sourceMayHaveReopened: true, sourceAction: { opened: true } };
  const downloading = failedSaveMediaOutput({
    requested: 'FDEMO',
    error: 'Interrupted',
    receipt: { ...source, downloadMayHaveStarted: true },
  });
  expect(downloading.source.opened).toBe(true);
  expect(downloading.next).toContain('Inspect Slack Downloads');
  const viewing = failedSaveMediaOutput({
    requested: 'FDEMO',
    error: 'Interrupted',
    receipt: {
      ...source,
      viewerMayHaveOpened: true,
      viewerAction: { opened: true, closed: false },
    },
  });
  expect(viewing.source.opened).toBe(true);
  expect(viewing.next).toContain('Inspect the file viewer');
});
async function fixture(body = '') {
  const folder = await mkdtemp(path.join(tmpdir(), 'slack-save-runner-'));
  folders.push(folder);
  const binary = path.join(folder, 'publisher.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env bun\nimport {atomicWriteFileSync} from ${JSON.stringify(new URL('./lib/atomic-file.mjs', import.meta.url).href)};\nconst request=JSON.parse(await Bun.stdin.text());\n${body}\n`,
    { mode: 0o700 }
  );
  await chmod(binary, 0o700);
  return {
    folder,
    binary,
    request: {
      sourcePath: path.join(folder, 'synthetic-source.mp4'),
      destination: path.join(folder, 'saved.mp4'),
      expectedSource: { device: '1', inode: '2', size: '3', mtimeNs: '123456789' },
    },
  };
}
const validReceipt = `{
  operation:'save-media-publish', status:'ok',
  artifact:{path:request.destination,published:true,verified:true,bytes:3,sha256:'a'.repeat(64),contentType:null}
}`;
const uncertain = (result, destination) => {
  expect(result.code).toBe(1);
  expect(result.receipt.status).toBe('stopped');
  expect(result.receipt.artifact).toEqual({ path: destination, published: null, verified: false });
};
async function marker(file) {
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) {
    try {
      await lstat(file);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await Bun.sleep(5);
  }
  throw new Error('Synthetic publisher did not reach the expected state');
}

describe('save destination preparation', () => {
  test('resolves a relative Unicode path containing equals without creating it', async () => {
    const f = await fixture();
    const output = path.join(f.folder, 'résumé=🎬.mp4');
    const result = await prepareDestination(path.relative(process.cwd(), output));
    expect(result.path).toBe(path.join(await realpath(f.folder), 'résumé=🎬.mp4'));
    expect(result).toMatchObject({
      parent: await realpath(f.folder),
      device: expect.stringMatching(/^\d+$/),
      inode: expect.stringMatching(/^\d+$/),
    });
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('canonicalizes an existing parent alias and pins the actual directory', async () => {
    const f = await fixture();
    const directory = path.join(f.folder, 'actual'),
      alias = path.join(f.folder, 'alias');
    await mkdir(directory);
    await symlink(directory, alias);
    const throughAlias = await prepareDestination(path.join(alias, 'download.dat'));
    const direct = await prepareDestination(path.join(directory, 'download.dat'));
    expect(throughAlias).toEqual(direct);
  });
  test('rejects every existing leaf including a dangling symlink without altering it', async () => {
    const f = await fixture();
    const existing = path.join(f.folder, 'existing'),
      dangling = path.join(f.folder, 'dangling'),
      directory = path.join(f.folder, 'subfolder');
    await writeFile(existing, 'preserve existing contents');
    await symlink(path.join(f.folder, 'absent-target'), dangling);
    await mkdir(directory);
    for (const output of [existing, dangling, directory])
      await expect(prepareDestination(output)).rejects.toThrow('already exists');
    expect(await readFile(existing, 'utf8')).toBe('preserve existing contents');
    expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
  });
  test('rejects empty/control-character paths and missing or non-directory parents', async () => {
    const f = await fixture();
    for (const output of [
      '',
      ' ',
      '\tbad',
      'bad\nname',
      'bad\0name',
      'bad\u0085name',
      f.folder + '/',
      null,
    ]) {
      await expect(prepareDestination(output)).rejects.toThrow('Output must name a file');
    }
    await expect(prepareDestination(path.join(f.folder, 'missing', 'output'))).rejects.toThrow();
    await writeFile(path.join(f.folder, 'not-directory'), 'contents');
    await expect(
      prepareDestination(path.join(f.folder, 'not-directory', 'output'))
    ).rejects.toThrow();
  });
});

describe('file publisher subprocess receipts', () => {
  test('passes exact source/destination identities and retains a verified success', async () => {
    const f = await fixture(`console.log(JSON.stringify({...${validReceipt},request}));`);
    f.request.destination = path.join(f.folder, 'résumé=🎬.mp4');
    const result = await publishDownload(f.binary, f.request, { timeoutMs: 2000 });
    expect(result.code).toBe(0);
    expect(result.interrupted).toBe(false);
    expect(result.receipt.request).toEqual(f.request);
    expect(result.receipt.artifact).toMatchObject({
      path: f.request.destination,
      published: true,
      verified: true,
    });
  });
  test('preserves Unicode paths when UTF-8 bytes arrive in separate stdout chunks', async () => {
    const f = await fixture(`
      const bytes=Buffer.from(JSON.stringify(${validReceipt}));
      const split=bytes.indexOf(Buffer.from('🎬'))+1;
      process.stdout.write(bytes.subarray(0,split));
      await Bun.sleep(25);
      process.stdout.write(bytes.subarray(split));
    `);
    f.request.destination = path.join(f.folder, 'résumé=🎬.mp4');
    const result = await publishDownload(f.binary, f.request, { timeoutMs: 2000 });
    expect(result.code).toBe(0);
    expect(result.receipt.artifact.path).toBe(f.request.destination);
  });
  test('retains a published artifact receipt even when the publisher exits unsuccessfully', async () => {
    const f = await fixture(`
      atomicWriteFileSync(request.destination,'abc');
      console.log(JSON.stringify({...${validReceipt},status:'stopped',error:'Synthetic readback failed'}));
      process.exit(1);
    `);
    const result = await publishDownload(f.binary, f.request, { timeoutMs: 2000 });
    expect(result.code).toBe(1);
    expect(result.receipt.artifact).toMatchObject({
      path: f.request.destination,
      published: true,
      verified: true,
    });
    expect(await readFile(f.request.destination, 'utf8')).toBe('abc');
  });
  test('a destination appearing after preparation remains untouched on publisher refusal', async () => {
    const f = await fixture(`
      const {writeFile}=await import('node:fs/promises');
      try { await writeFile(request.destination,'replacement',{flag:'wx'}); process.exit(9); }
      catch(error) {
        if(error.code!=='EEXIST') throw error;
        console.log(JSON.stringify({operation:'save-media-publish',status:'stopped',error:'Output exists',artifact:{path:request.destination,published:false,verified:false}}));
        process.exit(1);
      }
    `);
    await prepareDestination(f.request.destination);
    await writeFile(f.request.destination, 'concurrent file');
    const result = await publishDownload(f.binary, f.request, { timeoutMs: 2000 });
    expect(result.code).toBe(1);
    expect(result.receipt.artifact.published).toBe(false);
    expect(await readFile(f.request.destination, 'utf8')).toBe('concurrent file');
  });
  test('receipt loss preserves an uncertain artifact and never removes the file', async () => {
    const f = await fixture(
      `atomicWriteFileSync(request.destination,'abc'); process.stdout.write('{"operation":'); process.exit(1);`
    );
    const result = await publishDownload(f.binary, f.request, { timeoutMs: 2000 });
    uncertain(result, f.request.destination);
    expect(await readFile(f.request.destination, 'utf8')).toBe('abc');
  });
  test('invalid and oversized receipt framing cannot become publication success', async () => {
    for (const output of ['null', '[]', 'true', 'x'.repeat(65537)]) {
      const f = await fixture(`process.stdout.write(${JSON.stringify(output)});`);
      const result = await publishDownload(f.binary, f.request, { timeoutMs: 2000 });
      uncertain(result, f.request.destination);
    }
  });
  test('invalid UTF-8 receipt data preserves publication uncertainty instead of corrupting a path', async () => {
    const f = await fixture(
      `process.stdout.write(Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xc0,0x80,0x22,0x7d]));`
    );
    uncertain(
      await publishDownload(f.binary, f.request, { timeoutMs: 2000 }),
      f.request.destination
    );
  });
  test('cancellation before spawn creates no publisher-side artifact', async () => {
    const f = await fixture(`atomicWriteFileSync(request.destination,'must not be created');`);
    const controller = new AbortController();
    controller.abort();
    await expect(
      publishDownload(f.binary, f.request, { signal: controller.signal, timeoutMs: 2000 })
    ).rejects.toThrow('before starting');
    await expect(lstat(f.request.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('cancellation after publication without a receipt preserves the uncertain path', async () => {
    const f = await fixture(
      `atomicWriteFileSync(request.destination,'abc'); atomicWriteFileSync(request.destination+'.ready','ready'); await Bun.sleep(10000);`
    );
    const controller = new AbortController();
    const operation = publishDownload(f.binary, f.request, {
      signal: controller.signal,
      timeoutMs: 2000,
    });
    try {
      await marker(f.request.destination + '.ready');
    } finally {
      controller.abort();
    }
    const result = await operation;
    uncertain(result, f.request.destination);
    expect(result.interrupted).toBe(true);
    expect(await readFile(f.request.destination, 'utf8')).toBe('abc');
  });
  test('cancellation keeps an explicit published receipt emitted during shutdown', async () => {
    const f = await fixture(`
      process.on('SIGTERM',()=>{console.log(JSON.stringify({...${validReceipt},status:'stopped',error:'Cancelled after publication'}));process.exit(1);});
      atomicWriteFileSync(request.destination,'abc'); atomicWriteFileSync(request.destination+'.ready','ready'); await Bun.sleep(10000);
    `);
    const controller = new AbortController();
    const operation = publishDownload(f.binary, f.request, {
      signal: controller.signal,
      timeoutMs: 2000,
    });
    try {
      await marker(f.request.destination + '.ready');
    } finally {
      controller.abort();
    }
    const result = await operation;
    expect(result.interrupted).toBe(true);
    expect(result.receipt.artifact).toMatchObject({
      path: f.request.destination,
      published: true,
      verified: true,
    });
    expect(await readFile(f.request.destination, 'utf8')).toBe('abc');
  });
  test('a publisher ignoring SIGTERM is bounded and leaves publication uncertainty explicit', async () => {
    const f = await fixture(
      `process.on('SIGTERM',()=>{}); atomicWriteFileSync(request.destination,'abc'); atomicWriteFileSync(request.destination+'.ready','ready'); await Bun.sleep(10000);`
    );
    const controller = new AbortController();
    const started = performance.now();
    const operation = publishDownload(f.binary, f.request, {
      signal: controller.signal,
      timeoutMs: 2500,
    });
    try {
      await marker(f.request.destination + '.ready');
    } finally {
      controller.abort();
    }
    const result = await operation;
    uncertain(result, f.request.destination);
    expect(result.interrupted).toBe(true);
    expect(performance.now() - started).toBeLessThan(4000);
    expect(await readFile(f.request.destination, 'utf8')).toBe('abc');
  }, 5000);
  test('publisher timeout reports uncertainty even if startup has not completed', async () => {
    const f = await fixture(`await Bun.sleep(10000);`);
    const result = await publishDownload(f.binary, f.request, { timeoutMs: 30 });
    uncertain(result, f.request.destination);
    expect(result.interrupted).toBe(true);
  });
});

describe('stopped save evidence', () => {
  const selected = {
    routeKind: 'file-download',
    url: 'https://files.slack.com/files-pri/TDEMO-FFILE/download/demo.png?origin_team=EDEMO',
    fileDownloadEvidence: {
      filePageUrl: 'https://demo.slack.com/files/UDEMO/FFILE/demo.png',
      fileId: 'FFILE',
      contextId: 'EDEMO',
    },
  };
  const stopped = (context, downloadMayHaveStarted = true) =>
    failedSaveMediaOutput({
      requested: 'FFILE',
      error: new Error('Source changed during download monitoring'),
      receipt: { downloadMayHaveStarted },
      context,
    });
  test('monitoring failure retains selected original route without claiming publication', () => {
    const output = stopped({ selected });
    expect(output.status).toBe('stopped');
    expect(output.downloadMayHaveStarted).toBe(true);
    expect(output.saved).toEqual({
      representation: 'slack-file-download',
      originalSelection: { status: 'selected', basis: 'source-bound-private-file-download' },
      originalFile: null,
    });
    expect(output.next).toContain('native download may still complete');
  });
  test('published and uncertain artifacts keep selection without replacing publication truth', () => {
    for (const published of [true, null]) {
      const artifact = { path: '/tmp/synthetic-output.png', published, verified: false };
      const output = stopped({ selected, publication: { artifact } });
      expect(output.saved).toMatchObject({ ...artifact, originalFile: null });
      expect(output.saved.originalSelection.status).toBe('selected');
      expect(output.status).toBe('stopped');
    }
  });
  test('refusal before selection invents no artifact or route; rendition failures stay explicit', () => {
    const refused = stopped(undefined, false);
    expect(refused).not.toHaveProperty('saved');
    expect(refused.downloadMayHaveStarted).toBe(false);
    expect(refused.next).toContain('no Download token was sent');
    const fallback = stopped({
      selected: { ...selected, routeKind: 'rendition', fileDownloadEvidence: null },
    });
    expect(fallback.saved).toEqual({
      representation: 'observed-download-target',
      originalSelection: { status: 'unavailable', basis: 'observed-download-target' },
      originalFile: null,
    });
  });
});

test('viewer-only refusal retains opening state without inventing a download or publication', () => {
  for (const closed of [true, false, null]) {
    const output = failedSaveMediaOutput({
      requested: 'FDEMO',
      error: new Error('Original route unavailable'),
      receipt: {
        viewerMayHaveOpened: true,
        downloadMayHaveStarted: false,
        viewerAction: { attempted: true, accepted: true, opened: true, closed },
      },
      context: { opener: { token: 'synthetic-opener' } },
    });
    expect(output.viewer).toEqual({ opened: true, closed });
    expect(output.viewerMayHaveOpened).toBe(true);
    expect(output.downloadMayHaveStarted).toBe(false);
    expect(output).not.toHaveProperty('saved');
    expect(output.next).toContain('no Download token was sent');
    if (closed !== true) expect(output.next).toContain('Inspect the file viewer');
  }
  const uncertain = failedSaveMediaOutput({
    requested: 'FDEMO',
    error: new Error('Protocol interrupted'),
    receipt: { viewerMayHaveOpened: true, downloadMayHaveStarted: false },
  });
  expect(uncertain.viewer).toEqual({ opened: null, closed: null });
  const observed = failedSaveMediaOutput({
    requested: 'FDEMO',
    error: new Error('Protocol interrupted'),
    receipt: {
      viewerMayHaveOpened: true,
      downloadMayHaveStarted: false,
      nativeResult: { viewerAction: { opened: true, closed: true } },
    },
  });
  expect(observed.viewer).toEqual({ opened: true, closed: true });
});

test.each(['receipt', 'nativeResult'])(
  'viewer refusal projects rejection-time evidence and cleanup from %s',
  (location) => {
    const failure = {
      phase: 'viewer-capture',
      reason: 'source-url-mismatch',
      capturedAt: '2026-11-15T14:42:25Z',
      captureComplete: true,
      sourceVerifiedAtCaptureStart: true,
      windowVerifiedAtCaptureStart: true,
      activeImageCount: 1,
      images: [
        {
          index: 4,
          parent: 3,
          role: 'AXImage',
          classes: ['p-file_image'],
          urlPresent: true,
          urlMatchesSource: false,
          fileMatchesSource: true,
          ownerMatchesSource: true,
        },
      ],
    };
    const cleanupFailure = { ...failure, reason: 'source-changed-before-close' };
    const cleanup = {
      status: 'withheld',
      closeAttempted: false,
      closed: false,
      error: 'Source changed before close',
      failure: cleanupFailure,
    };
    const native = {
      viewerAction: {
        opened: true,
        closed: false,
        closeAttempted: false,
        closeError: 'Source changed before close',
        sourceCheck: 'existing-toolbar-offscreen',
      },
      viewerFailure: failure,
      viewerCleanup: cleanup,
    };
    const output = failedSaveMediaOutput({
      requested: 'FDEMO',
      error: new Error('Opened viewer image does not match the retained source URL'),
      receipt: {
        viewerMayHaveOpened: true,
        downloadMayHaveStarted: false,
        ...(location === 'receipt' ? native : { nativeResult: native }),
      },
    });
    expect(output.viewer).toEqual({ ...native.viewerAction, failure, cleanup });
    expect(output.error).toBe('Opened viewer image does not match the retained source URL');
    expect(output.status).toBe('stopped');
    expect(output.downloadMayHaveStarted).toBe(false);
    expect(output).not.toHaveProperty('saved');
    expect(output.next).toContain('Inspect the file viewer');
    const json = JSON.parse(formatOutput(output, 'json'));
    expect(json.viewer.failure.images).toEqual(failure.images);
    expect(json.viewer.cleanup.failure.reason).toBe('source-changed-before-close');
  }
);

test('cleanup evidence cannot replace unknown viewer closure or invent timeout diagnostics', () => {
  const output = failedSaveMediaOutput({
    requested: 'FDEMO',
    error: new Error('Attachment saving timed out'),
    receipt: {
      viewerMayHaveOpened: true,
      downloadMayHaveStarted: false,
      viewerCleanup: { status: 'closed', closeAttempted: true, closed: true },
    },
  });
  expect(output.viewer.opened).toBeNull();
  expect(output.viewer.closed).toBeNull();
  expect(output.viewer).not.toHaveProperty('failure');
  expect(output.viewer).not.toHaveProperty('closeAttempted');
  expect(output.next).toContain('Inspect the file viewer');
  expect(formatOutput(output)).toContain('closure unverified');
  expect(formatOutput(output)).toContain('file viewer may be open');
});
