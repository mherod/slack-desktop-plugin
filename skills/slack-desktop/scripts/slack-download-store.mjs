// Read only a configured directory and one URL-bound download record. Unknown
// branches are syntax-checked bytewise; their values are never decoded/materialized.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 200000;
const MAX_KEY_BYTES = 4096;
const MAX_VALUE_BYTES = 32768;
const MAX_DOWNLOAD_BYTES = 256n * 1024n * 1024n;
const recordFields = [
  'id',
  'teamId',
  'url',
  'startTime',
  'endTime',
  'downloadState',
  'progress',
  'downloadPath',
];
const activeStates = new Set(['not_started', 'progressing', 'paused']);
const terminalStates = new Set(['completed', 'interrupted', 'cancelled', 'canceled']);
const fail = (message, code = 'DOWNLOAD_STATE_INVALID') => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
const requireState = (condition, message, code) => {
  if (!condition) fail(message, code);
};
const validIDs = ({ teamId, fileId } = {}) => {
  requireState(
    typeof teamId === 'string' &&
      /^[TE][A-Z0-9]+$/.test(teamId) &&
      teamId.length <= 64 &&
      typeof fileId === 'string' &&
      /^F[A-Z0-9]+$/.test(fileId) &&
      fileId.length <= 64,
    'Download team/file identity is unsupported'
  );
};

export function parseObservedDownloadURL(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    /* Validate below without disclosing the value. */
  }
  requireState(
    typeof value === 'string' &&
      value.length <= MAX_VALUE_BYTES &&
      value.trim() === value &&
      !/[\u0000-\u0020\u007f]/.test(value) &&
      parsed?.protocol === 'https:' &&
      parsed.hostname === 'files.slack.com' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      !parsed.hash,
    'Use an exact observed HTTPS Slack download target'
  );
  const match = parsed.pathname.match(
    /^\/files-(?:pri|tmb)\/(T[A-Z0-9]+)-(F[A-Z0-9]+)(?:-[A-Za-z0-9]+)?\/.+/
  );
  requireState(match, 'Observed download target has no supported team/file identity');
  const result = { teamId: match[1], fileId: match[2], url: value };
  validIDs(result);
  return result;
}

