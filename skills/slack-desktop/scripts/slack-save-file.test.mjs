import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const quarantine = '0081;00000000;Slack;00000000-0000-0000-0000-000000000001';
let directory,
  binary,
  cancelledDuringStaging,
  cancelledAfterPublish,
  corruptedAfterPublish,
  attributeGuards;

async function command(args) {
  const child = Bun.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  return stdout;
}

beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), 'slack-save-file-')));
  binary = path.join(directory, 'publisher');
  const source = await readFile(new URL('./slack-save-file.swift', import.meta.url), 'utf8');
  const build = async (name, text) => {
    const input = path.join(directory, `${name}.swift`);
    const output = path.join(directory, name);
    await writeFile(input, text, { mode: 0o600 });
    await command(['/usr/bin/xcrun', 'swiftc', input, '-o', output]);
    return output;
  };
  binary = await build('publisher', source);
  const guardBoundary = '\nvar receipt: [String: Any] = [';
  expect(source.split(guardBoundary)).toHaveLength(2);
  attributeGuards = await build(
    'publisher-attribute-guards',
    source.split(guardBoundary)[0] +
      String.raw`
let original: [String: Data] = ["com.apple.quarantine": Data([1, 2]), "com.apple.macl": Data([3, 4])]
func accepts(_ source: [String: Data], _ target: [String: Data]) -> Bool {
  (try? verifiedTargetAttributes(source, target)) != nil
}
var added = original
added["com.apple.provenance"] = Data(repeating: 7, count: 11)
var unknown = original
unknown["com.example.extra"] = Data([1])
var empty = added
empty["com.apple.provenance"] = Data()
var tooLarge = added
tooLarge["com.apple.provenance"] = Data(count: 4097)
var changedQuarantine = added
changedQuarantine["com.apple.quarantine"] = Data([9])
var changedMACL = added
changedMACL["com.apple.macl"] = Data([9])
var missingMACL = added
missingMACL.removeValue(forKey: "com.apple.macl")
var changedProvenance = added
changedProvenance["com.apple.provenance"] = Data([8])
let checks = [accepts(original, original), accepts(original, added),
  !accepts(original, unknown), !accepts(original, empty), !accepts(original, tooLarge),
  !accepts(original, changedQuarantine), !accepts(original, changedMACL), !accepts(original, missingMACL),
  accepts(added, added), !accepts(added, changedProvenance), !accepts(added, original)]
print(checks.allSatisfy { $0 } ? "11 attribute guards passed" : "attribute guards failed")
exit(checks.allSatisfy { $0 } ? 0 : 1)
`
  );
  // Faults are injected only into temporary test binaries. There is no public
  // bypass or timing flag in the production helper.
  const boundary = 'artifact["published"] = true';
  expect(source.split(boundary)).toHaveLength(2);
  const copyBoundary =
    'let expectedHash = try copyBytes(sourceFD, stagingFD, sourceIdentity.st_size)';
  expect(source.split(copyBoundary)).toHaveLength(2);
  cancelledDuringStaging = await build(
    'publisher-stage-cancelled',
    source.replace(copyBoundary, `${copyBoundary}\n  raise(SIGTERM)`)
  );
  cancelledAfterPublish = await build(
    'publisher-cancelled',
    source.replace(boundary, `${boundary}\n  raise(SIGTERM)`)
  );
  corruptedAfterPublish = await build(
    'publisher-corrupted',
    source.replace(
      boundary,
      `${boundary}\n  var changedByte: UInt8 = 255\n  _ = pwrite(stagingFD, &changedByte, 1, 0)`
    )
  );
}, 120000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function identity(file) {
  const value = await lstat(file, { bigint: true });
  return {
    device: value.dev.toString(),
    inode: value.ino.toString(),
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
  };
}

async function attachQuarantine(file) {
  await command(['/usr/bin/xattr', '-w', 'com.apple.quarantine', quarantine, file]);
}

async function parentIdentity(folder) {
  const { device, inode } = await identity(await realpath(folder));
  return { device, inode };
}

async function fixture({ quarantined = true, bytes = Buffer.from([0, 1, 2, 0, 255, 128]) } = {}) {
  const folder = await mkdtemp(path.join(directory, 'case-'));
  const sourcePath = path.join(folder, 'native-download.bin');
  const destination = path.join(folder, 'saved file=🦉.bin');
  await writeFile(sourcePath, bytes);
  if (quarantined) await attachQuarantine(sourcePath);
  const request = {
    sourcePath,
    destination,
    expectedSource: await identity(sourcePath),
    expectedParent: await parentIdentity(folder),
  };
  return { folder, bytes, request };
}

