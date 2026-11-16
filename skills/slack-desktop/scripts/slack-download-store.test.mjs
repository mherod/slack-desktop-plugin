import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseObservedDownloadURL,
  parseViewerSourceURL,
  pinDownloadDirectory,
  prepareDownloadState,
  prepareViewerDownloadState,
  projectDownloadState,
  readDownloadState,
  waitForDownload,
  waitForViewerDownload,
} from './slack-download-store.mjs';

const identity = { teamId: 'TDEMO', fileId: 'FDEMO' };
const url = 'https://files.slack.com/files-pri/TDEMO-FDEMO/download/example.mp4';
const sentinel = 'ENCRYPTED_SYNTHETIC_SENTINEL_NOT_TO_BE_DECODED';
const folders = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))
  );
});
const record = (extra = {}) => ({
  id: 'FDEMO',
  teamId: 'TDEMO',
  userId: 'PRIVATE_USER',
  url,
  startTime: Date.now() - 20000,
  downloadState: 'completed',
  endTime: Date.now() - 10000,
  progress: 1,
  ...extra,
});
const document = (directory = '/tmp/example-downloads', download = null, contextId = 'TDEMO') => ({
  credentials: { encrypted: sentinel, nested: [sentinel, { token: sentinel }] },
  settings: { PrefSSBFileDownloadPath: directory, userChoices: { secret: sentinel } },
  downloads: {
    TOTHER: { FOTHER: { secret: sentinel } },
    [contextId]: { FOTHER: { secret: sentinel }, ...(download ? { FDEMO: download } : {}) },
  },
});
const project = (value) =>
  projectDownloadState(
    Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    identity
  );

async function fixture(download = null, contextId = 'TDEMO') {
  const folder = await mkdtemp(path.join(tmpdir(), 'slack-download-store-'));
  folders.push(folder);
  const directory = path.join(folder, 'downloads'),
    statePath = path.join(folder, 'root-state.json');
  await mkdir(directory, { mode: 0o700 });
  let sequence = 0;
  const write = async (value = download, configured = directory) => {
    const temporary = path.join(folder, `state-${sequence++}.json`);
    await writeFile(temporary, JSON.stringify(document(configured, value, contextId)), {
      mode: 0o600,
    });
    await rename(temporary, statePath);
  };
  await write();
  return { folder, directory, statePath, write };
}
async function ready(download = null, contextId = 'TDEMO') {
  const f = await fixture(download, contextId);
  const prepared = await prepareDownloadState(f.statePath, { url, contextId });
  return { ...f, prepared, startedAt: Date.now() };
}
const wait = (f, options = {}) =>
  waitForDownload(f.statePath, {
    ...f.prepared,
    startedAt: f.startedAt,
    timeoutMs: 1000,
    pollIntervalMs: 5,
    ...options,
  });
async function complete(f, overrides = {}) {
  const downloadPath = path.join(f.directory, 'example.mp4');
  await writeFile(downloadPath, 'synthetic downloaded bytes', { mode: 0o600 });
  const value = record({ startTime: f.startedAt, endTime: Date.now(), downloadPath, ...overrides });
  await f.write(value);
  return value;
}

