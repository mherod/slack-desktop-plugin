import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFileSync } from './lib/atomic-file.mjs';
import { compactMembersClose, stoppedMembersClose } from './slack-members-close.mjs';
import { formatOutput, parseCLI } from './slack-format.mjs';

const source = () => ({
  url: 'https://app.slack.com/client/TDEMO/CDEMO',
  title: '! demo (Channel) - Example - Slack',
  windowId: 41,
});
const closed = (extra = {}) => ({
  operation: 'close-members',
  status: 'ok',
  observedAt: '2026-01-01T00:00:00Z',
  before: { ...source(), dialogPresent: true },
  after: { ...source(), dialogPresent: false },
  channel: { id: 'CDEMO', name: 'demo', url: source().url },
  wasOpen: true,
  closed: true,
  closeAttempted: true,
  closeMayHaveBeenRequested: true,
  dialogMayBeOpen: false,
  verification: {
    dialogMatched: true,
    membersTabVerified: true,
    memberListVerified: true,
    controlVerified: true,
  },
  ...extra,
});
const noop = (extra = {}) =>
  closed({
    wasOpen: false,
    closed: false,
    closeAttempted: false,
    closeMayHaveBeenRequested: false,
    channel: null,
    verification: undefined,
    before: { ...source(), dialogPresent: false },
    ...extra,
  });

describe('close-members receipt verification', () => {
  test('returns the bound channel and explicit closure state in concise and semantic output', () => {
    const result = compactMembersClose(closed());
    expect(result).toMatchObject({
      operation: 'close-members',
      status: 'ok',
      closed: true,
      closeMayHaveBeenRequested: true,
      dialogMayBeOpen: false,
      channel: { name: 'demo', id: 'CDEMO', url: source().url },
    });
    expect(formatOutput(result)).toBe('Closed members dialog for #demo.');
    expect(JSON.parse(formatOutput(result, 'json'))).toEqual(result);
    expect(
      compactMembersClose(
        closed({
          after: {
            ...source(),
            title: 'demo (Channel) - Example - 2 new items - Slack',
            dialogPresent: false,
          },
        })
      ).status
    ).toBe('ok');
  });

  test('no open dialog is a verified no-op, including a non-conversation client view', () => {
    const before = {
      ...source(),
      url: 'https://app.slack.com/client/TDEMO/search',
      title: 'Search - Example - Slack',
      dialogPresent: false,
    };
    const result = compactMembersClose(
      noop({ before, after: { ...before, dialogPresent: false } })
    );
    expect(result).toMatchObject({
      wasOpen: false,
      closed: false,
      channel: null,
      dialogMayBeOpen: false,
    });
    expect(formatOutput(result)).toBe('No members dialog was open; nothing was closed.');
  });

  test('refuses changed source, unverified disappearance and contradictory input evidence', () => {
    const bad = [
      closed({ before: undefined }),
      closed({ before: { ...source(), dialogPresent: false } }),
      noop({ before: { ...source(), dialogPresent: true } }),
      closed({ after: undefined }),
      closed({ after: { ...source(), windowId: 42, dialogPresent: false } }),
      closed({
        after: {
          ...source(),
          url: 'https://app.slack.com/client/TOTHER/CDEMO',
          dialogPresent: false,
        },
      }),
      closed({
        after: {
          ...source(),
          url: 'https://app.slack.com/client/TDEMO/COTHER',
          dialogPresent: false,
        },
      }),
      closed({ after: { ...source(), dialogPresent: true } }),
      closed({ after: { ...source(), dialogPresent: null } }),
      closed({ before: { ...source(), windowId: '41' } }),
      closed({ before: { ...source(), url: 'https://example.com/client/TDEMO/CDEMO' } }),
      closed({ wasOpen: undefined }),
      closed({ closed: false }),
      closed({ closeAttempted: false }),
      closed({ closeMayHaveBeenRequested: false }),
      closed({ dialogMayBeOpen: true }),
      noop({ closed: true }),
      noop({ closeAttempted: true }),
      noop({ channel: closed().channel }),
      closed({ operation: 'members' }),
      closed({ status: 'partial' }),
      null,
    ];
    for (const receipt of bad) expect(() => compactMembersClose(receipt)).toThrow();
    expect(() => compactMembersClose(closed(), { code: 1 })).toThrow('native failure');
  });

  test('refuses foreign channels, DM identity, altered title or incomplete modal ownership', () => {
    const bad = [
      closed({ channel: null }),
      closed({ channel: { ...closed().channel, id: 'COTHER' } }),
      closed({ channel: { ...closed().channel, name: 'other' } }),
      closed({ channel: { ...closed().channel, id: 'DDEMO' } }),
      closed({ channel: { ...closed().channel, url: `${source().url}?foreign=true` } }),
      closed({ before: { ...source(), title: 'demo (DM) - Example - Slack' } }),
      closed({
        after: { ...source(), title: '! ! demo (Channel) - Example - Slack', dialogPresent: false },
      }),
      closed({ verification: undefined }),
      ...Object.keys(closed().verification).map((field) =>
        closed({ verification: { ...closed().verification, [field]: false } })
      ),
    ];
    for (const receipt of bad) expect(() => compactMembersClose(receipt)).toThrow();
  });

  test('stopped receipts retain known and unknown action/dialog state without claiming success', () => {
    const result = compactMembersClose({
      operation: 'close-members',
      status: 'stopped',
      error: 'Source changed',
      closeAttempted: true,
      closeMayHaveBeenRequested: true,
      dialogMayBeOpen: true,
    });
    expect(result).toMatchObject({
      status: 'stopped',
      closeMayHaveBeenRequested: true,
      dialogMayBeOpen: true,
    });
    expect(formatOutput(result)).toContain('A close may have been requested');
    expect(formatOutput(result)).toContain('members dialog may still be open');
    expect(JSON.parse(formatOutput(result, 'json'))).toEqual(result);
    const early = compactMembersClose({ status: 'stopped', error: 'No source' });
    expect(early.closeMayHaveBeenRequested).toBeNull();
    expect(early.dialogMayBeOpen).toBeNull();
    expect(formatOutput(early)).toContain('current dialog state is unknown');
    expect(
      stoppedMembersClose({ closeAttempted: true, closeMayHaveBeenRequested: false }, 'invalid')
        .closeMayHaveBeenRequested
    ).toBe(true);
  });
});

