// Resolve metadata from fresh verified observations; no Slack input or media I/O.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseObservedDownloadURL, parseViewerSourceURL } from './slack-download-store.mjs';

const MAX_ENTRIES = 1000;
const MAX_BYTES = 512 * 1024;
const MAX_AGE = 24 * 60 * 60 * 1000;
const messagePattern = /^[CDG][A-Z0-9]+:\d{10}\.\d{6}$/;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const refresh =
  'Refresh the source with read-channel, read-dm, read-thread or search, then use its newly offered attachment reference.';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function parseMediaReference(value) {
  assert(
    typeof value === 'string' && value.length <= 256 && !/[\r\n]/.test(value),
    'Use an attachment file ID or CONVERSATION:TIMESTAMP/mN reference from read/search output'
  );
  if (/^F[A-Z0-9]+$/.test(value)) return { kind: 'file', ref: value, fileId: value };
  const match = value.match(/^([CDG][A-Z0-9]+:\d{10}\.\d{6})\/m([1-9]\d*)$/);
  assert(
    match && Number.isSafeInteger(Number(match[2])) && Number(match[2]) <= 9999,
    'Use an attachment file ID or CONVERSATION:TIMESTAMP/mN reference; preview /pN references and URLs are not attachments'
  );
  return { kind: 'message', ref: value, messageRef: match[1], ordinal: Number(match[2]) };
}

function workspaceKey(workspace) {
  const value = workspace?.contextId ?? workspace?.id;
  assert(
    typeof value === 'string' && value.length <= 64 && /^[TE][A-Z0-9]+$/.test(value),
    'A verified workspace identity is required to resolve media'
  );
  if (workspace.id != null)
    assert(workspace.id === value, 'Conflicting workspace identities in media observation');
  return value;
}

function messageReference(message) {
  try {
    const url = new URL(message?.permalink);
    const match = url.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/);
    if (
      url.protocol !== 'https:' ||
      !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !match
    )
      return null;
    const reference = `${match[1]}:${match[2]}.${match[3]}`;
    return reference.length <= 256 ? reference : null;
  } catch {
    return null;
  }
}

// Mutable playback/transcript state is metadata, not evidence of file identity.
function attachmentIdentity(media) {
  return [
    media.kind ?? null,
    media.fileId ?? null,
    media.label ?? null,
    media.filename ?? null,
    media.url ?? null,
    media.filePageUrl ?? null,
    media.downloadUrl ?? null,
    media.thumbnailUrl ?? null,
    media.description ?? null,
    media.displayedDuration ?? null,
    media.provenance ?? null,
  ];
}

function orderedDigest(message) {
  assert(Array.isArray(message.attachments), 'Message attachment inventory is unavailable');
  assert(message.attachments.length <= 1000, 'Message attachment inventory exceeds bounds');
  return hash(message.attachments.map(attachmentIdentity));
}

function messages(compact) {
  return [
    ...(Array.isArray(compact.messages) ? compact.messages : []),
    ...(compact.thread?.root ? [compact.thread.root] : []),
    ...(Array.isArray(compact.thread?.replies) ? compact.thread.replies : []),
  ];
}

function validEntry(entry, now, version) {
  const keys = Object.keys(entry ?? {});
  const base = ['workspace', 'messageRef', 'digest', 'rememberedAt'];
  const extended = version === 2 && keys.length === 5 && keys.includes('media');
  return (
    entry &&
    (keys.length === 4 || extended) &&
    base.every((key) => keys.includes(key)) &&
    typeof entry.workspace === 'string' &&
    entry.workspace.length <= 64 &&
    /^[TE][A-Z0-9]+$/.test(entry.workspace) &&
    typeof entry.messageRef === 'string' &&
    entry.messageRef.length <= 256 &&
    messagePattern.test(entry.messageRef) &&
    typeof entry.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.digest) &&
    Number.isSafeInteger(entry.rememberedAt) &&
    entry.rememberedAt <= now &&
    entry.rememberedAt >= now - MAX_AGE &&
    (!extended || validRememberedMedia(entry.media, entry.messageRef))
  );
}

function validRememberedMedia(media, messageRef) {
  if (!Array.isArray(media) || media.length > 1000) return false;
  const seen = new Set();
  return media.every((item) => {
    if (
      !item ||
      Object.keys(item).length !== 2 ||
      !/^[a-f0-9]{64}$/.test(item.digest ?? '') ||
      typeof item.ref !== 'string' ||
      seen.has(item.ref)
    )
      return false;
    try {
      const reference = parseMediaReference(item.ref);
      if (
        (reference.kind === 'file' && reference.fileId.length > 64) ||
        (reference.kind === 'message' && reference.messageRef !== messageRef)
      )
        return false;
    } catch {
      return false;
    }
    seen.add(item.ref);
    return true;
  });
}

