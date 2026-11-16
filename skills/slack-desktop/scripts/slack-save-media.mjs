// Resolve only an observed Download control inside a freshly verified attachment.
import { extractMedia, isMediaRoot } from './slack-media.mjs';
import { indexTree } from './slack-output.mjs';
import { parseMediaReference } from './slack-read-media.mjs';
import { parseObservedDownloadURL, parseViewerSourceURL } from './slack-download-store.mjs';
import { parseFilePageURL } from './slack-file-page.mjs';

const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const has = (node, name) => node?.classes?.includes(name) === true;
const downloadLabel = (label) =>
  typeof label === 'string' &&
  Buffer.byteLength(label) <= 2048 &&
  !/[\x00-\x1f\x7f]/.test(label) &&
  !['Download all', 'Download all files'].includes(label) &&
  (label === 'Download' || (label.startsWith('Download ') && label.slice(9).trim().length > 0));
const routeKinds = new Set(['file-download', 'rendition', 'unknown']);
const encodedBasename = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/;
const fields = [
  'kind',
  'fileId',
  'ref',
  'referenceScope',
  'label',
  'filename',
  'url',
  'thumbnailUrl',
  'filePageUrl',
  'downloadUrl',
  'description',
  'displayedDuration',
];

function messageReference(value) {
  try {
    const u = new URL(value);
    const match = u.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/);
    if (
      u.protocol !== 'https:' ||
      !/^(?:[a-z0-9-]+\.)*slack\.com$/.test(u.hostname) ||
      u.username ||
      u.password ||
      u.port ||
      u.hash ||
      !match
    )
      return null;
    return `${match[1]}:${match[2]}.${match[3]}`;
  } catch {
    return null;
  }
}

function decodedFilename(value) {
  try {
    const name = decodeURIComponent(value);
    return name && !['.', '..'].includes(name) && !/[\/\\\x00-\x1f\x7f-\x9f]/.test(name)
      ? name
      : null;
  } catch {
    return null;
  }
}