// This is an observed source-image identity, never an inferred Download URL.
// The viewer action has no URL; its later ledger entry is correlated separately.
export function parseViewerSourceURL(value, contextId) {
  const owner = parseObservedDownloadURL(value);
  validIDs({ teamId: contextId, fileId: owner.fileId });
  const match = value.match(
    /^https:\/\/files\.slack\.com\/files-pri\/(T[A-Z0-9]+)-(F[A-Z0-9]+)\/([A-Za-z0-9._~!$&'()*+,;=:@%-]+)(?:\?([^#]*))?$/
  );
  let name;
  try {
    if (match) name = decodeURIComponent(match[3]);
  } catch {
    /* A malformed encoded basename cannot establish source identity. */
  }
  requireState(
    match &&
      name &&
      !['.', '..'].includes(name) &&
      !/[\/\\\x00-\x1f\x7f-\x9f]/.test(name) &&
      (match[4] === undefined || match[4] === `origin_team=${contextId}`),
    'Viewer source must be an exact canonical observed Slack private-file URL'
  );
  return { teamId: owner.teamId, fileId: owner.fileId, sourceURL: value };
}

// Deliberately not JSON.parse(root): only object keys and selected scalar values
// are decoded. In particular, encrypted credential values remain skipped bytes.
export function projectDownloadState(input, identity) {
  validIDs(identity);
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  requireState(
    bytes.length > 0 && bytes.length <= MAX_STATE_BYTES,
    'Download state exceeds read bounds'
  );
  let position = 0,
    nodes = 0;
  const whitespace = () => {
    while ([9, 10, 13, 32].includes(bytes[position])) position++;
  };
  const invalid = () => fail('Download state is malformed or truncated');
  const stringToken = (materialize, limit = MAX_VALUE_BYTES) => {
    const start = position;
    if (bytes[position++] !== 34) invalid();
    for (;;) {
      if (position >= bytes.length) invalid();
      const value = bytes[position++];
      if (value === 34) break;
      if (value === 92) {
        const escape = bytes[position++];
        if (escape === 117) {
          for (let index = 0; index < 4; index++) {
            const digit = bytes[position++];
            if (
              !(
                (digit >= 48 && digit <= 57) ||
                (digit >= 65 && digit <= 70) ||
                (digit >= 97 && digit <= 102)
              )
            )
              invalid();
          }
        } else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(escape)) invalid();
      } else if (value < 32) invalid();
      else if (value >= 128) {
        let count,
          minimum = 128,
          maximum = 191;
        if (value >= 194 && value <= 223) count = 1;
        else if (value >= 224 && value <= 239) {
          count = 2;
          if (value === 224) minimum = 160;
          if (value === 237) maximum = 159;
        } else if (value >= 240 && value <= 244) {
          count = 3;
          if (value === 240) minimum = 144;
          if (value === 244) maximum = 143;
        } else invalid();
        const first = bytes[position++];
        if (!(first >= minimum && first <= maximum)) invalid();
        for (let index = 1; index < count; index++) {
          const continuation = bytes[position++];
          if (!(continuation >= 128 && continuation <= 191)) invalid();
        }
      }
    }
    if (!materialize) return;
    requireState(position - start <= limit, 'Selected download state scalar exceeds bounds');
    try {
      return JSON.parse(bytes.toString('utf8', start, position));
    } catch {
      invalid();
    }
  };
  const numberToken = (materialize) => {
    const start = position;
    if (bytes[position] === 45) position++;
    if (bytes[position] === 48) position++;
    else {
      if (!(bytes[position] >= 49 && bytes[position] <= 57)) invalid();
      while (bytes[position] >= 48 && bytes[position] <= 57) position++;
    }
    if (bytes[position] === 46) {
      position++;
      if (!(bytes[position] >= 48 && bytes[position] <= 57)) invalid();
      while (bytes[position] >= 48 && bytes[position] <= 57) position++;
    }
    if ([69, 101].includes(bytes[position])) {
      position++;
      if ([43, 45].includes(bytes[position])) position++;
      if (!(bytes[position] >= 48 && bytes[position] <= 57)) invalid();
      while (bytes[position] >= 48 && bytes[position] <= 57) position++;
    }
    if (!materialize) return;
    requireState(position - start <= 64, 'Selected download number exceeds bounds');
    return Number(bytes.toString('ascii', start, position));
  };
  const childMode = (mode, key) => {
    if (mode === 'root')
      return key === 'settings' ? 'settings' : key === 'downloads' ? 'downloads' : 'skip';
    if (mode === 'settings') return key === 'PrefSSBFileDownloadPath' ? 'scalar' : 'skip';
    if (mode === 'downloads') return key === identity.teamId ? 'team' : 'skip';
    if (mode === 'team') return key === identity.fileId ? 'record' : 'skip';
    if (mode === 'record') return recordFields.includes(key) ? 'scalar' : 'skip';
    return 'skip';
  };
  const value = (mode, depth) => {
    requireState(
      depth <= MAX_DEPTH && ++nodes <= MAX_NODES,
      'Download state structure exceeds bounds'
    );
    whitespace();
    const byte = bytes[position];
    const selectedObject = !['scalar', 'skip'].includes(mode);
    if (selectedObject && byte !== 123) invalid();
    if (byte === 123) {
      if (mode === 'scalar') invalid();
      position++;
      const result = mode === 'skip' ? undefined : Object.create(null),
        seen = new Set();
      whitespace();
      if (bytes[position] === 125) {
        position++;
        return result;
      }
      for (;;) {
        whitespace();
        const key = stringToken(true, MAX_KEY_BYTES);
        requireState(!seen.has(key), 'Download state contains a duplicate object key');
        seen.add(key);
        whitespace();
        if (bytes[position++] !== 58) invalid();
        const next = childMode(mode, key),
          parsed = value(next, depth + 1);
        if (result && next !== 'skip') result[key] = parsed;
        whitespace();
        const delimiter = bytes[position++];
        if (delimiter === 125) return result;
        if (delimiter !== 44) invalid();
      }
    }
    if (byte === 91) {
      if (mode === 'scalar') invalid();
      position++;
      whitespace();
      if (bytes[position] === 93) {
        position++;
        return;
      }
      for (;;) {
        value('skip', depth + 1);
        whitespace();
        const delimiter = bytes[position++];
        if (delimiter === 93) return;
        if (delimiter !== 44) invalid();
      }
    }
    if (byte === 34) return stringToken(mode === 'scalar');
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (byte === literal.charCodeAt(0)) {
        for (let index = 0; index < literal.length; index++)
          if (bytes[position++] !== literal.charCodeAt(index)) invalid();
        return mode === 'scalar' ? result : undefined;
      }
    }
    return numberToken(mode === 'scalar');
  };
  const root = value('root', 0);
  whitespace();
  requireState(position === bytes.length, 'Download state contains trailing content');
  const directory = root.settings?.PrefSSBFileDownloadPath ?? null;
  requireState(
    directory === null ||
      (typeof directory === 'string' &&
        directory.length <= MAX_VALUE_BYTES &&
        !/[\u0000-\u001f\u007f]/.test(directory)),
    'Configured download directory is malformed'
  );
  const selected = root.downloads?.[identity.teamId]?.[identity.fileId] ?? null;
  if (!selected) return { directory, download: null };
  requireState(
    selected.id === identity.fileId && selected.teamId === identity.teamId,
    'Selected download record identity does not match'
  );
  const route = parseObservedDownloadURL(selected.url);
  requireState(
    route.fileId === identity.fileId,
    'Selected download record URL identity does not match'
  );
  requireState(
    Number.isSafeInteger(selected.startTime) &&
      selected.startTime > 0 &&
      (activeStates.has(selected.downloadState) || terminalStates.has(selected.downloadState)),
    'Selected download record has invalid timing or state'
  );
  if (Object.hasOwn(selected, 'endTime'))
    requireState(
      Number.isSafeInteger(selected.endTime) &&
        selected.endTime > 0 &&
        (selected.downloadState !== 'completed' || selected.endTime >= selected.startTime),
      'Selected download completion time is invalid'
    );
  if (Object.hasOwn(selected, 'progress'))
    requireState(
      typeof selected.progress === 'number' &&
        Number.isFinite(selected.progress) &&
        (selected.progress === -1 || (selected.progress >= 0 && selected.progress <= 1)),
      'Selected download progress is invalid'
    );
  if (Object.hasOwn(selected, 'downloadPath'))
    requireState(
      typeof selected.downloadPath === 'string' &&
        !/[\u0000-\u001f\u007f]/.test(selected.downloadPath),
      'Selected download path is malformed'
    );
  return {
    directory,
    download: Object.fromEntries(
      recordFields.filter((key) => Object.hasOwn(selected, key)).map((key) => [key, selected[key]])
    ),
  };
}