describe('selective download state projection', () => {
  test('materializes only the configured directory and allowlisted selected record', () => {
    const result = project(
      document('/tmp/example', record({ appVersion: 'private', requestState: sentinel }))
    );
    expect(result.directory).toBe('/tmp/example');
    expect(result.download).toMatchObject({
      id: 'FDEMO',
      teamId: 'TDEMO',
      url,
      downloadState: 'completed',
    });
    expect(Object.keys(result.download).sort()).toEqual(
      ['id', 'teamId', 'url', 'startTime', 'endTime', 'downloadState', 'progress'].sort()
    );
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_USER');
  });
  test('never JSON-decodes skipped credential values or the root document', () => {
    const encoded = Buffer.from(JSON.stringify(document('/tmp/example', record())));
    const original = JSON.parse,
      decoded = [];
    try {
      JSON.parse = (value, ...args) => {
        decoded.push(value);
        if (value.includes(sentinel) || value.startsWith('{'))
          throw Error('Private/root decoding attempted');
        return original(value, ...args);
      };
      expect(projectDownloadState(encoded, identity).download.id).toBe('FDEMO');
    } finally {
      JSON.parse = original;
    }
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.every((value) => !value.includes(sentinel))).toBe(true);
  });
  test('missing settings and selected downloads remain explicitly unknown', () => {
    expect(project({})).toEqual({ directory: null, download: null });
    expect(project(document())).toEqual({ directory: '/tmp/example-downloads', download: null });
  });
  test('rejects duplicate keys even in skipped branches and escaped equivalent keys', () => {
    for (const input of [
      '{"x":1,"x":2}',
      '{"x":{"a":1,"a":2}}',
      '{"x":{"a":1,"\\u0061":2}}',
      '{"settings":{"PrefSSBFileDownloadPath":"/tmp","PrefSSBFileDownloadPath":"/other"}}',
    ])
      expect(() => project(input)).toThrow('duplicate');
  });
  test('rejects truncated, malformed and trailing syntax without echoing private values', () => {
    for (const input of [
      '',
      '{',
      '{"x":',
      '{"x":01}',
      '{"x":1e}',
      '{"x":true false}',
      '{"x":null,}',
      '{"x":[1,]}',
      '{"x":"\\q"}',
      '{"x":"\\u000"}',
      '{"x":"line\nfeed"}',
      '{} {}',
      `{"secret":"${sentinel}","x":`,
      '{"settings":[]}',
      '{"downloads":null}',
    ]) {
      try {
        project(input);
        throw Error('Unexpected acceptance');
      } catch (error) {
        expect(error.message).not.toContain(sentinel);
        expect(error.message).not.toBe('Unexpected acceptance');
      }
    }
  });
  test('validates UTF-8 inside skipped string values without decoding them', () => {
    for (const bytes of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xc2]]) {
      const input = Buffer.concat([
        Buffer.from('{"secret":"'),
        Buffer.from(bytes),
        Buffer.from('"}'),
      ]);
      expect(() => projectDownloadState(input, identity)).toThrow('malformed');
    }
    expect(
      project({ unknown: 'Unicode 😀 café', settings: { PrefSSBFileDownloadPath: '/tmp/café' } })
        .directory
    ).toBe('/tmp/café');
  });
  test('bounds bytes, nesting, scalar size and node counts', () => {
    expect(() => projectDownloadState(Buffer.alloc(16 * 1024 * 1024 + 1), identity)).toThrow(
      'bounds'
    );
    expect(() => project('{"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}')).toThrow('bounds');
    expect(() => project({ settings: { PrefSSBFileDownloadPath: 'x'.repeat(32769) } })).toThrow(
      'bounds'
    );
    expect(() => project('{"' + 'x'.repeat(4097) + '":null}')).toThrow('bounds');
    expect(() => project({ x: Array(200001).fill(0) })).toThrow('bounds');
  });
  test('rejects mismatched identities and malformed selected record fields', () => {
    for (const extra of [
      { id: 'FOTHER' },
      { teamId: 'TOTHER' },
      { url: url.replace('FDEMO', 'FOTHER') },
      { startTime: 0 },
      { startTime: 1.5 },
      { endTime: 1 },
      { downloadState: 'unknown' },
      { progress: 2 },
      { downloadPath: false },
      { url: { secret: sentinel } },
    ])
      expect(() => project(document('/tmp', record(extra)))).toThrow();
  });
});

