import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  COMMAND_ENTRY_POINT,
  SLACK_NATIVE_BUNDLE,
  PUBLISHER_NATIVE_BUNDLE,
  captureNativeBundle,
  nativeGuardBundle,
  writeNativeSnapshot,
  nativeCompileCommand,
  buildNativeBundle,
} from './slack-native-build.mjs';

const directories = new Set();
afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'slack-native-build-'));
  directories.add(directory);
  const root = path.join(directory, 'source');
  const cache = path.join(directory, 'cache');
  await mkdir(path.join(root, 'native'), { recursive: true });
  const contents = {
    'slack.swift': `import Foundation\nlet retained = "declaration"\n${COMMAND_ENTRY_POINT}\ndo {\n  print("CLI MUST NOT RUN")\n  do { print("nested CLI block") }\n}\n`,
    'native/SlackAX.swift': 'func axUtility() -> String { "AX" }\n',
    'native/SlackUI.swift': 'func uiUtility() -> String { "UI" }\n',
    'native/SlackInteraction.swift': 'func interactionUtility() -> String { "interaction" }\n',
    'native/SlackWorkspaces.swift': 'func workspaceUtility() -> String { "workspace" }\n',
    'native/SlackViewerRecovery.swift': 'func viewerRecoveryUtility() -> String { "viewer" }\n',
    'native/SlackCompose.swift': 'func composeUtility() -> String { "compose" }\n',
    'slack-save-file.swift': 'print("publisher")\n',
  };
  for (const [source, content] of Object.entries(contents))
    await writeFile(path.join(root, source), content);
  const calls = [];
  let cancelled = false;
  const checkCancelled = () => {
    if (cancelled) throw new Error('cancelled');
  };
  const capture = (bundle = SLACK_NATIVE_BUNDLE, options = {}) =>
    captureNativeBundle(bundle, {
      root,
      arch: 'test-arch',
      osRelease: 'test-release',
      checkCancelled,
      ...options,
    });
  const run = async (command, timeout) => {
    calls.push({ command, timeout });
    if (command[0] === '/usr/bin/xcrun')
      await writeFile(command.at(-1), 'compiled', { mode: 0o700 });
    else {
      expect(command.slice(0, -1)).toEqual(['/usr/bin/codesign', '--force', '--sign', '-']);
      expect(await readFile(command.at(-1), 'utf8')).toBe('compiled');
      await writeFile(command.at(-1), 'signed');
    }
  };
  return {
    directory,
    root,
    cache,
    contents,
    calls,
    capture,
    run,
    checkCancelled,
    cancel: () => {
      cancelled = true;
    },
  };
}

test.each([SLACK_NATIVE_BUNDLE, PUBLISHER_NATIVE_BUNDLE])(
  'cold build and warm reuse for $executable',
  async (descriptor) => {
    const f = await fixture();
    const bundle = await f.capture(descriptor);
    const binary = await buildNativeBundle(bundle, f.cache, f);
    expect(await readFile(binary, 'utf8')).toBe('signed');
    expect(f.calls.map(({ timeout }) => timeout)).toEqual([60000, 10000]);
    const inputs = f.calls[0].command.filter((argument) => argument.endsWith('.swift'));
    expect(inputs.map((input) => path.basename(input))).toEqual(
      descriptor.sources.map(({ snapshot }) => snapshot)
    );
    expect(f.calls[0].command).toEqual([
      '/usr/bin/xcrun',
      'swiftc',
      ...descriptor.compilerArgs,
      ...inputs,
      '-o',
      f.calls[0].command.at(-1),
    ]);
    expect(inputs.every((input) => input.startsWith(path.dirname(binary) + path.sep))).toBe(true);
    expect(inputs.some((input) => input.startsWith(f.root + path.sep))).toBe(false);
    expect(await readdir(path.dirname(binary))).toEqual([descriptor.executable]);
    expect((await stat(path.dirname(binary))).mode & 0o777).toBe(0o700);
    expect(await buildNativeBundle(await f.capture(descriptor), f.cache, f)).toBe(binary);
    expect(f.calls).toHaveLength(2);
  }
);