// A URL shape identifies Slack's file-content route, not equality to historical
// uploader bytes. A matching source-owned file page supplies the separate proof.
export function downloadRouteKind(value, contextId) {
  const url = new URL(value);
  if (url.pathname.startsWith('/files-tmb/')) return 'rendition';
  const match = value.match(
    /^https:\/\/files\.slack\.com\/files-pri\/(T[A-Z0-9]+)-(F[A-Z0-9]+)\/download\/([^/?#]+)(?:\?([^#]*))?$/
  );
  if (!match || !encodedBasename.test(match[3]) || !decodedFilename(match[3])) return 'unknown';
  if (match[4] === undefined) return 'file-download';
  return /^[TE][A-Z0-9]+$/.test(contextId ?? '') && match[4] === `origin_team=${contextId}`
    ? 'file-download'
    : 'unknown';
}

export function fileDownloadEvidence(value, media, contextId) {
  if (
    !/^[TE][A-Z0-9]+$/.test(contextId ?? '') ||
    downloadRouteKind(value, contextId) !== 'file-download'
  )
    return null;
  try {
    const target = parseObservedDownloadURL(value),
      download = new URL(value);
    const page = parseFilePageURL(media.filePageUrl, contextId);
    if (
      page.fileId !== target.fileId ||
      media.fileId !== target.fileId ||
      page.basename !== decodedFilename(download.pathname.split('/').at(-1))
    )
      return null;
    return { filePageUrl: media.filePageUrl, fileId: target.fileId, contextId };
  } catch {
    return null;
  }
}

function ownedDownloads(media, tree) {
  const within = new Set(tree.descendants(media).map((n) => n.index));
  return tree.descendants(media).filter((node) => {
    if (
      node.role !== 'AXLink' ||
      !downloadLabel(node.label) ||
      tree.ancestor(
        node,
        (parent) =>
          within.has(parent.index) && (isMediaRoot(parent) || has(parent, 'c-message_kit__actions'))
      )
    )
      return false;
    try {
      parseObservedDownloadURL(node.url);
      return true;
    } catch {
      return false;
    }
  });
}

function sourceMedia(tree, resolved, reference) {
  const groups = [];
  for (const container of tree.nodes.filter((node) => has(node, 'c-message_kit__actions'))) {
    const timestamps = tree
      .descendants(container)
      .filter(
        (node) =>
          node.role === 'AXLink' &&
          has(node, 'c-timestamp') &&
          !tree.ancestor(node, (parent) => has(parent, 'c-message_attachment'))
      );
    if (timestamps.length !== 1) continue;
    const messageRef = messageReference(timestamps[0].url);
    if (
      !messageRef ||
      !resolved.sources?.some(
        (source) => source.messageRef === messageRef && source.permalink === timestamps[0].url
      )
    )
      continue;
    const indexed = new Map(tree.nodes.map((node) => [node.index, node]));
    for (const binding of extractMedia(container, tree, { messageRef }).bindings) {
      if (binding.media.ref !== reference.ref) continue;
      requireState(
        fields.every((key) => (binding.media[key] ?? null) === (resolved.media[key] ?? null)),
        'Download candidate differs from the verified attachment'
      );
      const media = indexed.get(binding.rootIndex);
      groups.push({
        container,
        media,
        binding,
        messageRef,
        downloads: ownedDownloads(media, tree),
      });
    }
  }
  return groups;
}

function sourceInventory(groups) {
  return groups
    .map(({ messageRef, downloads }) =>
      JSON.stringify([
        messageRef,
        downloads
          .map(({ label, url }) => [label, url])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ])
    )
    .sort();
}

// Shared source proof. Viewer fallback must use the same immutable resolution as
// a message Download, rather than resolving a cloned source inside the viewer.
export function verifiedSaveMediaSource(preflight, resolved) {
  const reference = parseMediaReference(preflight?.requested);
  requireState(
    preflight?.operation === 'save-media' &&
      ['select', 'source-select'].includes(preflight.phase) &&
      resolved?.status === 'ok' &&
      resolved.requested === reference.ref &&
      resolved.media?.ref === reference.ref,
    'Download selection requires the verified requested attachment'
  );
  requireState(
    Array.isArray(preflight.observations) && preflight.observations.length === 2,
    'Download selection requires two source captures'
  );
  const observation = preflight.observations[1];
  requireState(
    preflight.observations.every((capture) => capture.content?.truncated === false),
    'Download source capture is incomplete'
  );
  const tree = indexTree(observation.content.nodes);
  const rootURL = new URL(tree.root.url);
  requireState(
    tree.root.role === 'AXWebArea' &&
      rootURL.protocol === 'https:' &&
      rootURL.hostname === 'app.slack.com' &&
      tree.root.url === resolved.view?.url &&
      tree.root.label === resolved.view?.title &&
      rootURL.pathname.split('/')[2] === (resolved.workspace?.contextId ?? resolved.workspace?.id),
    'Download source differs from the verified workspace/view'
  );
  requireState(
    Array.isArray(preflight.candidates) && preflight.candidates.length <= 1000,
    'Download candidate inventory is unavailable or exceeds bounds'
  );
  const indexed = new Map(tree.nodes.map((n) => [n.index, n]));
  const contextId = resolved.workspace?.contextId ?? resolved.workspace?.id;
  const groups = sourceMedia(tree, resolved, reference);
  const earlierTree = indexTree(preflight.observations[0].content.nodes);
  const earlier = sourceMedia(earlierTree, resolved, reference);
  requireState(
    JSON.stringify(sourceInventory(earlier)) === JSON.stringify(sourceInventory(groups)),
    'Download targets changed between source captures'
  );
  return { reference, tree, indexed, contextId, groups, earlier, earlierTree };
}

export function selectSaveMediaCandidate(preflight, resolved, { originalRequired = false } = {}) {
  requireState(
    typeof originalRequired === 'boolean',
    'Original selection requirement must be boolean'
  );
  const { reference, tree, indexed, contextId, groups } = verifiedSaveMediaSource(
    preflight,
    resolved
  );
  const tokens = new Set(),
    controls = new Set(),
    matches = [];
  for (const candidate of preflight.candidates) {
    requireState(
      candidate &&
        typeof candidate.token === 'string' &&
        !/[^A-Za-z0-9-]/.test(candidate.token) &&
        /^[A-Za-z0-9-]{1,128}$/.test(candidate.token) &&
        ['mediaIndex', 'containerIndex', 'controlIndex'].every(
          (k) => Number.isSafeInteger(candidate[k]) && candidate[k] >= 0
        ) &&
        typeof candidate.url === 'string' &&
        routeKinds.has(candidate.routeKind) &&
        !tokens.has(candidate.token) &&
        !controls.has(candidate.controlIndex),
      'Download candidate identity is malformed or duplicated'
    );
    tokens.add(candidate.token);
    controls.add(candidate.controlIndex);
    const container = indexed.get(candidate.containerIndex),
      media = indexed.get(candidate.mediaIndex),
      control = indexed.get(candidate.controlIndex);
    requireState(
      container &&
        has(container, 'c-message_kit__actions') &&
        media &&
        control &&
        tree.descendants(container).includes(media) &&
        tree.descendants(media).includes(control) &&
        control.role === 'AXLink' &&
        downloadLabel(control.label) &&
        control.url === candidate.url,
      'Download control has changed or is outside its captured attachment'
    );
    const within = new Set(tree.descendants(media).map((n) => n.index));
    requireState(
      !tree.ancestor(
        control,
        (n) => within.has(n.index) && (isMediaRoot(n) || has(n, 'c-message_kit__actions'))
      ),
      'Download control belongs to a different nested attachment'
    );
    const group = groups.find(
      (entry) => entry.container.index === container.index && entry.media.index === media.index
    );
    if (!group) continue;
    const route = parseObservedDownloadURL(candidate.url);
    requireState(
      (!resolved.media.fileId || route.fileId === resolved.media.fileId) &&
        (reference.kind !== 'file' || route.fileId === reference.fileId),
      'Download URL does not identify the selected attachment'
    );
    requireState(
      candidate.routeKind === downloadRouteKind(candidate.url, contextId),
      'Download route classification differs from the observed URL'
    );
    requireState(
      group.downloads.includes(control),
      'Download control does not belong to its verified source inventory'
    );
    matches.push({
      ...candidate,
      route,
      fileDownloadEvidence: fileDownloadEvidence(candidate.url, group.binding.media, contextId),
    });
  }
  requireState(
    groups.every((group) =>
      group.downloads.every((control) =>
        matches.some(
          (candidate) =>
            candidate.containerIndex === group.container.index &&
            candidate.mediaIndex === group.media.index &&
            candidate.controlIndex === control.index
        )
      )
    ),
    'Supported Download inventory is incomplete; no target was selected'
  );
  const preferred = matches.filter((candidate) => candidate.fileDownloadEvidence !== null);
  requireState(
    new Set(preferred.map((candidate) => candidate.url)).size <= 1,
    'Conflicting source-bound file Download targets; reread the source before selecting'
  );
  if (originalRequired && !preferred.length)
    throw new Error(
      'No source-bound original file Download route is exposed. Rerun without --original to allow the observed target, or reread the source to expose its original route.'
    );
  requireState(
    matches.length > 0,
    'No supported Download control matches the attachment; inspect or reread its source'
  );
  const eligible = preferred.length ? preferred : matches;
  requireState(
    new Set(eligible.map((candidate) => candidate.url)).size === 1,
    'Observed Download targets are ambiguous; reread the source before selecting'
  );
  eligible.sort((a, b) => a.controlIndex - b.controlIndex);
  return eligible[0];
}

export function verifyDetailsMenuAction(value, openerKind) {
  requireState(
    ['details-button', 'video-menu'].includes(openerKind) &&
      value &&
      ['attempted', 'accepted', 'detailsAttempted', 'detailsAccepted', 'closed'].every(
        (key) => value[key] === (openerKind === 'video-menu')
      ),
    'File-details menu navigation or closure is not verified'
  );
}

export function verifySavePhase(value, preflight, selected, phase) {
  const viewer = ['viewer', 'file-details'].includes(selected?.scope);
  const details = selected?.scope === 'file-details';
  const selectionKeys = details
    ? [
        'token',
        'scope',
        'openerToken',
        'paneIndex',
        'cardIndex',
        'fileLinkIndex',
        'identityIndex',
        'footerIndex',
        'controlIndex',
        'filePageURL',
        'fileId',
        'mediaKind',
        'openerKind',
        'url',
        'routeKind',
      ]
    : viewer
      ? [
          'token',
          'scope',
          'openerToken',
          'viewerIndex',
          'branchIndex',
          'mediaIndex',
          'imageIndex',
          'footerIndex',
          'controlIndex',
          'url',
          'sourceURL',
          'fileId',
          'ownerTeamId',
          'routeKind',
        ]
      : ['token', 'mediaIndex', 'containerIndex', 'controlIndex', 'url', 'routeKind'];
  requireState(
    value?.operation === 'save-media' &&
      value.phase === phase &&
      value.requested === preflight.requested &&
      value.pid === preflight.pid &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      routeKinds.has(selected?.routeKind) &&
      selectionKeys.every((k) => value.selection?.[k] === selected[k]),
    'Download receipt does not match its verified selection'
  );
  requireState(
    value.verification?.sourceMatched === true &&
      value.verification?.downloadRequested === true &&
      value.verification?.playbackUnchanged === true &&
      value.action?.attempted === true &&
      value.action?.accepted === true &&
      Number.isSafeInteger(value.action.startedAt) &&
      value.action.startedAt > 0,
    'Download input or source verification is incomplete'
  );
  if (viewer) {
    saveMediaSelectionOutput(selected);
    requireState(
      value.verification?.viewerMatched === true &&
        value.viewerAction?.attempted === true &&
        value.viewerAction?.accepted === true &&
        value.viewerAction?.opened === true &&
        (phase !== 'result' || value.viewerAction.closed === true),
      'Viewer Download receipt lacks verified viewer continuity'
    );
    if (details) {
      verifyDetailsMenuAction(value.detailsMenuAction, selected.openerKind);
      const playback = value.detailsPlayback;
      requireState(
        playback &&
          JSON.stringify(playback.before) === JSON.stringify(selected.detailsPlayback) &&
          JSON.stringify(playback.after) === JSON.stringify(selected.detailsPlayback),
        'File-details playback changed after its verified selection'
      );
    }
  }
}

export function saveMediaSelectionOutput(selected) {
  requireState(
    selected && routeKinds.has(selected.routeKind),
    'Verified Download selection is missing'
  );
  if (selected.scope === 'viewer') {
    const source = parseViewerSourceURL(selected.sourceURL, selected.contextId);
    requireState(
      selected.url === null &&
        selected.routeKind === 'unknown' &&
        selected.fileDownloadEvidence === null &&
        selected.correlation === 'viewer-file-identity' &&
        selected.fileId === source.fileId &&
        selected.ownerTeamId === source.teamId &&
        selected.route?.fileId === source.fileId &&
        selected.route?.teamId === source.teamId &&
        selected.route.url === undefined,
      'Viewer Download selection identity is invalid'
    );
    return {
      representation: 'observed-viewer-download',
      originalSelection: { status: 'unavailable', basis: 'viewer-download-route-unexposed' },
      originalFile: null,
    };
  }
  if (selected.scope === 'file-details') {
    verifyDetailsMenuAction(selected.detailsMenuAction, selected.openerKind);
    const route = parseObservedDownloadURL(selected.url);
    const page =
      selected.filePageURL === null
        ? null
        : parseFilePageURL(selected.filePageURL, selected.contextId);
    const playback = selected.detailsPlayback;
    const idle = (values, required = false) =>
      Array.isArray(values) &&
      (!required || values.length > 0) &&
      values.every(
        (value) => value && /^Play(?:,|$)/.test(value.label ?? '') && value.value === '0'
      );
    requireState(
      /^[TE][A-Z0-9]+$/.test(selected.contextId ?? '') &&
        route.fileId === selected.fileId &&
        (!page || page.fileId === selected.fileId) &&
        selected.route?.url === selected.url &&
        selected.route?.fileId === route.fileId &&
        selected.route?.teamId === route.teamId &&
        selected.routeKind === downloadRouteKind(selected.url, selected.contextId) &&
        ['file', 'audio', 'video'].includes(selected.mediaKind) &&
        playback &&
        idle(playback.source, ['audio', 'video'].includes(selected.mediaKind)) &&
        idle(playback.viewer) &&
        ['details-button', 'video-menu'].includes(selected.openerKind) &&
        (selected.fileDownloadEvidence === null ||
          selected.fileDownloadEvidence?.filePageUrl === selected.filePageURL),
      'File-details Download selection identity or playback is invalid'
    );
  }
  const evidence = selected.fileDownloadEvidence;
  const original =
    selected.routeKind === 'file-download' &&
    evidence &&
    JSON.stringify(
      fileDownloadEvidence(
        selected.url,
        { fileId: evidence.fileId, filePageUrl: evidence.filePageUrl },
        evidence.contextId
      )
    ) === JSON.stringify(evidence);
  requireState(evidence === null || original, 'Original file selection evidence is invalid');
  return {
    representation: original ? 'slack-file-download' : 'observed-download-target',
    originalSelection: original
      ? { status: 'selected', basis: 'source-bound-private-file-download' }
      : { status: 'unavailable', basis: 'observed-download-target' },
    originalFile: null,
  };
}

export function savedMediaOutput(resolved, publication, download, destination, selected) {
  const selection = saveMediaSelectionOutput(selected);
  const viewer = selected.scope === 'viewer';
  let urlMatches = download?.download?.url === selected.url;
  if (viewer) {
    const actual = parseObservedDownloadURL(download?.download?.url);
    urlMatches =
      download.correlation === 'viewer-file-identity' &&
      download.sourceURL === selected.sourceURL &&
      download.fileOwnerTeamId === selected.ownerTeamId &&
      actual.teamId === selected.ownerTeamId &&
      actual.fileId === selected.fileId &&
      selected.contextId === (resolved.workspace?.contextId ?? resolved.workspace?.id);
  }
  const artifact = publication?.artifact;
  requireState(
    publication?.operation === 'save-media-publish' &&
      publication.status === 'ok' &&
      artifact?.published === true &&
      artifact.verified === true &&
      typeof artifact.path === 'string' &&
      artifact.path === destination &&
      artifact.path.startsWith('/') &&
      Number.isSafeInteger(artifact.bytes) &&
      artifact.bytes >= 0 &&
      /^[a-f0-9]{64}$/.test(artifact.sha256),
    'Saved attachment receipt is incomplete or unverified'
  );
  requireState(
    download?.download?.downloadState === 'completed' &&
      urlMatches &&
      download.download.id === selected.route?.fileId &&
      download.download.teamId === (resolved.workspace?.contextId ?? resolved.workspace?.id) &&
      publication.source?.path === download.sourcePath &&
      ['device', 'inode', 'size', 'mtimeNs'].every(
        (k) => publication.source?.identity?.[k] === download.expectedSource?.[k]
      ) &&
      String(artifact.bytes) === download.expectedSource.size,
    'Native download completion or published file identity is unverified'
  );
  return {
    schemaVersion: 1,
    operation: 'save-media',
    status: 'ok',
    requested: resolved.requested,
    workspace: resolved.workspace,
    view: resolved.view,
    media: resolved.media,
    sources: resolved.sources,
    navigation: resolved.navigation,
    saved: {
      ...artifact,
      contentType: null,
      ...selection,
      ...(viewer ? { correlation: 'viewer-file-identity' } : {}),
      nativePath: download.download.downloadPath,
    },
    coverage: {
      scope: 'verified local copy of the selected Slack Download target',
      mediaBytesRead: true,
      contentInterpreted: false,
      originalFileVerified: null,
      reason:
        selection.originalSelection.status === 'selected'
          ? 'The source-bound Slack file-content Download route was selected. Equality to the originally uploaded bytes remains unknown; Slack retains its native download copy.'
          : 'Slack retains its normal download copy. No source-bound original file route was exposed; the observed Download representation may differ from the originally uploaded file.',
    },
  };
}