describe('observed download URL identity', () => {
  test('derives team/file IDs without rewriting download representations', () => {
    expect(parseObservedDownloadURL(url)).toEqual({ ...identity, url });
    const converted =
      'https://files.slack.com/files-tmb/TDEMO-FDEMO-ab12/audio_converted.mp4?origin_team=TDEMO';
    expect(parseObservedDownloadURL(converted)).toEqual({ ...identity, url: converted });
  });
  test('rejects credentials, foreign hosts, unknown routes and noncanonical IDs', () => {
    for (const input of [
      url.replace('https:', 'http:'),
      url.replace('files.slack.com', 'files.slack.com.evil.test'),
      url.replace('https://', 'https://user:secret@'),
      url + '#fragment',
      url.replace('files.slack.com', 'files.slack.com:444'),
      url.replace('/files-pri/', '/files/'),
      url.replace('TDEMO-FDEMO', 'EDEMO-FDEMO'),
      url.replace('TDEMO-FDEMO', 'TDEMO-fdemo'),
      url + '\n',
      ' ' + url,
      null,
    ])
      expect(() => parseObservedDownloadURL(input)).toThrow();
  });
});

describe('stable filesystem state reads', () => {
  test('reads only an owned bounded ordinary state file and records bigint identity', async () => {
    const f = await fixture(record());
    const result = await readDownloadState(f.statePath, identity);
    expect(result.download.id).toBe('FDEMO');
    expect(result.file).toEqual({
      device: expect.stringMatching(/^\d+$/),
      inode: expect.stringMatching(/^\d+$/),
      size: expect.stringMatching(/^\d+$/),
      mtimeNs: expect.stringMatching(/^\d+$/),
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
  test('rejects state symlinks, hard links and publicly writable files', async () => {
    const f = await fixture();
    const alias = path.join(f.folder, 'alias.json');
    await symlink(f.statePath, alias);
    await expect(readDownloadState(alias, identity)).rejects.toThrow('regular');
    await rm(alias);
    await link(f.statePath, alias);
    await expect(readDownloadState(f.statePath, identity)).rejects.toThrow('regular');
    await rm(alias);
    await chmod(f.statePath, 0o666);
    await expect(readDownloadState(f.statePath, identity)).rejects.toThrow('regular');
  });
  test('accepts successive atomic replacements without combining records', async () => {
    const f = await fixture();
    for (let index = 0; index < 8; index++) {
      const value = record({
        startTime: Date.now() - 1000 - index,
        endTime: Date.now(),
        progress: index / 10,
      });
      await f.write(value);
      const read = await readDownloadState(f.statePath, identity);
      expect(read.download.startTime).toBe(value.startTime);
      expect(read.download.progress).toBe(value.progress);
    }
  });
  test('requires an existing configured directory and refuses an active same-file download', async () => {
    const f = await fixture();
    await f.write(null, '');
    await expect(prepareDownloadState(f.statePath, { url })).rejects.toThrow('configured');
    for (const downloadState of ['not_started', 'progressing', 'paused']) {
      await f.write(record({ downloadState }));
      await expect(prepareDownloadState(f.statePath, { url })).rejects.toThrow('already pending');
    }
    const alias = path.join(f.folder, 'directory-alias');
    await symlink(f.directory, alias);
    await expect(pinDownloadDirectory(alias)).rejects.toThrow('non-symlink');
  });
});

describe('attributed download completion', () => {
  test('enterprise ledger context is distinct from the observed URL owner', async () => {
    const f = await ready(null, 'EDEMO');
    expect(f.prepared.teamId).toBe('EDEMO');
    expect(f.prepared.fileOwnerTeamId).toBe('TDEMO');
    expect(f.prepared.baseline).toMatchObject({ teamId: 'EDEMO', fileId: 'FDEMO' });
    await complete(f, { teamId: 'EDEMO' });
    const result = await wait(f);
    expect(result.download).toMatchObject({ teamId: 'EDEMO', id: 'FDEMO', url });
    await expect(wait(f, { teamId: 'TDEMO' })).rejects.toThrow('monitoring');
    await complete(f, { teamId: 'EDEMO', url: url + '?changed=1' });
    await expect(wait(f)).rejects.toThrow('identity changed');
  });
  test('projects only the explicitly selected enterprise bucket and rejects mismatched record context', () => {
    const input = document('/tmp/downloads', record({ teamId: 'EDEMO' }), 'EDEMO');
    input.downloads.TDEMO = { FDEMO: record({ url: url + '?unrelated=1' }) };
    const result = projectDownloadState(Buffer.from(JSON.stringify(input)), {
      teamId: 'EDEMO',
      fileId: 'FDEMO',
    });
    expect(result.download.url).toBe(url);
    input.downloads.EDEMO.FDEMO.teamId = 'TDEMO';
    expect(() =>
      projectDownloadState(Buffer.from(JSON.stringify(input)), { teamId: 'EDEMO', fileId: 'FDEMO' })
    ).toThrow('identity does not match');
  });
  test('requires a new completed matching record and returns publisher identity', async () => {
    const f = await ready(record());
    const completed = await complete(f);
    const result = await wait(f);
    expect(result.download).toMatchObject({
      id: 'FDEMO',
      teamId: 'TDEMO',
      url,
      startTime: f.startedAt,
      endTime: completed.endTime,
    });
    expect(result.sourcePath).toBe(path.join(f.prepared.directory.path, 'example.mp4'));
    expect(result.expectedSource).toEqual({
      device: expect.stringMatching(/^\d+$/),
      inode: expect.stringMatching(/^\d+$/),
      size: String(Buffer.byteLength('synthetic downloaded bytes')),
      mtimeNs: expect.stringMatching(/^\d+$/),
    });
  });
  test('waits beyond the eight-second persistence throttle without requiring immediate state', async () => {
    const f = await ready();
    const update = new Promise((resolve, reject) =>
      setTimeout(() => complete(f).then(resolve, reject), 8150)
    );
    try {
      const result = await wait(f, { timeoutMs: 10000, pollIntervalMs: 100 });
      expect(result.download.startTime).toBe(f.startedAt);
    } finally {
      await update;
    }
  }, 12000);
  test('does not mistake old completed or unrelated records for this action', async () => {
    const old = record();
    const f = await ready(old);
    await expect(wait(f, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });
    expect((await readDownloadState(f.statePath, identity)).download.startTime).toBe(old.startTime);
  });
  test('retained old end time and path on active re-downloads do not prove completion', async () => {
    const old = record({ downloadPath: '/tmp/stale-download.mp4' });
    const f = await ready(old);
    await f.write({ ...old, startTime: f.startedAt, downloadState: 'progressing', progress: 0 });
    expect((await readDownloadState(f.statePath, identity)).download.endTime).toBe(old.endTime);
    await expect(wait(f, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });
    await complete(f);
    expect((await wait(f)).download.downloadState).toBe('completed');
  });
  test('requires exact URL and end time despite matching file IDs', async () => {
    for (const extra of [{ url: url + '?different=1' }, { endTime: undefined }]) {
      const f = await ready();
      await complete(f, extra);
      await expect(wait(f)).rejects.toThrow();
    }
  });
  test('rejects completed paths outside the pinned direct-child directory', async () => {
    const f = await ready();
    const outside = path.join(f.folder, 'elsewhere.mp4');
    await writeFile(outside, 'unrelated', { mode: 0o600 });
    await complete(f, { downloadPath: outside });
    await expect(wait(f)).rejects.toThrow('direct child');
  });
  test('rejects completed symlinks and oversized regular files', async () => {
    const f = await ready();
    const record = await complete(f);
    await rm(record.downloadPath);
    await symlink(f.statePath, record.downloadPath);
    await expect(wait(f)).rejects.toThrow('regular file');
    await rm(record.downloadPath);
    await writeFile(record.downloadPath, '');
    await truncate(record.downloadPath, 256 * 1024 * 1024 + 1);
    await expect(wait(f)).rejects.toThrow('bounded');
  });
  test('refuses changed configured preferences and directory identity', async () => {
    const f = await ready();
    await f.write(null, f.folder);
    await expect(wait(f)).rejects.toThrow('preference changed');
    await f.write(null);
    await rename(f.directory, path.join(f.folder, 'old-downloads'));
    await mkdir(f.directory, { mode: 0o700 });
    await expect(wait(f)).rejects.toThrow('directory changed');
  });
  test('reports failed and cancelled native records without cancelling Slack', async () => {
    for (const [downloadState, code] of [
      ['interrupted', 'DOWNLOAD_FAILED'],
      ['cancelled', 'DOWNLOAD_CANCELLED'],
    ]) {
      const f = await ready();
      await f.write(record({ startTime: f.startedAt, endTime: f.startedAt, downloadState }));
      await expect(wait(f)).rejects.toMatchObject({ code });
    }
  });
  test('supports monitor cancellation without changing persisted download state', async () => {
    const f = await ready();
    await f.write(
      record({
        startTime: f.startedAt,
        endTime: undefined,
        downloadState: 'progressing',
        progress: 0.1,
      })
    );
    const controller = new AbortController();
    const operation = wait(f, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 15);
    try {
      await expect(operation).rejects.toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
    } finally {
      clearTimeout(timer);
    }
    expect((await readDownloadState(f.statePath, identity)).download.downloadState).toBe(
      'progressing'
    );
  });
  test('rejects disappearance or replacement after observing this active download', async () => {
    for (const replacement of ['removed', 'restarted']) {
      const f = await ready();
      await f.write(
        record({
          startTime: f.startedAt,
          endTime: undefined,
          downloadState: 'progressing',
          progress: 0.1,
        })
      );
      const operation = wait(f);
      const update = new Promise((resolve, reject) =>
        setTimeout(
          () =>
            f
              .write(
                replacement === 'removed'
                  ? null
                  : record({
                      startTime: Date.now(),
                      endTime: undefined,
                      downloadState: 'progressing',
                    })
              )
              .then(resolve, reject),
          20
        )
      );
      try {
        await expect(operation).rejects.toThrow();
      } finally {
        await update;
      }
    }
  });
  test('refuses invalid monitoring bounds and identities before polling', async () => {
    const f = await ready();
    for (const extra of [
      { timeoutMs: 60001 },
      { timeoutMs: 0 },
      { teamId: 'TOTHER' },
      { startedAt: f.prepared.baseline.observedAt - 1 },
      { directory: f.directory },
    ]) {
      await expect(wait(f, extra)).rejects.toThrow('monitoring');
    }
  });
});

const viewerSourceURL = 'https://files.slack.com/files-pri/TDEMO-FDEMO/example.png';
const viewerLedgerURL = 'https://files.slack.com/files-pri/TDEMO-FDEMO/example.png?download=1';
async function readyViewer(download = null, contextId = 'EDEMO', sourceURL = viewerSourceURL) {
  const f = await fixture(download, contextId);
  const prepared = await prepareViewerDownloadState(f.statePath, { sourceURL, contextId });
  return { ...f, prepared, startedAt: Date.now() };
}
const waitViewer = (f, options = {}) =>
  waitForViewerDownload(f.statePath, {
    ...f.prepared,
    startedAt: f.startedAt,
    timeoutMs: 1000,
    pollIntervalMs: 5,
    ...options,
  });
const completeViewer = (f, extra = {}) =>
  complete(f, {
    teamId: f.prepared.teamId,
    url: viewerLedgerURL,
    ...extra,
  });
const viewerProgress = (f, extra = {}) =>
  record({
    teamId: f.prepared.teamId,
    url: viewerLedgerURL,
    startTime: f.startedAt,
    endTime: undefined,
    downloadState: 'progressing',
    progress: 0.1,
    ...extra,
  });

describe('canonical viewer source identity', () => {
  test('retains the exact observed source URL and separates file owner from context', () => {
    for (const contextId of ['TDEMO', 'EDEMO']) {
      for (const sourceURL of [viewerSourceURL, viewerSourceURL + '?origin_team=' + contextId]) {
        expect(parseViewerSourceURL(sourceURL, contextId)).toEqual({
          teamId: 'TDEMO',
          fileId: 'FDEMO',
          sourceURL,
        });
      }
    }
    const encoded = viewerSourceURL.replace('example.png', 'r%C3%A9sum%C3%A9%20%23one.png');
    expect(parseViewerSourceURL(encoded, 'EDEMO').sourceURL).toBe(encoded);
  });
  test.each([
    ['a Download URL', url],
    ['a rendition URL', viewerSourceURL.replace('files-pri', 'files-tmb')],
    ['a variant owner path', viewerSourceURL.replace('TDEMO-FDEMO', 'TDEMO-FDEMO-ab12')],
    ['an enterprise owner path', viewerSourceURL.replace('TDEMO', 'EDEMO')],
    ['an uppercase host', viewerSourceURL.replace('files.slack.com', 'FILES.SLACK.COM')],
    [
      'an explicit normalized port',
      viewerSourceURL.replace('files.slack.com', 'files.slack.com:443'),
    ],
    ['a foreign host', viewerSourceURL.replace('files.slack.com', 'files.slack.com.evil.test')],
    ['URL credentials', viewerSourceURL.replace('https://', 'https://user:secret@')],
    ['raw traversal', viewerSourceURL.replace('example.png', 'nested/../example.png')],
    ['encoded traversal', viewerSourceURL.replace('example.png', '%2e%2e')],
    ['encoded slash', viewerSourceURL.replace('example.png', 'nested%2fexample.png')],
    ['encoded backslash', viewerSourceURL.replace('example.png', 'nested%5cexample.png')],
    ['encoded C1 control', viewerSourceURL.replace('example.png', 'example%C2%85.png')],
    ['malformed UTF8', viewerSourceURL.replace('example.png', 'example%FF.png')],
    ['raw Unicode', viewerSourceURL.replace('example.png', 'résumé.png')],
    ['silently normalized punctuation', viewerSourceURL.replace('example.png', 'example".png')],
    ['an empty basename', viewerSourceURL.replace('example.png', '')],
    ['an extra query', viewerSourceURL + '?origin_team=EDEMO&transform=1'],
    ['a duplicate query', viewerSourceURL + '?origin_team=EDEMO&origin_team=EDEMO'],
    ['a foreign context query', viewerSourceURL + '?origin_team=EOTHER'],
    ['an encoded query', viewerSourceURL + '?origin_team=%45DEMO'],
    ['a trailing query separator', viewerSourceURL + '?origin_team=EDEMO&'],
    ['an empty query', viewerSourceURL + '?'],
    ['a fragment', viewerSourceURL + '#viewer'],
  ])('rejects %s rather than turning it into a Download target', (_name, sourceURL) => {
    expect(() => parseViewerSourceURL(sourceURL, 'EDEMO')).toThrow();
  });
  test('requires the explicit verified context instead of inferring it from URL owner', () => {
    for (const contextId of [undefined, null, '', 'OTHER', 'eDEMO', 'E' + 'x'.repeat(64)])
      expect(() => parseViewerSourceURL(viewerSourceURL, contextId)).toThrow();
  });
});

describe('viewer file-identity download correlation', () => {
  test('preparation has source identity but no invented URL or original representation', async () => {
    const f = await readyViewer();
    expect(f.prepared).toMatchObject({
      teamId: 'EDEMO',
      fileId: 'FDEMO',
      fileOwnerTeamId: 'TDEMO',
      sourceURL: viewerSourceURL,
      correlation: 'viewer-file-identity',
    });
    expect(f.prepared).not.toHaveProperty('url');
    expect(f.prepared).not.toHaveProperty('originalFile');
    expect(f.prepared.baseline.download).toBeNull();
  });
  test('a fresh completed same-owner/file record establishes its exact observed URL', async () => {
    for (const actualURL of [
      viewerLedgerURL,
      url,
      'https://files.slack.com/files-tmb/TDEMO-FDEMO-ab12/rendition.mp4?origin_team=EDEMO',
    ]) {
      const f = await readyViewer();
      await completeViewer(f, { url: actualURL });
      const result = await waitViewer(f);
      expect(result.download).toMatchObject({
        id: 'FDEMO',
        teamId: 'EDEMO',
        url: actualURL,
        startTime: f.startedAt,
      });
      expect(result).toMatchObject({
        correlation: 'viewer-file-identity',
        sourceURL: viewerSourceURL,
        fileOwnerTeamId: 'TDEMO',
      });
      expect(result.expectedSource.size).toBe(
        String(Buffer.byteLength('synthetic downloaded bytes'))
      );
      expect(result).not.toHaveProperty('originalSelection');
      expect(result).not.toHaveProperty('originalFile');
    }
  });
  test('allows a completed baseline of another representation but requires a strictly newer action', async () => {
    const old = record({ teamId: 'EDEMO', url });
    const f = await readyViewer(old);
    await expect(waitViewer(f, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'DOWNLOAD_TIMEOUT',
    });
    await completeViewer(f);
    const result = await waitViewer(f);
    expect(result.download.startTime).toBeGreaterThan(old.startTime);
    expect(result.download.url).toBe(viewerLedgerURL);
  });
  test('refuses every active baseline and a conflicting previous file owner before new input', async () => {
    for (const downloadState of ['not_started', 'progressing', 'paused']) {
      const f = await fixture(record({ teamId: 'EDEMO', downloadState }), 'EDEMO');
      await expect(
        prepareViewerDownloadState(f.statePath, { sourceURL: viewerSourceURL, contextId: 'EDEMO' })
      ).rejects.toMatchObject({ code: 'DOWNLOAD_ALREADY_PENDING' });
    }
    const f = await fixture(
      record({ teamId: 'EDEMO', url: url.replace('TDEMO-FDEMO', 'TOTHER-FDEMO') }),
      'EDEMO'
    );
    await expect(
      prepareViewerDownloadState(f.statePath, { sourceURL: viewerSourceURL, contextId: 'EDEMO' })
    ).rejects.toThrow('source owner and file');
  });
  test('rejects a fresh record for another file, owner or ledger context', async () => {
    for (const extra of [
      { url: viewerLedgerURL.replace('TDEMO-FDEMO', 'TOTHER-FDEMO') },
      { url: viewerLedgerURL.replace('TDEMO-FDEMO', 'TDEMO-FOTHER') },
      { id: 'FOTHER' },
      { teamId: 'TDEMO' },
      { url: viewerLedgerURL.replace('files.slack.com', 'files.slack.com.evil.test') },
    ]) {
      const f = await readyViewer();
      await completeViewer(f, extra);
      await expect(waitViewer(f)).rejects.toThrow();
    }
  });
  test('pins the first fresh URL even if a replacement has the same owner, file and timestamp', async () => {
    const f = await readyViewer();
    await f.write(viewerProgress(f));
    const operation = waitViewer(f);
    const update = new Promise((resolve, reject) =>
      setTimeout(
        () => completeViewer(f, { url: viewerLedgerURL + '&other=1' }).then(resolve, reject),
        60
      )
    );
    try {
      await expect(operation).rejects.toThrow('URL changed after its first fresh record');
    } finally {
      await update;
    }
  });
  test('pins the first fresh start time and rejects restart, stale replacement or disappearance', async () => {
    for (const replacement of ['restart', 'stale', 'removed']) {
      const f = await readyViewer();
      await f.write(viewerProgress(f));
      const operation = waitViewer(f);
      const update = new Promise((resolve, reject) =>
        setTimeout(
          () =>
            f
              .write(
                replacement === 'removed'
                  ? null
                  : viewerProgress(f, {
                      startTime: replacement === 'restart' ? Date.now() : f.startedAt - 1,
                    })
              )
              .then(resolve, reject),
          60
        )
      );
      try {
        await expect(operation).rejects.toThrow();
      } finally {
        await update;
      }
    }
  });
  test('does not confuse retained old path/end time on a fresh active record with completion', async () => {
    const old = record({ teamId: 'EDEMO', url: viewerLedgerURL, downloadPath: '/tmp/stale-file' });
    const f = await readyViewer(old);
    await f.write({ ...old, startTime: f.startedAt, downloadState: 'progressing', progress: 0 });
    await expect(waitViewer(f, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'DOWNLOAD_TIMEOUT',
    });
    await completeViewer(f);
    expect((await waitViewer(f)).download.downloadState).toBe('completed');
  });
  test('native failure and cancellation stay terminal without cancelling Slack', async () => {
    for (const [downloadState, code] of [
      ['interrupted', 'DOWNLOAD_FAILED'],
      ['cancelled', 'DOWNLOAD_CANCELLED'],
      ['canceled', 'DOWNLOAD_CANCELLED'],
    ]) {
      const f = await readyViewer();
      await f.write(viewerProgress(f, { downloadState }));
      await expect(waitViewer(f)).rejects.toMatchObject({ code });
      expect(
        (await readDownloadState(f.statePath, { teamId: 'EDEMO', fileId: 'FDEMO' })).download
          .downloadState
      ).toBe(downloadState);
    }
  });
  test('monitor cancellation leaves persisted viewer download state untouched', async () => {
    const f = await readyViewer();
    await f.write(viewerProgress(f));
    const controller = new AbortController();
    const operation = waitViewer(f, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await expect(operation).rejects.toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
    } finally {
      clearTimeout(timer);
    }
    expect(
      (await readDownloadState(f.statePath, { teamId: 'EDEMO', fileId: 'FDEMO' })).download
        .downloadState
    ).toBe('progressing');
  });
  test('preserves direct-child, non-symlink and pinned-directory requirements', async () => {
    const f = await readyViewer();
    const outside = path.join(f.folder, 'outside.mp4');
    await writeFile(outside, 'unrelated bytes', { mode: 0o600 });
    await completeViewer(f, { downloadPath: outside });
    await expect(waitViewer(f)).rejects.toThrow('direct child');
    const completed = await completeViewer(f);
    await rm(completed.downloadPath);
    await symlink(outside, completed.downloadPath);
    await expect(waitViewer(f)).rejects.toThrow('regular file');
    await f.write(null, f.folder);
    await expect(waitViewer(f)).rejects.toThrow('preference changed');
  });
  test('requires explicit viewer setup and all existing monitoring bounds', async () => {
    const f = await readyViewer();
    for (const extra of [
      { fileOwnerTeamId: 'TOTHER' },
      { fileId: 'FOTHER' },
      { teamId: 'TDEMO' },
      { sourceURL: url },
      { correlation: 'observed-url' },
      { timeoutMs: 60001 },
      { startedAt: f.prepared.baseline.observedAt - 1 },
      { directory: f.directory },
    ])
      await expect(waitViewer(f, extra)).rejects.toThrow();
    const direct = await ready();
    await expect(
      waitForViewerDownload(direct.statePath, { ...direct.prepared, startedAt: direct.startedAt })
    ).rejects.toThrow();
  });
  test('viewer-looking options cannot weaken the existing exact-URL entry point', async () => {
    const f = await ready();
    await complete(f, { url: viewerLedgerURL });
    await expect(
      wait(f, {
        sourceURL: viewerSourceURL,
        correlation: 'viewer-file-identity',
        fileOwnerTeamId: 'TDEMO',
      })
    ).rejects.toThrow('identity changed');
  });
});