test.each([
  ...SLACK_NATIVE_BUNDLE.sources.map(({ source }) => [SLACK_NATIVE_BUNDLE, source]),
  [PUBLISHER_NATIVE_BUNDLE, 'slack-save-file.swift'],
])('changing any native source invalidates its bundle: %s %s', async (descriptor, source) => {
  const f = await fixture();
  const before = await f.capture(descriptor);
  const otherDescriptor =
    descriptor === SLACK_NATIVE_BUNDLE ? PUBLISHER_NATIVE_BUNDLE : SLACK_NATIVE_BUNDLE;
  const other = await f.capture(otherDescriptor);
  await writeFile(path.join(f.root, source), f.contents[source] + '// changed\n');
  const after = await f.capture(descriptor);
  expect(after.hash).not.toBe(before.hash);
  expect((await f.capture(otherDescriptor)).hash).toBe(other.hash);
});

test.each([
  [
    'compiler arguments',
    (bundle) => {
      bundle.compilerArgs.push('-DCHANGED');
    },
  ],
  [
    'executable',
    (bundle) => {
      bundle.executable = 'different';
    },
  ],
  [
    'cache namespace',
    (bundle) => {
      bundle.cachePrefix = 'different-';
    },
  ],
  [
    'compile budget',
    (bundle) => {
      bundle.compileTimeout += 1;
    },
  ],
  [
    'sign budget',
    (bundle) => {
      bundle.signTimeout += 1;
    },
  ],
  [
    'snapshot filename',
    (bundle) => {
      bundle.sources[1].snapshot = 'OtherAX.swift';
    },
  ],
  [
    'source order',
    (bundle) => {
      [bundle.sources[1], bundle.sources[2]] = [bundle.sources[2], bundle.sources[1]];
    },
  ],
])('build recipe changes invalidate the cache: %s', async (_name, mutate) => {
  const f = await fixture();
  const before = await f.capture();
  const descriptor = structuredClone(SLACK_NATIVE_BUNDLE);
  mutate(descriptor);
  expect((await f.capture(descriptor)).hash).not.toBe(before.hash);
});

test.each([{ arch: 'other-arch' }, { osRelease: 'other-release' }])(
  'platform changes invalidate the cache: %j',
  async (platform) => {
    const f = await fixture();
    expect((await f.capture(SLACK_NATIVE_BUNDLE, platform)).hash).not.toBe(
      (await f.capture()).hash
    );
  }
);

test('source names and byte boundaries are part of the digest', async () => {
  const f = await fixture();
  const descriptor = structuredClone(SLACK_NATIVE_BUNDLE);
  const before = await f.capture();
  descriptor.sources[1].source = 'native/OtherAX.swift';
  await writeFile(path.join(f.root, 'native/OtherAX.swift'), f.contents['native/SlackAX.swift']);
  expect((await f.capture(descriptor)).hash).not.toBe(before.hash);
  await writeFile(path.join(f.root, 'native/SlackAX.swift'), 'a');
  await writeFile(path.join(f.root, 'native/SlackUI.swift'), 'bc');
  const firstBoundary = await f.capture();
  await writeFile(path.join(f.root, 'native/SlackAX.swift'), 'ab');
  await writeFile(path.join(f.root, 'native/SlackUI.swift'), 'c');
  expect((await f.capture()).hash).not.toBe(firstBoundary.hash);
});

