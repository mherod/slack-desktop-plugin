import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMMAND_ENTRY_POINT = '// MARK: - Command entry point';

function descriptor(value) {
  return Object.freeze({
    ...value,
    sources: Object.freeze(value.sources.map((source) => Object.freeze({ ...source }))),
    compilerArgs: Object.freeze([...value.compilerArgs]),
    compileTimeout: 60000,
    signTimeout: 10000,
  });
}

// Explicit membership prevents unrelated Swift files from becoming executable input.
export const SLACK_NATIVE_BUNDLE = descriptor({
  executable: 'slack',
  cachePrefix: '',
  sources: [
    { source: 'slack.swift', snapshot: 'main.swift' },
    { source: 'native/SlackAX.swift', snapshot: 'SlackAX.swift' },
    { source: 'native/SlackUI.swift', snapshot: 'SlackUI.swift' },
    { source: 'native/SlackInteraction.swift', snapshot: 'SlackInteraction.swift' },
    { source: 'native/SlackWorkspaces.swift', snapshot: 'SlackWorkspaces.swift' },
    { source: 'native/SlackViewerRecovery.swift', snapshot: 'SlackViewerRecovery.swift' },
    { source: 'native/SlackCompose.swift', snapshot: 'SlackCompose.swift' },
  ],
  compilerArgs: [
    '-swift-version',
    '5',
    '-O',
    '-framework',
    'AppKit',
    '-framework',
    'ApplicationServices',
  ],
});

export const PUBLISHER_NATIVE_BUNDLE = descriptor({
  executable: 'slack-save-file',
  cachePrefix: 'publisher-',
  sources: [{ source: 'slack-save-file.swift', snapshot: 'main.swift' }],
  compilerArgs: ['-swift-version', '5', '-O'],
});

function validateDescriptor(bundle) {
  if (
    !/^[A-Za-z0-9-]+$/.test(bundle.executable) ||
    !/^[A-Za-z0-9-]*$/.test(bundle.cachePrefix) ||
    !Array.isArray(bundle.compilerArgs) ||
    !bundle.compilerArgs.every(
      (argument) => typeof argument === 'string' && !argument.includes('\0')
    ) ||
    !Number.isSafeInteger(bundle.compileTimeout) ||
    bundle.compileTimeout <= 0 ||
    !Number.isSafeInteger(bundle.signTimeout) ||
    bundle.signTimeout <= 0 ||
    !Array.isArray(bundle.sources) ||
    bundle.sources.length === 0 ||
    bundle.sources.some(
      ({ source, snapshot }) =>
        typeof source !== 'string' ||
        !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.swift$/.test(source) ||
        typeof snapshot !== 'string' ||
        !/^[A-Za-z0-9_-]+\.swift$/.test(snapshot)
    ) ||
    new Set(bundle.sources.map(({ source }) => source)).size !== bundle.sources.length ||
    new Set(bundle.sources.map(({ snapshot }) => snapshot)).size !== bundle.sources.length ||
    bundle.sources.filter(({ snapshot }) => snapshot === 'main.swift').length !== 1
  )
    throw new Error('Invalid native source bundle manifest');
}

function frame(hash, bytes) {
  const value = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(value.length));
  hash.update(size).update(value);
}

function capturedBundle(recipe, platform, sources) {
  const frozenRecipe = Object.freeze({
    ...recipe,
    compilerArgs: Object.freeze([...recipe.compilerArgs]),
  });
  const frozenPlatform = Object.freeze({ ...platform });
  const frozenSources = Object.freeze(sources.map((source) => Object.freeze({ ...source })));
  const hash = createHash('sha256');
  frame(hash, 'slack-native-bundle-v1');
  frame(hash, JSON.stringify(frozenRecipe));
  frame(hash, JSON.stringify(frozenPlatform));
  frame(hash, String(frozenSources.length));
  for (const source of frozenSources) {
    frame(hash, source.source);
    frame(hash, source.snapshot);
    frame(hash, Buffer.from(source.base64, 'base64'));
  }
  return Object.freeze({
    recipe: frozenRecipe,
    platform: frozenPlatform,
    sources: frozenSources,
    hash: hash.digest('hex'),
  });
}

export async function captureNativeBundle(
  bundle,
  {
    root = new URL('.', import.meta.url),
    arch = process.arch,
    osRelease = release(),
    checkCancelled = () => {},
  } = {}
) {
  validateDescriptor(bundle);
  checkCancelled();
  const directory = root instanceof URL ? fileURLToPath(root) : root;
  const sources = [];
  for (const member of bundle.sources) {
    checkCancelled();
    const bytes = await readFile(path.join(directory, member.source));
    checkCancelled();
    // Immutable strings keep later caller/source edits from changing hashed input.
    sources.push({ ...member, base64: bytes.toString('base64') });
  }
  const { sources: _sources, ...recipe } = bundle;
  return capturedBundle(recipe, { arch, osRelease }, sources);
}

export function nativeGuardBundle(bundle, assertions, moduleCache) {
  const main = bundle.sources.find(
    (source) => source.source === 'slack.swift' && source.snapshot === 'main.swift'
  );
  if (!main) throw new Error('Native guard bundle requires the Slack entry source');
  const source = Buffer.from(main.base64, 'base64').toString('utf8');
  const marker = `\n${COMMAND_ENTRY_POINT}\n`;
  const parts = source.split(marker);
  if (parts.length !== 2 || !parts[1].startsWith('do {\n'))
    throw new Error('Native guard source requires one explicit command entry point');
  const replacement = Buffer.from(parts[0] + '\n' + assertions).toString('base64');
  return capturedBundle(
    {
      ...bundle.recipe,
      compilerArgs: [
        ...bundle.recipe.compilerArgs.filter((argument) => argument !== '-O'),
        '-module-cache-path',
        moduleCache,
      ],
      compileTimeout: 120000,
    },
    bundle.platform,
    bundle.sources.map((member) => (member === main ? { ...member, base64: replacement } : member))
  );
}

export async function writeNativeSnapshot(bundle, directory, checkCancelled = () => {}) {
  const inputs = [];
  for (const source of bundle.sources) {
    checkCancelled();
    const input = path.join(directory, source.snapshot);
    await writeFile(input, Buffer.from(source.base64, 'base64'), { mode: 0o600, flag: 'wx' });
    inputs.push(input);
  }
  checkCancelled();
  return inputs;
}

export function nativeCompileCommand(bundle, inputs, binary) {
  return ['/usr/bin/xcrun', 'swiftc', ...bundle.recipe.compilerArgs, ...inputs, '-o', binary];
}

// The caller holds the shared Slack lease and owns process cancellation/deadlines.
export async function buildNativeBundle(bundle, cache, { run, checkCancelled }) {
  checkCancelled();
  const directory = path.join(cache, `${bundle.recipe.cachePrefix}${bundle.hash}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binary = path.join(directory, bundle.recipe.executable);
  const exists = await Bun.file(binary).exists();
  checkCancelled();
  if (exists) return binary;
  const buildDirectory = await mkdtemp(path.join(directory, 'build-'));
  try {
    const inputs = await writeNativeSnapshot(bundle, buildDirectory, checkCancelled);
    const temporary = path.join(buildDirectory, bundle.recipe.executable);
    await run(nativeCompileCommand(bundle, inputs, temporary), bundle.recipe.compileTimeout);
    checkCancelled();
    await run(
      ['/usr/bin/codesign', '--force', '--sign', '-', temporary],
      bundle.recipe.signTimeout
    );
    checkCancelled();
    await rename(temporary, binary);
    return binary;
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }
}