const owned = (info) =>
  typeof process.getuid !== 'function' || info.uid === BigInt(process.getuid());
const regular = (info) => info.isFile() && info.nlink === 1n && owned(info);
const sameStat = (a, b) =>
  ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);
const fileReceipt = (info) => ({
  device: String(info.dev),
  inode: String(info.ino),
  size: String(info.size),
  mtimeNs: String(info.mtimeNs),
});
const pause = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Download monitoring cancelled; Slack was not cancelled');
      error.code = 'DOWNLOAD_CANCELLED';
      reject(error);
      return;
    }
    let timer;
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      const error = new Error('Download monitoring cancelled; Slack was not cancelled');
      error.code = 'DOWNLOAD_CANCELLED';
      reject(error);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', cancel, { once: true });
  });

export async function readDownloadState(statePath, identity) {
  validIDs(identity);
  requireState(
    typeof statePath === 'string' && path.isAbsolute(statePath),
    'Download state path must be absolute'
  );
  for (let attempt = 0; attempt < 4; attempt++) {
    let handle;
    try {
      const before = await lstat(statePath, { bigint: true });
      requireState(
        regular(before) && (before.mode & 0o022n) === 0n,
        'Download state must be an owned regular non-symlink file'
      );
      requireState(
        before.size > 0n && before.size <= BigInt(MAX_STATE_BYTES),
        'Download state exceeds read bounds'
      );
      handle = await open(
        statePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const opened = await handle.stat({ bigint: true });
      if (!sameStat(before, opened))
        fail('Download state changed during read', 'DOWNLOAD_STATE_CHANGED');
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true }),
        current = await lstat(statePath, { bigint: true });
      if (offset !== Number(before.size) || !sameStat(opened, after) || !sameStat(after, current))
        fail('Download state changed during read', 'DOWNLOAD_STATE_CHANGED');
      const projection = projectDownloadState(bytes.subarray(0, offset), identity);
      return {
        ...projection,
        teamId: identity.teamId,
        fileId: identity.fileId,
        observedAt: Date.now(),
        file: fileReceipt(after),
      };
    } catch (error) {
      if (attempt < 3 && ['DOWNLOAD_STATE_CHANGED', 'ENOENT'].includes(error.code)) await pause(20);
      else if (error.code?.startsWith('DOWNLOAD_')) throw error;
      else fail('Download state could not be read safely');
    } finally {
      await handle?.close();
    }
  }
}