test('captured bytes remain immutable and compile after later source edits', async () => {
  const f = await fixture();
  const bundle = await f.capture();
  const digest = bundle.hash;
  expect(() => {
    bundle.sources[0].base64 = '';
  }).toThrow();
  expect(() => {
    bundle.recipe.compilerArgs.push('-DCHANGED');
  }).toThrow();
  for (const { source } of bundle.sources)
    await writeFile(path.join(f.root, source), 'changed after capture');
  const binary = await buildNativeBundle(bundle, f.cache, {
    checkCancelled: f.checkCancelled,
    run: async (command, timeout) => {
      if (command[0] === '/usr/bin/xcrun') {
        const inputs = command.filter((argument) => argument.endsWith('.swift'));
        for (const [index, input] of inputs.entries()) {
          expect(await readFile(input, 'utf8')).toBe(f.contents[bundle.sources[index].source]);
          expect((await stat(input)).mode & 0o777).toBe(0o600);
        }
      }
      await f.run(command, timeout);
    },
  });
  expect(bundle.hash).toBe(digest);
  expect(binary).toContain(digest);
  expect((await f.capture()).hash).not.toBe(digest);
});

test('explicit source inventory ignores unrelated and hidden Swift files', async () => {
  const f = await fixture();
  const before = await f.capture();
  for (const source of ['native/Unreviewed.swift', 'native/.hidden.swift', 'Other.swift'])
    await writeFile(path.join(f.root, source), 'fatalError("must never compile")');
  const after = await f.capture();
  expect(after.hash).toBe(before.hash);
  expect(after.sources.map(({ source }) => source)).toEqual([
    'slack.swift',
    'native/SlackAX.swift',
    'native/SlackUI.swift',
    'native/SlackInteraction.swift',
    'native/SlackWorkspaces.swift',
    'native/SlackViewerRecovery.swift',
    'native/SlackCompose.swift',
  ]);
  await buildNativeBundle(after, f.cache, f);
  expect(
    f.calls[0].command
      .filter((argument) => argument.endsWith('.swift'))
      .map((input) => path.basename(input))
  ).toEqual([
    'main.swift',
    'SlackAX.swift',
    'SlackUI.swift',
    'SlackInteraction.swift',
    'SlackWorkspaces.swift',
    'SlackViewerRecovery.swift',
    'SlackCompose.swift',
  ]);
});

test.each([
  ['compile failure', 'compile', false],
  ['sign failure', 'sign', false],
  ['cancel after compile', 'compile', true],
  ['cancel after sign', 'sign', true],
])('%s never publishes and removes every build artifact', async (_name, stopAt, cancel) => {
  const f = await fixture();
  const bundle = await f.capture();
  await expect(
    buildNativeBundle(bundle, f.cache, {
      checkCancelled: f.checkCancelled,
      run: async (command, timeout) => {
        await f.run(command, timeout);
        if ((command[0] === '/usr/bin/xcrun' ? 'compile' : 'sign') === stopAt) {
          if (cancel) f.cancel();
          else throw new Error('simulated build failure');
        }
      },
    })
  ).rejects.toThrow(cancel ? 'cancelled' : 'simulated build failure');
  expect(await readdir(path.join(f.cache, bundle.hash))).toEqual([]);
  expect(f.calls).toHaveLength(stopAt === 'compile' ? 1 : 2);
});

test('pre-cancelled capture and cold build start no work', async () => {
  const f = await fixture();
  const bundle = await f.capture();
  f.cancel();
  await expect(
    f.capture(SLACK_NATIVE_BUNDLE, { root: path.join(f.directory, 'absent') })
  ).rejects.toThrow('cancelled');
  await expect(buildNativeBundle(bundle, f.cache, f)).rejects.toThrow('cancelled');
  expect(f.calls).toHaveLength(0);
  expect(await Bun.file(path.join(f.cache, bundle.hash, 'slack')).exists()).toBe(false);
});

test('a warm cache does not bypass cancellation', async () => {
  const f = await fixture();
  const bundle = await f.capture();
  await buildNativeBundle(bundle, f.cache, f);
  f.cancel();
  await expect(buildNativeBundle(bundle, f.cache, f)).rejects.toThrow('cancelled');
  expect(f.calls).toHaveLength(2);
});

