import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFileSync } from './lib/atomic-file.mjs';

// Exercise the actual wrapper against an isolated synthetic native executable.
// This never starts Slack, compiles Swift, or uses the real helper activity lock.
const target = 'workspace:one.slack.com';
function selected() {
  const view = {
    url: 'https://app.slack.com/client/TONE/CONE',
    name: 'One',
    windowId: 41,
    entries: [
      { name: 'One', domain: 'one.slack.com', current: true },
      { name: 'Two', domain: 'two.slack.com', current: false },
    ],
  };
  return {
    operation: 'switch-workspace',
    status: 'ok',
    requested: target,
    pid: 123,
    before: structuredClone(view),
    after: structuredClone(view),
    selection: { name: 'One', domain: 'one.slack.com' },
    switchAttempted: false,
    workspaceSwitchMayHaveBeenRequested: false,
    selector: { opened: true, reused: false, verificationOpened: false, closed: true },
  };
}
function scoped() {
  const url = 'https://app.slack.com/client/TONE/CONE';
  return {
    operation: 'channels',
    status: 'ok',
    pid: 123,
    requestedWorkspace: target,
    workspaceSelection: selected(),
    workspaceSwitchMayHaveBeenRequested: false,
    workspaceScope: { contextId: 'TONE', windowId: 41 },
    before: { url },
    after: { url },
    content: {
      truncated: false,
      nodes: [{ index: 0, parent: null, role: 'AXWebArea', label: 'One', url, classes: [] }],
    },
  };
}
async function execute(
  args,
  receipt,
  {
    nativeCode = 0,
    raw,
    transcript = false,
    save = false,
    saveSetupFailure = false,
    saved,
    observeTimers = false,
  } = {}
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'slack-workspace-cli-'));
  try {
    const native = path.join(directory, 'native');
    const fixture = path.join(directory, 'receipt.json');
    const argumentsFile = path.join(directory, 'arguments.json');
    const tokenFile = path.join(directory, 'token.txt');
    const timersFile = path.join(directory, 'timers.json');
    atomicWriteFileSync(fixture, JSON.stringify(receipt));
    atomicWriteFileSync(
      native,
      `#!${process.execPath}
import { atomicWriteFileSync } from ${JSON.stringify(new URL('./lib/atomic-file.mjs', import.meta.url).href)};
atomicWriteFileSync(${JSON.stringify(argumentsFile)},JSON.stringify(process.argv.slice(2)));
${
  transcript || (save && !saveSetupFailure)
    ? `console.log(await Bun.file(${JSON.stringify(fixture)}).text());
const token=await Bun.stdin.text(); atomicWriteFileSync(${JSON.stringify(tokenFile)},token);
console.log(JSON.stringify({operation:${JSON.stringify(save ? 'save-media' : 'read-transcript')},status:'stopped',error:'Synthetic stop'}));`
    : `console.log(${raw === undefined ? `await Bun.file(${JSON.stringify(fixture)}).text()` : JSON.stringify(raw)});`
}
process.exit(${nativeCode});
`
    );
    await chmod(native, 0o700);
    const builder = path.join(directory, 'build.mjs');
    atomicWriteFileSync(
      builder,
      `export const SLACK_NATIVE_BUNDLE={},PUBLISHER_NATIVE_BUNDLE={};
export const captureNativeBundle=async()=>({});
export const buildNativeBundle=async()=>${JSON.stringify(native)};
`
    );
    let source = await readFile(new URL('./slack.mjs', import.meta.url), 'utf8');
    if (saved) {
      const saveRunner = path.join(directory, 'save.mjs');
      atomicWriteFileSync(
        saveRunner,
        `export const prepareDestination=async()=>({});
export const saveMedia=async()=>(${JSON.stringify(saved)});`
      );
      source = source.replace(
        "from './slack-save-runner.mjs'",
        `from '${pathToFileURL(saveRunner).href}'`
      );
    }
    source = source
      .replace(
        "import { homedir } from 'node:os';",
        `const homedir=()=>${JSON.stringify(directory)};`
      )
      .replace("from './slack-native-build.mjs'", `from '${pathToFileURL(builder).href}'`)
      .replace(
        /from '(\.\/[^']+)'/g,
        (_, relative) => `from '${new URL(relative, import.meta.url).href}'`
      );
    const wrapper = path.join(directory, 'wrapper.mjs');
    if (observeTimers) {
      source =
        `import { atomicWriteFileSync as recordTimerFile } from ${JSON.stringify(new URL('./lib/atomic-file.mjs', import.meta.url).href)};
const observedTimerDelays=[];
const originalSetTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,delay,...args)=>{
  observedTimerDelays.push(delay);
  recordTimerFile(${JSON.stringify(timersFile)},JSON.stringify(observedTimerDelays));
  return originalSetTimeout(callback,delay,...args);
};
` + source.replace(/^#![^\n]*\n/, '');
    }
    atomicWriteFileSync(wrapper, source);
    const child = Bun.spawn(
      [
        process.execPath,
        wrapper,
        ...args,
        ...(save || saved ? [`--output=${path.join(directory, 'saved.bin')}`] : []),
      ],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    let killTimer;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    process.once('SIGTERM', stop);
    const timer = setTimeout(stop, 10000);
    let code, stdout, stderr;
    try {
      [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener('SIGTERM', stop);
    }
    return {
      code,
      stdout,
      stderr,
      args: (await Bun.file(argumentsFile).exists()) ? await Bun.file(argumentsFile).json() : null,
      token: (await Bun.file(tokenFile).exists()) ? await Bun.file(tokenFile).text() : null,
      timers: (await Bun.file(timersFile).exists()) ? await Bun.file(timersFile).json() : [],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'darwin')('workspace option wrapper boundaries', () => {
  test.each(['text', 'json', 'full-json'])(
    'forwards resolved member budgets with matching runtime in %s',
    async (format) => {
      for (const { options, seconds, scopedRead } of [
        { options: [], seconds: 160 },
        { options: ['--pages=1'], seconds: 70 },
        { options: ['--pages=3'], seconds: 70 },
        { options: ['--max-seconds=1'], seconds: 1 },
        { options: ['--max-seconds=900'], seconds: 900 },
        { options: ['--pages=3', '--max-seconds=900'], seconds: 900, scopedRead: true },
      ]) {
        const receipt = {
          ...(scopedRead ? scoped() : {}),
          operation: 'members',
          status: 'ok',
          channel: { name: 'demo', url: 'https://app.slack.com/client/TONE/CONE' },
          total: 1,
          members: [{ id: 'UALEX1', name: 'Alex Example' }],
          listPages: 1,
          stopReason: 'complete',
          maxSeconds: seconds,
          dialogOpened: true,
          dialogReused: false,
          dialogClosed: true,
        };
        const result = await execute(
          [
            'members',
            'demo',
            ...options,
            ...(scopedRead ? [`--workspace=${target}`] : []),
            `--format=${format}`,
          ],
          receipt,
          { observeTimers: true }
        );
        expect({ code: result.code, stderr: result.stderr, stdout: result.stdout }).toMatchObject({
          code: 0,
        });
        expect(result.args).toEqual([
          ...(scopedRead ? [`--workspace=${target}`] : []),
          'members',
          'demo',
          ...options.filter((option) => option.startsWith('--pages=')),
          `--max-seconds=${seconds}`,
        ]);
        expect(result.timers).toContain((seconds + 20) * 1000 + (scopedRead ? 15000 : 0));
        if (format === 'text') expect(result.stdout).toContain('Members of #demo');
        else expect(JSON.parse(result.stdout).status).toBe('ok');
      }
    }
  );

  test.each(['text', 'json', 'full-json'])(
    'save setup refusal retains workspace candidates without a fabricated preflight in %s',
    async (format) => {
      const receipt = {
        operation: 'save-media',
        requested: 'FDEMO',
        status: 'stopped',
        error: 'Exact workspace unavailable',
        requestedWorkspace: 'workspace:missing.slack.com',
        workspaceSwitchMayHaveBeenRequested: false,
        workspaceSelection: {
          ...selected(),
          status: 'not-found',
          requested: 'workspace:missing.slack.com',
          error: 'Exact workspace unavailable',
        },
      };
      delete receipt.workspaceSelection.selection;
      const result = await execute(
        ['save-media', 'FDEMO', `--workspace=${receipt.requestedWorkspace}`, `--format=${format}`],
        receipt,
        { save: true, saveSetupFailure: true, nativeCode: 1 }
      );
      expect(result.code).toBe(1);
      expect(result.token).toBeNull();
      const outputText = result.stdout + result.stderr;
      expect(outputText).toContain('Exact workspace unavailable');
      expect(outputText).toContain('one.slack.com');
      expect(outputText).not.toContain('Workspace protocol envelope is invalid');
      if (format !== 'text') {
        const output = JSON.parse(result.stdout);
        expect(output.status).toBe('stopped');
        expect(output.preflight).toBeUndefined();
        expect(output.publication).toBeUndefined();
        expect(output.downloadMayHaveStarted).toBe(false);
      }
    }
  );
  test.each(['background', 'foreground'])(
    'scoped save uses one %s native child and cancels before selection on a bad pin',
    async (interaction) => {
      const receipt = { ...scoped(), operation: 'save-media', phase: 'select', requested: 'FDEMO' };
      receipt.workspaceScope.windowId++;
      const result = await execute(
        [
          'save-media',
          'FDEMO',
          `--workspace=${target}`,
          `--interaction=${interaction}`,
          '--original',
          '--format=full-json',
        ],
        receipt,
        { save: true }
      );
      expect(result.code).toBe(1);
      expect(result.args).toEqual([
        ...(interaction === 'foreground' ? ['--interaction=foreground'] : []),
        `--workspace=${target}`,
        'save-media',
        'FDEMO',
      ]);
      expect(JSON.parse(result.token)).toEqual({ cancel: true });
      const output = JSON.parse(result.stdout);
      expect(output.downloadMayHaveStarted).toBe(false);
      expect(output.publication).toBeUndefined();
    }
  );

  test.each(['text', 'json', 'full-json'])(
    'late save scope failure preserves publication and uncertainty in %s',
    async (format) => {
      const compact = {
        schemaVersion: 1,
        operation: 'save-media',
        requested: 'FDEMO',
        status: 'ok',
        downloadMayHaveStarted: true,
        sourceMayHaveReopened: true,
        viewerMayHaveOpened: true,
        saved: {
          path: '/tmp/synthetic-scoped-save.bin',
          published: true,
          verified: true,
          bytes: 1,
          sha256: 'a'.repeat(64),
        },
      };
      const receipt = {
        operation: 'save-media',
        status: 'stopped',
        error: 'Workspace checkpoint failed',
        publication: { artifact: compact.saved },
        rejectedPublicationPreflight: {
          operation: 'save-media',
          phase: 'publish',
          workspaceSwitchMayHaveBeenRequested: true,
        },
        resolution: compact,
      };
      const run = await execute(
        ['save-media', 'FDEMO', `--workspace=${target}`, `--format=${format}`],
        {},
        { saved: { code: 0, compact, receipt } }
      );
      expect(run.code).toBe(1);
      if (format === 'text') {
        expect(run.stderr).toContain('/tmp/synthetic-scoped-save.bin');
        expect(run.stderr).toContain('Workspace');
        expect(run.stderr).not.toMatch(/^Saved /m);
      } else {
        const raw = JSON.parse(run.stdout);
        const output = format === 'full-json' ? raw.resolution : raw;
        expect(output.status).toBe('stopped');
        expect(output.saved).toEqual(compact.saved);
        expect(output.downloadMayHaveStarted).toBe(true);
        expect(output.sourceMayHaveReopened).toBe(true);
        expect(output.viewerMayHaveOpened).toBe(true);
        expect(output.workspaceSwitchMayHaveBeenRequested).toBe(true);
        if (format === 'full-json') expect(raw.publication.artifact).toEqual(compact.saved);
      }
    }
  );
  test('passes workspace and pages to one native invocation in background', async () => {
    const run = await execute(
      ['channels', `--workspace=${target}`, '--pages=2', '--format=full-json'],
      scoped()
    );
    expect(run.code).toBe(0);
    expect(run.args).toEqual([`--workspace=${target}`, 'channels', '--pages=2']);
    const output = JSON.parse(run.stdout);
    expect(output.workspaceResolution.workspace.contextId).toBe('TONE');
    expect(output.workspaceSelection).toEqual(selected());
  });
  test('explicit foreground precedes the workspace prefix without changing the command allowlist', async () => {
    const run = await execute(
      ['channels', `--workspace=${target}`, '--interaction=foreground', '--format=full-json'],
      scoped()
    );
    expect(run.code).toBe(0);
    expect(run.args).toEqual(['--interaction=foreground', `--workspace=${target}`, 'channels']);
  });
  test.each(['text', 'json', 'full-json'])(
    'unknown workspace retains inline choices in %s',
    async (format) => {
      const receipt = scoped();
      receipt.status = 'stopped';
      receipt.error = 'Exact workspace unavailable';
      receipt.requestedWorkspace = 'workspace:missing.slack.com';
      receipt.workspaceSelection.status = 'not-found';
      receipt.workspaceSelection.requested = receipt.requestedWorkspace;
      receipt.workspaceSelection.error = receipt.error;
      delete receipt.workspaceSelection.selection;
      delete receipt.content;
      delete receipt.workspaceScope;
      const run = await execute(
        ['channels', `--workspace=${receipt.requestedWorkspace}`, `--format=${format}`],
        receipt,
        { nativeCode: 1 }
      );
      expect(run.code).toBe(1);
      const output = run.stdout + run.stderr;
      expect(output).toContain('one.slack.com');
      if (format !== 'text') expect(JSON.parse(run.stdout).status).toBe('stopped');
      else {
        expect(output).toContain('switch-workspace');
        expect(output).not.toContain('read-dm');
      }
    }
  );
  test.each(['missing selection', 'changed scope', 'changed source'])(
    'full JSON cannot bypass %s',
    async (mode) => {
      const receipt = scoped();
      if (mode === 'missing selection') delete receipt.workspaceSelection;
      if (mode === 'changed scope') receipt.workspaceScope.contextId = 'TOTHER';
      if (mode === 'changed source')
        receipt.content.nodes[0].url = 'https://app.slack.com/client/TOTHER/CONE';
      const run = await execute(
        ['channels', `--workspace=${target}`, '--format=full-json'],
        receipt
      );
      expect(run.code).toBe(1);
      expect(JSON.parse(run.stdout).status).toBe('stopped');
      expect(JSON.parse(run.stdout).resolution.error).toContain('workspace');
    }
  );
  test('malformed native output retains unknown switching outcome', async () => {
    const run = await execute(
      ['channels', `--workspace=${target}`, '--format=json'],
      {},
      { raw: 'invalid' }
    );
    expect(run.code).toBe(1);
    const output = JSON.parse(run.stdout);
    expect(output.workspaceSwitchMayHaveBeenRequested).toBeNull();
    expect(output.requestedWorkspace).toBe(target);
  });
  test.each([true, false])(
    'lost final workspace pin cannot become a partial collection (explicit error: %j)',
    async (explicitError) => {
      const receipt = scoped();
      receipt.status = 'stopped';
      receipt.error = 'Native collection stopped';
      delete receipt.workspaceScope;
      receipt.batch = {
        requestedPages: 2,
        completedPages: 1,
        attemptedPages: 2,
        stopReason: 'error',
      };
      receipt.pages = [{ operation: 'channels', pid: 123, content: receipt.content }];
      if (explicitError) receipt.workspaceScopeError = 'Selected workspace changed before output';
      const run = await execute(
        ['channels', `--workspace=${target}`, '--pages=2', '--format=json'],
        receipt,
        { nativeCode: 1 }
      );
      const output = JSON.parse(run.stdout);
      expect(run.code).toBe(1);
      expect(output.status).toBe('stopped');
      expect(output.channels).toBeUndefined();
      expect(output.workspaceSelection.status).toBe('ok');
      expect(output.error).toBe(
        explicitError
          ? 'Selected workspace changed before output'
          : 'Captured content has no fresh selected workspace/window verification'
      );
    }
  );
  test('malformed nested transcript proof cannot erase a possible workspace switch', async () => {
    const receipt = {
      operation: 'read-transcript',
      status: 'stopped',
      error: 'Synthetic protocol failure',
      preflight: {
        operation: 'read-transcript',
        requestedWorkspace: target,
        workspaceSwitchMayHaveBeenRequested: true,
        workspaceSelection: { switchAttempted: true },
      },
    };
    const run = await execute(
      ['read-transcript', 'FDEMO', `--workspace=${target}`, '--format=json'],
      receipt
    );
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).workspaceSwitchMayHaveBeenRequested).toBe(true);
  });
  test('a mismatched transcript preflight receives cancellation and never an opening token', async () => {
    const receipt = scoped();
    receipt.operation = 'read-transcript';
    receipt.phase = 'select';
    receipt.requested = 'FDEMO';
    receipt.workspaceScope.contextId = 'TOTHER';
    const run = await execute(
      ['read-transcript', 'FDEMO', `--workspace=${target}`, '--pages=2', '--format=json'],
      receipt,
      { transcript: true }
    );
    expect(run.code).toBe(1);
    expect(run.token).toBe('{"cancel":true}\n');
    expect(JSON.parse(run.stdout).status).toBe('stopped');
  });
  test.each([
    ['channels', '--workspace='],
    ['inspect', `--workspace=${target}`],
    ['read-media', 'FDEMO', `--workspace=${target}`, '--interaction=foreground'],
    ['channels', `--workspace=${target}`, `--workspace=${target}`],
  ])('invalid scoped arguments stop before native execution: %j', async (...args) => {
    const run = await execute([...args, '--format=json'], scoped());
    expect(run.code).toBe(2);
    expect(run.args).toBeNull();
  });
  test('omitted option retains the ordinary native command and receipt', async () => {
    const receipt = scoped();
    delete receipt.requestedWorkspace;
    delete receipt.workspaceSelection;
    delete receipt.workspaceScope;
    delete receipt.workspaceSwitchMayHaveBeenRequested;
    const run = await execute(['channels', '--format=full-json'], receipt);
    expect(run.code).toBe(0);
    expect(run.args).toEqual(['channels']);
    const output = JSON.parse(run.stdout);
    expect(output.workspaceResolution).toBeUndefined();
    expect(output.content).toEqual(receipt.content);
  });
});