function start(request, executable = binary) {
  const child = Bun.spawn([executable], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(typeof request === 'string' ? request : JSON.stringify(request));
  child.stdin.end();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 65000);
  const result = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([code, stdout, stderr]) => {
    clearTimeout(timeout);
    expect(stderr).toBe('');
    return { code, receipt: JSON.parse(stdout) };
  });
  return { child, result };
}

async function noStaging(folder) {
  expect((await readdir(folder)).filter((name) => name.startsWith('.slack-save-'))).toEqual([]);
}

describe('filesystem-only Slack download publisher', () => {
  test('only new bounded OS provenance may supplement exact source attributes', async () => {
    expect((await command([attributeGuards])).trim()).toBe('11 attribute guards passed');
  });
  test('copies binary bytes with independent readback and exact extended attributes', async () => {
    const f = await fixture();
    await command([
      '/usr/bin/xattr',
      '-wx',
      'com.example.slack-save-test',
      '00010203ff80',
      f.request.sourcePath,
    ]);
    const original = await readFile(f.request.sourcePath);
    const attributeCount = (await command(['/usr/bin/xattr', f.request.sourcePath]))
      .split('\n')
      .filter(Boolean).length;
    const result = await start(f.request).result;
    expect(result.code).toBe(0);
    expect(result.receipt.status).toBe('ok');
    expect(result.receipt.artifact).toMatchObject({
      path: f.request.destination,
      published: true,
      verified: true,
      bytes: f.bytes.length,
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
      xattrCount: attributeCount,
      quarantinePreserved: true,
    });
    expect(result.receipt.verification).toEqual({
      sourceUnchanged: true,
      stagingReadBack: true,
      publishedReadBack: true,
      extendedAttributesPreserved: true,
      noOverwrite: true,
    });
    expect(await readFile(f.request.destination)).toEqual(original);
    expect(await readFile(f.request.sourcePath)).toEqual(original);
    expect((await lstat(f.request.destination)).mode & 0o777).toBe(0o600);
    expect(await identity(f.request.sourcePath)).toEqual(f.request.expectedSource);
    expect(
      (
        await command(['/usr/bin/xattr', '-p', 'com.apple.quarantine', f.request.destination])
      ).trim()
    ).toBe(quarantine);
    expect(
      (
        await command([
          '/usr/bin/xattr',
          '-px',
          'com.example.slack-save-test',
          f.request.destination,
        ])
      )
        .replace(/\s/g, '')
        .toLowerCase()
    ).toBe('00010203ff80');
    await noStaging(f.folder);
  });

  test('accepts an empty quarantined regular file and canonicalizes a pinned parent', async () => {
    const f = await fixture({ bytes: Buffer.alloc(0) });
    const actual = path.join(f.folder, 'actual');
    const alias = path.join(f.folder, 'alias');
    await mkdir(actual);
    await symlink(actual, alias);
    f.request.destination = path.join(alias, 'empty.bin');
    f.request.expectedParent = await parentIdentity(actual);
    const result = await start(f.request).result;
    expect(result.code).toBe(0);
    expect(result.receipt.artifact.path).toBe(path.join(actual, 'empty.bin'));
    expect(result.receipt.artifact.bytes).toBe(0);
    expect(result.receipt.artifact.sha256).toBe(createHash('sha256').digest('hex'));
    await noStaging(actual);
  });

  test('newly quarantined files retain exact source metadata while reporting OS-added provenance', async () => {
    const f = await fixture();
    await command([
      '/usr/bin/xattr',
      '-w',
      'com.apple.quarantine',
      quarantine.replace(/^0081/, '0002'),
      f.request.sourcePath,
    ]);
    const sourceNames = (await command(['/usr/bin/xattr', f.request.sourcePath]))
      .split('\n')
      .filter(Boolean)
      .sort();
    const sourceValues = new Map();
    for (const name of sourceNames)
      sourceValues.set(name, await command(['/usr/bin/xattr', '-px', name, f.request.sourcePath]));
    const result = await start(f.request).result;
    expect(result.code).toBe(0);
    const targetNames = (await command(['/usr/bin/xattr', f.request.destination]))
      .split('\n')
      .filter(Boolean)
      .sort();
    const added = targetNames.filter((name) => !sourceNames.includes(name));
    expect(added.every((name) => name === 'com.apple.provenance')).toBe(true);
    expect(result.receipt.artifact.systemAddedXattrs).toEqual(added);
    expect(result.receipt.artifact.xattrCount).toBe(targetNames.length);
    for (const [name, value] of sourceValues) {
      expect(await command(['/usr/bin/xattr', '-px', name, f.request.destination])).toBe(value);
      expect(await command(['/usr/bin/xattr', '-px', name, f.request.sourcePath])).toBe(value);
    }
    expect(await readFile(f.request.destination)).toEqual(f.bytes);
    await noStaging(f.folder);
  });

  test('existing files, directories and symlinks are never overwritten', async () => {
    for (const kind of ['file', 'directory', 'symlink']) {
      const f = await fixture();
      if (kind === 'file') await writeFile(f.request.destination, 'existing file');
      else if (kind === 'directory') await mkdir(f.request.destination);
      else await symlink(f.request.sourcePath, f.request.destination);
      const before = await lstat(f.request.destination);
      const result = await start(f.request).result;
      expect(result.code).toBe(1);
      expect(result.receipt.artifact).toMatchObject({ published: false, verified: false });
      expect(result.receipt.error).toContain('Destination already exists');
      expect((await lstat(f.request.destination)).ino).toBe(before.ino);
      if (kind === 'file')
        expect(await readFile(f.request.destination, 'utf8')).toBe('existing file');
      expect(await readFile(f.request.sourcePath)).toEqual(f.bytes);
      await noStaging(f.folder);
    }
  });

  test('source symlinks and mismatched completed-download identities stop before publication', async () => {
    const linked = await fixture();
    const link = path.join(linked.folder, 'source-link');
    await symlink(linked.request.sourcePath, link);
    const refused = await start({ ...linked.request, sourcePath: link }).result;
    expect(refused.code).toBe(1);
    expect(refused.receipt.artifact.published).toBe(false);
    for (const field of ['device', 'inode', 'size', 'mtimeNs']) {
      const f = await fixture();
      f.request.expectedSource[field] = (BigInt(f.request.expectedSource[field]) + 1n).toString();
      const result = await start(f.request).result;
      expect(result.code).toBe(1);
      expect(result.receipt.error).toContain('source identity changed');
      expect(await Bun.file(f.request.destination).exists()).toBe(false);
      await noStaging(f.folder);
    }
  });

  test('nonregular sources never enter a blocking copy or quarantine wait', async () => {
    for (const type of ['directory', 'fifo']) {
      const f = await fixture();
      const sourcePath = path.join(f.folder, type);
      if (type === 'directory') await mkdir(sourcePath);
      else await command(['/usr/bin/mkfifo', sourcePath]);
      const result = await start({
        ...f.request,
        sourcePath,
        expectedSource: await identity(sourcePath),
      }).result;
      expect(result.code).toBe(1);
      expect(result.receipt.error).toContain('Source must be a regular file');
      expect(result.receipt.artifact.published).toBe(false);
      await noStaging(f.folder);
    }
  });

  test('refuses oversize sparse files and malformed requests without publication', async () => {
    const large = await fixture();
    await truncate(large.request.sourcePath, 256 * 1024 * 1024 + 1);
    large.request.expectedSource = await identity(large.request.sourcePath);
    const result = await start(large.request).result;
    expect(result.receipt.error).toContain('exceeds 256 MiB');
    expect(result.receipt.artifact.published).toBe(false);
    const f = await fixture();
    for (const request of [
      'not json',
      ' '.repeat(32769),
      [],
      { ...f.request, destination: 'relative.bin' },
      { ...f.request, destination: '/tmp/injected\nname' },
      { ...f.request, destination: path.join(f.folder, 'absent', 'saved.bin') },
      { ...f.request, expectedSource: { ...f.request.expectedSource, size: '01' } },
      { ...f.request, expectedSource: { ...f.request.expectedSource, inode: 123 } },
      { ...f.request, expectedParent: undefined },
      { ...f.request, expectedParent: { ...f.request.expectedParent, inode: 123 } },
      { ...f.request, expectedParent: { ...f.request.expectedParent, device: '01' } },
      { ...f.request, expectedParent: { ...f.request.expectedParent, extra: '1' } },
      { ...f.request, overwrite: true },
    ]) {
      const failed = await start(request).result;
      expect(failed.code).toBe(1);
      expect(failed.receipt.artifact).toMatchObject({ published: false, verified: false });
    }
    await noStaging(f.folder);
  });

  test('waits for asynchronous quarantine before reading metadata or publishing', async () => {
    const f = await fixture({ quarantined: false });
    const running = start(f.request);
    await Bun.sleep(150);
    expect(await Bun.file(f.request.destination).exists()).toBe(false);
    await attachQuarantine(f.request.sourcePath);
    const result = await running.result;
    expect(result.code).toBe(0);
    expect(result.receipt.artifact.quarantinePreserved).toBe(true);
    await noStaging(f.folder);
  });

  test('a destination created after preflight wins without being overwritten', async () => {
    const f = await fixture({ quarantined: false });
    const running = start(f.request);
    await Bun.sleep(150);
    await writeFile(f.request.destination, 'racing destination');
    await attachQuarantine(f.request.sourcePath);
    const result = await running.result;
    expect(result.code).toBe(1);
    expect(result.receipt.error).toContain('without overwriting');
    expect(result.receipt.artifact.published).toBe(false);
    expect(await readFile(f.request.destination, 'utf8')).toBe('racing destination');
    await noStaging(f.folder);
  });

  test('a changed parent symlink cannot redirect a retained publication', async () => {
    const f = await fixture({ quarantined: false });
    const first = path.join(f.folder, 'first');
    const second = path.join(f.folder, 'second');
    const alias = path.join(f.folder, 'alias');
    await mkdir(first);
    await mkdir(second);
    await symlink(first, alias);
    f.request.destination = path.join(alias, 'saved.bin');
    f.request.expectedParent = await parentIdentity(first);
    const running = start(f.request);
    await Bun.sleep(150);
    await unlink(alias);
    await symlink(second, alias);
    await attachQuarantine(f.request.sourcePath);
    const result = await running.result;
    expect(result.code).toBe(1);
    expect(result.receipt.error).toContain('parent path changed');
    expect(await readdir(first)).toEqual([]);
    expect(await readdir(second)).toEqual([]);
  });

  test('parent replacement between wrapper preflight and publisher startup is rejected', async () => {
    const f = await fixture();
    const selected = path.join(f.folder, 'selected');
    const original = path.join(f.folder, 'original');
    await mkdir(selected);
    f.request.destination = path.join(selected, 'saved.bin');
    f.request.expectedParent = await parentIdentity(selected);
    await rename(selected, original);
    await mkdir(selected);
    const result = await start(f.request).result;
    expect(result.code).toBe(1);
    expect(result.receipt.error).toContain('changed since download preflight');
    expect(result.receipt.artifact.published).toBe(false);
    expect(await readdir(selected)).toEqual([]);
    expect(await readdir(original)).toEqual([]);
    expect(await readFile(f.request.sourcePath)).toEqual(f.bytes);
  });

  test('both parent device and inode must match the wrapper preflight', async () => {
    for (const field of ['device', 'inode']) {
      const f = await fixture();
      f.request.expectedParent[field] = (BigInt(f.request.expectedParent[field]) + 1n).toString();
      const result = await start(f.request).result;
      expect(result.code).toBe(1);
      expect(result.receipt.error).toContain('changed since download preflight');
      expect(result.receipt.artifact.published).toBe(false);
      await noStaging(f.folder);
    }
  });

  test('cancellation while waiting retains source and emits a stopped receipt', async () => {
    const f = await fixture({ quarantined: false });
    const running = start(f.request);
    await Bun.sleep(150);
    running.child.kill('SIGTERM');
    const result = await running.result;
    expect(result.code).toBe(1);
    expect(result.receipt.error).toContain('cancelled');
    expect(result.receipt.artifact).toMatchObject({ published: false, verified: false });
    expect(await readFile(f.request.sourcePath)).toEqual(f.bytes);
    expect(await Bun.file(f.request.destination).exists()).toBe(false);
    await noStaging(f.folder);
  });

  test('cancellation with a staged copy removes only the owned temporary file', async () => {
    const f = await fixture();
    const result = await start(f.request, cancelledDuringStaging).result;
    expect(result.code).toBe(1);
    expect(result.receipt.error).toContain('cancelled');
    expect(result.receipt.artifact).toMatchObject({ published: false, verified: false });
    expect(await Bun.file(f.request.destination).exists()).toBe(false);
    expect(await readFile(f.request.sourcePath)).toEqual(f.bytes);
    await noStaging(f.folder);
  });

  test('missing quarantine stops before staging with no source deletion', async () => {
    const f = await fixture({ quarantined: false });
    const result = await start(f.request).result;
    expect(result.code).toBe(1);
    expect(result.receipt.error).toContain('quarantine was not observed within 10 seconds');
    expect(result.receipt.artifact.published).toBe(false);
    expect(await readFile(f.request.sourcePath)).toEqual(f.bytes);
    expect(await Bun.file(f.request.destination).exists()).toBe(false);
    await noStaging(f.folder);
  }, 15000);

  test('cancellation and tampering after publication retain the artifact in failure receipts', async () => {
    for (const executable of [cancelledAfterPublish, corruptedAfterPublish]) {
      const f = await fixture();
      const result = await start(f.request, executable).result;
      expect(result.code).toBe(1);
      expect(result.receipt.status).toBe('stopped');
      expect(result.receipt.artifact).toMatchObject({
        path: f.request.destination,
        published: true,
        verified: false,
      });
      expect(result.receipt.error).toContain(
        executable === cancelledAfterPublish ? 'cancelled' : 'hash verification failed'
      );
      expect(result.receipt.next).toContain('was published');
      expect(await Bun.file(f.request.destination).exists()).toBe(true);
      expect(await readFile(f.request.sourcePath)).toEqual(f.bytes);
      await noStaging(f.folder);
    }
  });
});