describe('close-members CLI constraints', () => {
  test('accepts only formats, lock timeout and explicit background mode', () => {
    expect(parseCLI(['close-members'])).toEqual({
      args: ['close-members'],
      interaction: 'background',
      format: 'text',
    });
    expect(
      parseCLI([
        '--format=full-json',
        'close-members',
        '--lock-timeout=10',
        '--interaction=background',
      ])
    ).toEqual({
      args: ['close-members'],
      interaction: 'background',
      format: 'full-json',
      lockTimeout: 10,
    });
    for (const extra of [
      'demo',
      '--pages=2',
      '--before=CDEMO:1700000000.000001',
      '--after=CDEMO:1700000000.000001',
      '--workspace=Demo',
      '--interaction=foreground',
      '--filter=x',
      '--search=x',
      '--allow-clipboard',
      '--since=2026-01-01',
      '--from=Example',
      '--output=/tmp/example',
      '--original',
      '--ui',
      '--prepare',
      '--request',
    ])
      expect(() => parseCLI(['close-members', extra])).toThrow();
  });
});

// Exercise the public wrapper with a synthetic native process and private lock.
// No Slack, native compilation, Accessibility API or live activity lease is used.
async function execute(
  receipt,
  format,
  nativeCode = 0,
  { raw, buildFailure = false, cancelAfterLaunch = false } = {}
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'slack-members-close-cli-'));
  try {
    const native = path.join(directory, 'native');
    const started = path.join(directory, 'started');
    atomicWriteFileSync(
      native,
      `#!${process.execPath}\n${cancelAfterLaunch ? `await Bun.write(${JSON.stringify(started)}, 'ready');\nawait Bun.sleep(10000);` : `console.log(${JSON.stringify(raw ?? JSON.stringify(receipt))});\nprocess.exit(${nativeCode});`}\n`
    );
    await chmod(native, 0o700);
    const builder = path.join(directory, 'builder.mjs');
    atomicWriteFileSync(
      builder,
      `export const SLACK_NATIVE_BUNDLE={},PUBLISHER_NATIVE_BUNDLE={};\nexport const captureNativeBundle=async()=>({});\nexport const buildNativeBundle=async()=>${buildFailure ? '{ throw new Error("Synthetic build failure"); }' : JSON.stringify(native)};\n`
    );
    const wrapper = path.join(directory, 'wrapper.mjs');
    const wrapperSource = (await readFile(new URL('./slack.mjs', import.meta.url), 'utf8'))
      .replace(
        "import { homedir } from 'node:os';",
        `const homedir=()=>${JSON.stringify(directory)};`
      )
      .replace("from './slack-native-build.mjs'", `from '${pathToFileURL(builder).href}'`)
      .replace(
        /from '(\.\/[^']+)'/g,
        (_, relative) => `from '${new URL(relative, import.meta.url).href}'`
      );
    atomicWriteFileSync(wrapper, wrapperSource);
    const child = Bun.spawn([process.execPath, wrapper, 'close-members', `--format=${format}`], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      if (cancelAfterLaunch) {
        const deadline = Date.now() + 3000;
        while (!(await Bun.file(started).exists())) {
          if (Date.now() > deadline) throw new Error('Synthetic native process did not start');
          await Bun.sleep(10);
        }
        child.kill('SIGTERM');
      }
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'darwin')('close-members public wrapper', () => {
  test.each(['text', 'json', 'full-json'])('valid closure succeeds in %s', async (format) => {
    const result = await execute(closed(), format);
    expect(result.code).toBe(0);
    if (format === 'text') expect(result.stdout).toContain('Closed members dialog for #demo.');
    else
      expect(JSON.parse(result.stdout)).toMatchObject({
        operation: 'close-members',
        status: 'ok',
        closed: true,
      });
  });
  test.each(['text', 'json', 'full-json'])(
    'forged closure cannot bypass validation in %s',
    async (format) => {
      const result = await execute(
        closed({ after: { ...source(), windowId: 99, dialogPresent: false } }),
        format
      );
      expect(result.code).toBe(1);
      if (format === 'text') expect(result.stderr).toContain('Stopped: Members close workspace');
      else {
        const output = JSON.parse(result.stdout);
        expect(output.status).toBe('stopped');
        expect(format === 'full-json' ? output.resolution : output).toMatchObject({
          closeMayHaveBeenRequested: true,
          dialogMayBeOpen: false,
        });
      }
    }
  );
  test.each(['text', 'json', 'full-json'])(
    'failed native exit cannot become success in %s',
    async (format) => {
      const result = await execute(closed(), format, 1);
      expect(result.code).toBe(1);
      if (format === 'text') expect(result.stderr).toContain('conflicts with native failure');
      else expect(JSON.parse(result.stdout).status).toBe('stopped');
    }
  );
  test.each(['text', 'json', 'full-json'])(
    'missing, malformed and cancelled native receipts retain unknown close state in %s',
    async (format) => {
      for (const options of [{ raw: '' }, { raw: 'not json' }, {}, { cancelAfterLaunch: true }]) {
        const result = await execute(null, format, 1, options);
        expect(result.code).toBe(1);
        if (format === 'text') {
          expect(result.stderr).toContain('Whether a close was requested is unknown.');
          expect(result.stderr).toContain('current dialog state is unknown');
          expect(result.stderr).toContain('no close is replayed');
        } else {
          expect(JSON.parse(result.stdout)).toMatchObject({
            operation: 'close-members',
            status: 'stopped',
            closeMayHaveBeenRequested: null,
            dialogMayBeOpen: null,
          });
        }
      }
    }
  );
  test.each(['text', 'json', 'full-json'])(
    'a known prelaunch failure retains no-close evidence in %s',
    async (format) => {
      const result = await execute(null, format, 1, { buildFailure: true });
      expect(result.code).toBe(1);
      if (format === 'text') expect(result.stderr).toContain('No close was requested.');
      else
        expect(JSON.parse(result.stdout)).toMatchObject({
          operation: 'close-members',
          status: 'stopped',
          closeMayHaveBeenRequested: false,
          dialogMayBeOpen: null,
        });
    }
  );
});