export async function pinDownloadDirectory(directory) {
  requireState(
    typeof directory === 'string' &&
      directory.length > 0 &&
      path.isAbsolute(directory) &&
      !/[\u0000-\u001f\u007f]/.test(directory),
    'Slack has no supported configured download directory'
  );
  const configuredPath = path.resolve(directory),
    before = await lstat(configuredPath, { bigint: true });
  requireState(
    before.isDirectory() && owned(before),
    'Download directory must be an owned existing non-symlink directory'
  );
  const canonical = await realpath(configuredPath),
    after = await lstat(canonical, { bigint: true });
  requireState(
    after.isDirectory() && owned(after) && before.dev === after.dev && before.ino === after.ino,
    'Download directory identity changed'
  );
  return { path: canonical, configuredPath, device: String(after.dev), inode: String(after.ino) };
}

export async function prepareDownloadState(statePath, { url, contextId }) {
  const owner = parseObservedDownloadURL(url);
  // Slack keys its ledger by the calling workspace context, which can be an
  // enterprise E ID distinct from the T owner embedded in the download URL.
  const identity = { ...owner, teamId: contextId === undefined ? owner.teamId : contextId };
  return prepareDownloadIdentity(statePath, identity, owner.teamId);
}

async function prepareDownloadIdentity(statePath, identity, fileOwnerTeamId) {
  validIDs(identity);
  const baseline = await readDownloadState(statePath, identity);
  requireState(
    !baseline.download || !activeStates.has(baseline.download.downloadState),
    'A download of this attachment is already pending; no new action should be requested',
    'DOWNLOAD_ALREADY_PENDING'
  );
  const directory = await pinDownloadDirectory(baseline.directory);
  return { ...identity, fileOwnerTeamId, baseline, directory };
}

function verifyViewerRecordOwner(record, owner) {
  const route = parseObservedDownloadURL(record.url);
  requireState(
    route.teamId === owner.teamId && route.fileId === owner.fileId,
    'Viewer download record URL does not match the verified source owner and file'
  );
}

export async function prepareViewerDownloadState(statePath, { sourceURL, contextId }) {
  const owner = parseViewerSourceURL(sourceURL, contextId);
  const prepared = await prepareDownloadIdentity(
    statePath,
    { teamId: contextId, fileId: owner.fileId, sourceURL },
    owner.teamId
  );
  if (prepared.baseline.download) verifyViewerRecordOwner(prepared.baseline.download, owner);
  return { ...prepared, correlation: 'viewer-file-identity' };
}