function usableEntries(cache, now = Date.now()) {
  if (![1, 2].includes(cache?.schemaVersion) || !Array.isArray(cache.entries)) return [];
  if (cache.entries.length > MAX_ENTRIES) return [];
  const seen = new Set();
  const entries = [];
  for (const entry of cache.entries) {
    if (!validEntry(entry, now, cache.schemaVersion)) continue;
    const key = `${entry.workspace}:${entry.messageRef}`;
    // Duplicate bindings are ambiguous, even when their hashes happen to agree.
    if (seen.has(key)) return [];
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

const privateFile = (info) =>
  info.isFile() &&
  (info.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || info.uid === process.getuid());

export async function loadMediaReferences(cachePath) {
  let handle;
  const empty = (status) => ({ schemaVersion: 1, entries: [], status });
  try {
    const info = await lstat(cachePath);
    if (!privateFile(info) || info.size > MAX_BYTES) return empty('invalid');
    handle = await open(cachePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!privateFile(opened) || opened.ino !== info.ino || opened.dev !== info.dev)
      return empty('invalid');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return empty('invalid');
    const cache = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (![1, 2].includes(cache?.schemaVersion) || !Array.isArray(cache.entries))
      return empty('invalid');
    const entries = usableEntries(cache);
    return { schemaVersion: cache.schemaVersion, entries, status: 'loaded' };
  } catch (error) {
    return empty(error.code === 'ENOENT' ? 'missing' : 'invalid');
  } finally {
    await handle?.close();
  }
}

// Caller holds the shared helper lease. Only hashes/identifiers/times reach disk.
function rememberedMedia(message, messageRef) {
  const records = new Map();
  for (const [index, media] of message.attachments.entries()) {
    if (media?.contentRead !== false) continue;
    const file =
      media.referenceScope === 'workspace-file' &&
      typeof media.fileId === 'string' &&
      /^F[A-Z0-9]{1,63}$/.test(media.fileId) &&
      media.ref === media.fileId;
    const ordinal =
      media.referenceScope === 'message-media' &&
      !media.fileId &&
      media.ref === `${messageRef}/m${index + 1}`;
    if (!file && !ordinal) continue;
    const digest = file ? fileMetadataIdentity(media) : hash(attachmentIdentity(media));
    if (records.has(media.ref) && records.get(media.ref) !== digest) return [];
    records.set(media.ref, digest);
  }
  return [...records].map(([ref, digest]) => ({ ref, digest }));
}

export async function rememberMediaReferences(cachePath, compacts) {
  assert(Array.isArray(compacts), 'Media reference observations must be an array');
  const now = Date.now();
  const prior = await loadMediaReferences(cachePath);
  const records = new Map(
    usableEntries(prior, now).map((entry) => [`${entry.workspace}:${entry.messageRef}`, entry])
  );
  const observed = new Map();
  const conflicts = new Set();
  for (const compact of compacts) {
    if (!compact?.workspace || compact.status === 'stopped') continue;
    const workspace = workspaceKey(compact.workspace);
    for (const message of messages(compact)) {
      const messageRef = messageReference(message);
      if (!messageRef || !Array.isArray(message.attachments)) continue;
      const key = `${workspace}:${messageRef}`;
      const digest = orderedDigest(message);
      const media = rememberedMedia(message, messageRef);
      const signature = hash([digest, media]);
      if (observed.has(key) && observed.get(key) !== signature) conflicts.add(key);
      observed.set(key, signature);
      if (media.length)
        records.set(key, { workspace, messageRef, digest, rememberedAt: now, media });
      else records.delete(key);
    }
  }
  for (const key of conflicts) records.delete(key);
  const cache = {
    schemaVersion: 2,
    entries: [...records.values()]
      .sort((a, b) => b.rememberedAt - a.rememberedAt)
      .slice(0, MAX_ENTRIES),
  };
  let encoded = `${JSON.stringify(cache)}\n`;
  while (Buffer.byteLength(encoded) > MAX_BYTES && cache.entries.length) {
    cache.entries.pop();
    encoded = `${JSON.stringify(cache)}\n`;
  }
  const directory = path.dirname(cachePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  assert(
    parent.isDirectory() &&
      (parent.mode & 0o077) === 0 &&
      (typeof process.getuid !== 'function' || parent.uid === process.getuid()),
    'Media reference cache directory must be private and owned by the current user'
  );
  try {
    const existing = await lstat(cachePath);
    assert(existing.isFile(), 'Media reference cache must be a regular file, not a symbolic link');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(directory, `.media-references-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(encoded);
    await handle.close();
    handle = null;
    await rename(temporary, cachePath);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return cache;
}

function sourceRecord(message) {
  const reference = messageReference(message);
  const candidate = message.thread;
  const thread =
    candidate &&
    typeof candidate.ref === 'string' &&
    messagePattern.test(candidate.ref) &&
    candidate.navigation?.command === 'read-thread' &&
    candidate.navigation.args?.length === 1 &&
    candidate.navigation.args[0] === candidate.ref
      ? candidate
      : null;
  return {
    messageRef: reference,
    permalink: reference ? message.permalink : null,
    author: typeof message.author === 'string' ? message.author : null,
    ...(message.authorInferred === true
      ? { authorInferred: true, authorSourceMessageId: message.authorSourceMessageId ?? null }
      : {}),
    thread,
  };
}

function matches(observation, reference) {
  assert(Array.isArray(observation.messages), 'Verified exposed messages are unavailable');
  const found = [];
  for (const message of observation.messages) {
    const messageRef = messageReference(message);
    if (!messageRef || !Array.isArray(message.attachments)) continue;
    if (reference.kind === 'message' && reference.messageRef !== messageRef) continue;
    for (const [index, media] of message.attachments.entries()) {
      const selected =
        reference.kind === 'file'
          ? media.fileId === reference.ref && media.ref === reference.ref
          : index + 1 === reference.ordinal && media.ref === reference.ref && !media.fileId;
      if (selected) {
        assert(media.contentRead === false, 'Expected metadata-only attachment observation');
        found.push({
          media,
          message,
          source: sourceRecord(message),
          digest: orderedDigest(message),
        });
      }
    }
  }
  assert(found.length > 0, `Attachment is not exposed in the verified current view. ${refresh}`);
  return found;
}

function fileMetadataIdentity(media) {
  const { provenance: _provenance, ...metadata } = media;
  return hash(attachmentIdentity(metadata));
}

function verifiedObservations(receipt) {
  assert(receipt?.operation === 'read-media', 'Unexpected media inspection operation');
  assert(
    Array.isArray(receipt.observations) && receipt.observations.length === 2,
    'Media inspection requires two fresh verified observations'
  );
  const [before, after] = receipt.observations;
  const workspace = workspaceKey(before.workspace);
  assert(workspace === workspaceKey(after.workspace), 'Workspace changed during media inspection');
  assert(
    before.view?.url &&
      before.view.url === after.view?.url &&
      before.view.title === after.view.title,
    'View changed during media inspection; inspect current Slack state before retrying'
  );
  assert(
    Array.isArray(before.messages) && Array.isArray(after.messages),
    'Verified exposed messages are unavailable'
  );
  return { before, after, workspace };
}

// Reopening is a distinct capability from failed resolution. A changed, stale,
// partially exposed or ambiguous source must never authorize navigation.
export function classifyMediaExposure(receipt, ref, bindings) {
  const reference = parseMediaReference(ref);
  const { before, after, workspace } = verifiedObservations(receipt);
  const potential = (observation) =>
    observation.messages.some(
      (message) =>
        (reference.kind === 'message' && messageReference(message) === reference.messageRef) ||
        (Array.isArray(message.attachments) &&
          message.attachments.some(
            (media) => media?.ref === ref || (reference.kind === 'file' && media?.fileId === ref)
          ))
    );
  if (potential(before) || potential(after))
    return { status: 'exposed', resolved: resolveMedia(receipt, ref, bindings) };

  const inventory = (observation) => {
    const records = new Map();
    for (const message of observation.messages) {
      const messageRef = messageReference(message);
      assert(
        messageRef,
        `Source reopening requires canonical exposed message identities. ${refresh}`
      );
      const digest = orderedDigest(message);
      assert(
        !records.has(messageRef) || records.get(messageRef) === digest,
        `Conflicting exposed copies prevent source reopening. ${refresh}`
      );
      records.set(messageRef, digest);
    }
    return [...records].sort(([a], [b]) => a.localeCompare(b));
  };
  const earlier = inventory(before),
    current = inventory(after);
  assert(
    JSON.stringify(earlier) === JSON.stringify(current),
    `Exposed message or attachment inventory changed before source reopening. ${refresh}`
  );
  const entries = usableEntries(bindings).filter((entry) => entry.workspace === workspace);
  const candidates = entries.filter((entry) =>
    reference.kind === 'message'
      ? entry.messageRef === reference.messageRef &&
        (!entry.media || entry.media.some((media) => media.ref === ref))
      : entry.media?.some((media) => media.ref === ref)
  );
  assert(
    candidates.length > 0,
    `Attachment reference has no current remembered source in this workspace. ${refresh}`
  );
  if (reference.kind === 'file')
    assert(
      new Set(candidates.map((entry) => entry.media.find((media) => media.ref === ref).digest))
        .size === 1,
      `The file has conflicting remembered source metadata. ${refresh}`
    );
  const exposed = new Set(current.map(([messageRef]) => messageRef));
  assert(
    !candidates.some((entry) => exposed.has(entry.messageRef)),
    `A remembered source is already exposed but its attachment is missing or changed. ${refresh}`
  );
  candidates.sort(
    (a, b) => b.rememberedAt - a.rememberedAt || a.messageRef.localeCompare(b.messageRef)
  );
  return { status: 'absent', source: { workspace, messageRef: candidates[0].messageRef } };
}

export function resolveMedia(receipt, ref, bindings) {
  const reference = parseMediaReference(ref);
  const { before, after, workspace } = verifiedObservations(receipt);
  const earlier = matches(before, reference);
  const current = matches(after, reference);
  const selection = (items) =>
    items
      .map(({ media, source, digest }) => [
        source.messageRef,
        media.ref,
        hash(attachmentIdentity(media)),
        digest,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert(
    JSON.stringify(selection(earlier)) === JSON.stringify(selection(current)),
    `Attachment identity, source or order changed during inspection. ${refresh}`
  );
  if (reference.kind === 'message') {
    const unique = new Set(current.map((item) => item.digest));
    assert(unique.size === 1, `Conflicting exposed copies of the source message. ${refresh}`);
    const selected = hash(attachmentIdentity(current[0].media));
    assert(
      current[0].message.attachments.filter((media) => hash(attachmentIdentity(media)) === selected)
        .length === 1,
      `The ordinal identifies indistinguishable attachments; identity cannot be verified. ${refresh}`
    );
    const binding = usableEntries(bindings).find(
      (entry) => entry.workspace === workspace && entry.messageRef === reference.messageRef
    );
    assert(
      binding,
      `Attachment reference has no current remembered binding in this workspace. ${refresh}`
    );
    assert(
      binding.digest === current[0].digest,
      `Attachment order or identity changed since the reference was offered. ${refresh}`
    );
  } else {
    assert(
      new Set(current.map(({ media }) => fileMetadataIdentity(media))).size === 1,
      `The file has conflicting metadata across exposed messages. ${refresh}`
    );
  }
  const sources = [
    ...new Map(current.map(({ source }) => [JSON.stringify(source), source])).values(),
  ];
  const provenances = [
    ...new Map(
      current.map(({ media }) => [
        JSON.stringify(media.provenance ?? null),
        media.provenance ?? null,
      ])
    ).values(),
  ];
  const media = {
    ...current[0].media,
    ...(provenances.length > 1 ? { provenance: null } : {}),
    navigation: { command: 'read-media', args: [ref] },
  };
  let canSave = false;
  try {
    const target = parseObservedDownloadURL(media.downloadUrl);
    canSave = !media.fileId || media.fileId === target.fileId;
  } catch {
    if (!media.downloadUrl && media.kind === 'image' && media.fileId) {
      try {
        canSave =
          parseViewerSourceURL(media.url, after.workspace.contextId ?? after.workspace.id)
            .fileId === media.fileId;
      } catch {
        /* Unsupported image sources receive no viewer-save hint. */
      }
    }
  }
  if (
    !canSave &&
    !media.downloadUrl &&
    ['file', 'document', 'audio', 'video'].includes(media.kind) &&
    media.fileDetailsAvailable === true &&
    typeof media.fileId === 'string' &&
    /^[F][A-Z0-9]+$/.test(media.fileId) &&
    media.fileId.length <= 64
  )
    canSave = true;
  if (canSave)
    media.saveNavigation = { command: 'save-media', args: [ref], requiredOption: '--output=PATH' };
  const navigation = [
    ...new Map(
      sources
        .filter((source) => source.thread)
        .map((source) => [source.thread.ref, source.thread.navigation])
    ).values(),
  ];
  return {
    schemaVersion: 1,
    operation: 'read-media',
    status: 'ok',
    requested: ref,
    workspace: after.workspace,
    view: after.view,
    media,
    sources: sources.map((source) => ({
      ...source,
      provenance: current
        .filter((item) => item.source.messageRef === source.messageRef)
        .map((item) => item.media.provenance ?? null),
    })),
    navigation,
    coverage: {
      scope: 'exposed attachment metadata',
      complete: false,
      contentRead: false,
      sourceCount: sources.length,
      referenceBinding:
        reference.kind === 'file' ? 'current-workspace-file' : 'remembered-message-order',
      reason:
        'Observed accessibility metadata only; no preview was opened, and no file bytes or transcript content were read.',
    },
  };
}