test.each([
  [
    'source traversal',
    (bundle) => {
      bundle.sources[1].source = '../outside.swift';
    },
  ],
  [
    'absolute source',
    (bundle) => {
      bundle.sources[1].source = '/outside.swift';
    },
  ],
  [
    'snapshot traversal',
    (bundle) => {
      bundle.sources[1].snapshot = '../outside.swift';
    },
  ],
  [
    'duplicated source',
    (bundle) => {
      bundle.sources[1].source = bundle.sources[0].source;
    },
  ],
  [
    'duplicated snapshot',
    (bundle) => {
      bundle.sources[1].snapshot = 'main.swift';
    },
  ],
  [
    'missing main',
    (bundle) => {
      bundle.sources[0].snapshot = 'slack.swift';
    },
  ],
  [
    'cache traversal',
    (bundle) => {
      bundle.cachePrefix = '../';
    },
  ],
])('rejects malformed manifest: %s', async (_name, mutate) => {
  const f = await fixture();
  const descriptor = structuredClone(SLACK_NATIVE_BUNDLE);
  mutate(descriptor);
  await expect(f.capture(descriptor)).rejects.toThrow('Invalid native source bundle manifest');
});

test.each(SLACK_NATIVE_BUNDLE.sources)(
  'missing $source cannot use an existing bundle; symlinks preserve readFile behavior',
  async ({ source: member }) => {
    const f = await fixture();
    const bundle = await f.capture();
    await buildNativeBundle(bundle, f.cache, f);
    const source = path.join(f.root, member);
    await rm(source);
    await expect(f.capture()).rejects.toThrow();
    await symlink(path.join(f.root, 'slack-save-file.swift'), source);
    const linked = await f.capture();
    expect(
      Buffer.from(linked.sources.find(({ source }) => source === member).base64, 'base64').toString(
        'utf8'
      )
    ).toBe(f.contents['slack-save-file.swift']);
    expect(linked.hash).not.toBe(bundle.hash);
    expect(f.calls).toHaveLength(2);
  }
);

test('guard bundle replaces only the explicit CLI entry and preserves utility bytes', async () => {
  const f = await fixture();
  const bundle = await f.capture();
  const moduleCache = path.join(f.directory, 'modules');
  const guards = nativeGuardBundle(bundle, 'print("guard assertions")\n', moduleCache);
  const snapshots = path.join(f.directory, 'snapshot');
  await mkdir(snapshots);
  const inputs = await writeNativeSnapshot(guards, snapshots);
  expect(await readFile(inputs[0], 'utf8')).toBe(
    'import Foundation\nlet retained = "declaration"\nprint("guard assertions")\n'
  );
  expect(guards.sources.slice(1)).toEqual(bundle.sources.slice(1));
  expect(guards.hash).not.toBe(bundle.hash);
  expect(guards.recipe.compileTimeout).toBe(120000);
  expect(nativeCompileCommand(guards, inputs, path.join(f.directory, 'checks'))).toEqual([
    '/usr/bin/xcrun',
    'swiftc',
    '-swift-version',
    '5',
    '-framework',
    'AppKit',
    '-framework',
    'ApplicationServices',
    '-module-cache-path',
    moduleCache,
    ...inputs,
    '-o',
    path.join(f.directory, 'checks'),
  ]);
  expect(Buffer.from(bundle.sources[0].base64, 'base64').toString('utf8')).toContain(
    'CLI MUST NOT RUN'
  );
});

test.each([
  ['absent marker', 'let retained = 1\ndo { print("CLI") }\n'],
  [
    'duplicate marker',
    `let retained = 1\n${COMMAND_ENTRY_POINT}\ndo {}\n${COMMAND_ENTRY_POINT}\ndo {}\n`,
  ],
  ['wrong boundary', `let retained = 1\n${COMMAND_ENTRY_POINT}\nfunc wrongBoundary() {}\n`],
])('guard compilation refuses %s', async (_name, source) => {
  const f = await fixture();
  await writeFile(path.join(f.root, 'slack.swift'), source);
  const bundle = await f.capture();
  expect(() =>
    nativeGuardBundle(bundle, 'print("test")', path.join(f.directory, 'modules'))
  ).toThrow('one explicit command entry point');
});