async function completedFile(downloadPath, directory) {
  requireState(
    typeof downloadPath === 'string' &&
      path.isAbsolute(downloadPath) &&
      path.resolve(downloadPath) === downloadPath &&
      [directory.path, directory.configuredPath].includes(path.dirname(downloadPath)),
    'Completed download is not a direct child of the pinned directory'
  );
  const sourcePath = path.join(directory.path, path.basename(downloadPath));
  let handle;
  try {
    const before = await lstat(sourcePath, { bigint: true });
    requireState(
      regular(before) && before.size <= MAX_DOWNLOAD_BYTES,
      'Completed download is not an owned bounded regular file'
    );
    handle = await open(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const opened = await handle.stat({ bigint: true }),
      current = await lstat(sourcePath, { bigint: true });
    requireState(
      regular(opened) && sameStat(before, opened) && sameStat(opened, current),
      'Completed download changed during verification'
    );
    const parent = await pinDownloadDirectory(directory.configuredPath);
    requireState(
      parent.path === directory.path &&
        parent.device === directory.device &&
        parent.inode === directory.inode,
      'Download directory changed during verification'
    );
    return { sourcePath, expectedSource: fileReceipt(opened) };
  } finally {
    await handle?.close();
  }
}

export async function waitForDownload(statePath, options) {
  const identity = parseObservedDownloadURL(options.url);
  return monitorDownload(statePath, options, identity, (record) => {
    requireState(record.url === options.url, 'Download action identity changed during monitoring');
  });
}

export async function waitForViewerDownload(statePath, options) {
  const owner = parseViewerSourceURL(options.sourceURL, options.teamId);
  requireState(
    options.correlation === 'viewer-file-identity' &&
      options.fileOwnerTeamId === owner.teamId &&
      options.fileId === owner.fileId,
    'Viewer download monitoring source identity is invalid'
  );
  if (options.baseline?.download) verifyViewerRecordOwner(options.baseline.download, owner);
  let freshURL = null;
  return monitorDownload(
    statePath,
    options,
    owner,
    (record) => {
      verifyViewerRecordOwner(record, owner);
      requireState(
        freshURL === null || record.url === freshURL,
        'Viewer download URL changed after its first fresh record'
      );
      freshURL ??= record.url;
    },
    {
      correlation: 'viewer-file-identity',
      sourceURL: owner.sourceURL,
      fileOwnerTeamId: owner.teamId,
    }
  );
}

async function monitorDownload(
  statePath,
  {
    baseline,
    fileId,
    teamId,
    directory,
    startedAt,
    signal,
    timeoutMs = 60000,
    pollIntervalMs = 250,
  },
  identity,
  verifyURL,
  evidence = {}
) {
  validIDs({ teamId, fileId });
  requireState(
    identity.fileId === fileId &&
      baseline &&
      baseline.teamId === teamId &&
      baseline.fileId === fileId &&
      typeof baseline.observedAt === 'number' &&
      Number.isSafeInteger(startedAt) &&
      startedAt >= baseline.observedAt &&
      startedAt <= Date.now() &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 60000 &&
      Number.isSafeInteger(pollIntervalMs) &&
      pollIntervalMs >= 1 &&
      pollIntervalMs <= 1000 &&
      directory &&
      typeof directory.path === 'string' &&
      typeof directory.configuredPath === 'string' &&
      /^\d+$/.test(directory.device) &&
      /^\d+$/.test(directory.inode),
    'Download monitoring identity, directory or timing is invalid'
  );
  requireState(
    !baseline.download || !activeStates.has(baseline.download.downloadState),
    'Baseline already contains an active download',
    'DOWNLOAD_ALREADY_PENDING'
  );
  const deadline = performance.now() + timeoutMs;
  let freshStart = null;
  while (performance.now() < deadline) {
    requireState(
      !signal?.aborted,
      'Download monitoring cancelled; Slack was not cancelled',
      'DOWNLOAD_CANCELLED'
    );
    const snapshot = await readDownloadState(statePath, { teamId, fileId });
    requireState(
      snapshot.directory === baseline.directory,
      'Slack download directory preference changed during monitoring'
    );
    const pinned = await pinDownloadDirectory(snapshot.directory);
    requireState(
      pinned.path === directory.path &&
        pinned.device === directory.device &&
        pinned.inode === directory.inode,
      'Pinned download directory changed during monitoring'
    );
    const record = snapshot.download;
    if (freshStart !== null && !record)
      fail('Requested download was removed or cancelled', 'DOWNLOAD_CANCELLED');
    if (
      record &&
      record.startTime >= startedAt &&
      (!baseline.download || record.startTime > baseline.download.startTime)
    ) {
      requireState(
        record.startTime <= snapshot.observedAt &&
          (freshStart === null || record.startTime === freshStart),
        'Download action identity changed during monitoring'
      );
      verifyURL(record);
      freshStart ??= record.startTime;
      if (['cancelled', 'canceled'].includes(record.downloadState))
        fail('Requested download was cancelled by Slack', 'DOWNLOAD_CANCELLED');
      if (record.downloadState === 'interrupted')
        fail('Requested download failed or was interrupted', 'DOWNLOAD_FAILED');
      if (record.downloadState === 'completed') {
        requireState(
          Number.isSafeInteger(record.endTime) &&
            record.endTime >= record.startTime &&
            record.endTime <= snapshot.observedAt &&
            typeof record.downloadPath === 'string',
          'Completed download lacks verified timing or path'
        );
        try {
          const source = await completedFile(record.downloadPath, directory);
          requireState(
            !signal?.aborted,
            'Download monitoring cancelled; Slack was not cancelled',
            'DOWNLOAD_CANCELLED'
          );
          return {
            ...source,
            download: record,
            directory,
            observedAt: snapshot.observedAt,
            ...evidence,
          };
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    } else if (freshStart !== null) fail('Requested download record was replaced with stale state');
    await pause(Math.min(pollIntervalMs, Math.max(1, deadline - performance.now())), signal);
  }
  fail(
    'Download completion was not verified within the monitoring deadline; Slack may still be downloading',
    'DOWNLOAD_TIMEOUT'
  );
}
