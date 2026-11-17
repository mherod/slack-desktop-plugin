import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  foregroundEvidence,
  membersMaxSeconds,
  nativeCommandArgs,
  nativeInteractionArgs,
} from './slack-interaction.mjs';
import { saveMedia } from './slack-save-runner.mjs';

test('native command arguments keep flag order, then the interaction and workspace prefixes', () => {
  expect(
    nativeCommandArgs({
      args: ['read-dm', 'Alex Example'],
      page: { direction: 'older', cursor: 'DDEMO:1700000000.000000' },
      pages: 3,
      since: { epoch: 1700000000 },
      allowClipboard: true,
      interaction: 'foreground',
      workspaceTarget: 'Example Team',
    })
  ).toEqual([
    '--interaction=foreground',
    '--workspace=Example Team',
    'read-dm',
    'Alex Example',
    '--before=DDEMO:1700000000.000000',
    '--pages=3',
    '--since=1700000000',
    '--allow-clipboard',
  ]);
  expect(
    nativeCommandArgs({
      args: ['send', '@alex'],
      allowClipboard: true,
      textTranslation: { submittedText: 'hi :wave:' },
    })
  ).toEqual(['send', '@alex', '--allow-clipboard', '--text=hi :wave:']);
  expect(
    nativeCommandArgs({
      args: ['inspect'],
      ui: { filter: '', limit: 80, depth: 20, prepare: true },
      workspaceTarget: undefined,
    })
  ).toEqual(['inspect', '--ui', '--filter=', '--limit=80', '--depth=20', '--prepare']);
  expect(
    nativeCommandArgs({ args: ['read-channel', 'general'], pages: 1, since: { epoch: 1 } })
  ).toEqual(['read-channel', 'general', '--pages=1']);
});

test('members gets a default collection budget that --max-seconds overrides', () => {
  expect(membersMaxSeconds({ args: ['members', 'general'] })).toBe(160);
  expect(membersMaxSeconds({ args: ['members', 'general'], pages: 2 })).toBe(70);
  expect(membersMaxSeconds({ args: ['members', 'general'], pages: 2, maxSeconds: 30 })).toBe(30);
  expect(membersMaxSeconds({ args: ['read-channel', 'general'], maxSeconds: 30 })).toBeUndefined();
  expect(nativeCommandArgs({ args: ['members', 'general'] })).toEqual([
    'members',
    'general',
    '--max-seconds=160',
  ]);
});

test('native mode prefix preserves query position and page/clipboard arguments', () => {
  const args = ['search', '--interaction=foreground', '--pages=3'];
  expect(nativeInteractionArgs(args)).toEqual(args);
  expect(nativeInteractionArgs(args, 'foreground')).toEqual(['--interaction=foreground', ...args]);
  expect(args).toEqual(['search', '--interaction=foreground', '--pages=3']);
  expect(nativeInteractionArgs(['read-dm', '@example', '--allow-clipboard'], 'foreground')).toEqual(
    ['--interaction=foreground', 'read-dm', '@example', '--allow-clipboard']
  );
  expect(nativeInteractionArgs(['switch-workspace', 'EEXAMPLE'])).toEqual([
    'switch-workspace',
    'EEXAMPLE',
  ]);
  expect(nativeInteractionArgs(['switch-workspace', 'EEXAMPLE'], 'foreground')).toEqual([
    '--interaction=foreground',
    'switch-workspace',
    'EEXAMPLE',
  ]);
  for (const command of [
    'inspect',
    'read-media',
    'permissions',
    'workspaces',
    'current-workspace',
    '--help',
    'unknown',
  ]) {
    expect(() => nativeInteractionArgs([command], 'foreground')).toThrow();
  }
  for (const mode of ['auto', '', null]) {
    expect(() => nativeInteractionArgs(['search', 'example'], mode)).toThrow();
  }
});

test('protocol errors retain observed activation without claiming completion or restoration', () => {
  const preflight = { interaction: { mode: 'foreground', state: 'activated', activated: true } };
  const final = { mode: 'foreground', state: 'failed', activated: true };
  for (const key of [
    'preflight',
    'sourcePreflight',
    'viewerPreflight',
    'started',
    'nativeResult',
  ]) {
    expect(foregroundEvidence({ [key]: preflight })).toEqual(preflight.interaction);
  }
  expect(foregroundEvidence({ preflight, interaction: final })).toEqual(final);
  expect(foregroundEvidence({ preflight, nativeResult: { interaction: final } })).toEqual(final);
  for (const receipt of [null, {}, { preflight: { status: 'stopped' } }]) {
    expect(foregroundEvidence(receipt)).toEqual({
      mode: 'foreground',
      state: 'unknown',
      activationRequested: null,
      activated: null,
      focusRestoration: 'none',
    });
  }
});

const folders = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))
  );
});

for (const interaction of ['background', 'foreground']) {
  test(`save runner launches exactly once in ${interaction} mode after a stopped receipt`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'slack-interaction-test-'));
    folders.push(directory);
    const binary = path.join(directory, 'native.mjs');
    const log = path.join(directory, 'calls.jsonl');
    await writeFile(
      binary,
      `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log(JSON.stringify({operation:'save-media',status:'stopped',error:'fixture refusal'}));\nprocess.exitCode=1;\n`
    );
    await chmod(binary, 0o700);
    const result = await saveMedia({
      binary,
      publisher: path.join(directory, 'unused-publisher'),
      requested: 'FDEMO',
      output: path.join(directory, 'unused.bin'),
      mediaCache: path.join(directory, 'absent-cache'),
      statePath: path.join(directory, 'unused-state'),
      interaction,
    });
    expect(result.code).toBe(1);
    expect(result.compact.status).toBe('stopped');
    expect((await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)).toEqual([
      nativeInteractionArgs(['save-media', 'FDEMO'], interaction),
    ]);
  });
}
