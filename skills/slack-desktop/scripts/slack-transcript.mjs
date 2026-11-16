// Pure selection and extraction. Opening the verified existing transcript belongs
// to the native guarded transition; timestamps/text are never action targets.
import { extractMedia, isMediaRoot } from './slack-media.mjs';
import { indexTree } from './slack-output.mjs';
import { parseMediaReference } from './slack-read-media.mjs';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const has = (node, value) => node?.classes?.includes(value) === true;
const readLabel = (node) => (typeof node?.label === 'string' ? node.label : '');
const existingLabel = /^View transcript(?: for this (?:audio|video))?$/;
const generateLabel = /^Generate transcript(?: for this (?:audio|video))?$/;
const validIndex = (value) => Number.isSafeInteger(value) && value >= 0;
const candidateFields = ['token', 'mediaIndex', 'containerIndex', 'controlIndex'];
const identityFields = [
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
const sameIdentity = (a, b) =>
  identityFields.every((field) => (a?.[field] ?? null) === (b?.[field] ?? null));

function sourceReference(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/);
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'slack.com' && !url.hostname.endsWith('.slack.com')) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !match
    )
      return null;
    return `${match[1]}:${match[2]}.${match[3]}`;
  } catch {
    return null;
  }
}

export function selectTranscriptCandidate(receipt, resolved) {
  const reference = parseMediaReference(receipt?.requested);
  assert(
    receipt?.operation === 'read-transcript' &&
      resolved?.status === 'ok' &&
      resolved.requested === reference.ref &&
      resolved.media?.ref === reference.ref,
    'Transcript selection requires the verified requested media reference'
  );
  assert(
    ['audio', 'video'].includes(resolved.media.kind),
    'Only audio and video attachments have supported transcripts'
  );
  assert(
    resolved.media.transcript?.state === 'available',
    'No existing transcript is exposed for this attachment; generation is never requested'
  );
  assert(
    Array.isArray(receipt.observations) && receipt.observations.length === 2,
    'Transcript selection requires two verified source captures'
  );
  const observation = receipt.observations[1];
  assert(observation?.content?.truncated === false, 'Transcript source capture is incomplete');
  const tree = indexTree(observation.content.nodes);
  let sourceURL;
  try {
    sourceURL = new URL(tree.root.url);
  } catch {
    sourceURL = null;
  }
  assert(
    tree.root.role === 'AXWebArea' &&
      sourceURL?.protocol === 'https:' &&
      sourceURL.hostname === 'app.slack.com' &&
      tree.root.url === resolved.view?.url &&
      readLabel(tree.root) === resolved.view?.title &&
      sourceURL.pathname.split('/')[2] ===
        (resolved.workspace?.contextId ?? resolved.workspace?.id),
    'Transcript source capture differs from the verified workspace/view'
  );
  assert(
    Array.isArray(receipt.candidates) && receipt.candidates.length <= 1000,
    'Transcript controls are unavailable or exceed capture bounds'
  );
  const byIndex = new Map(tree.nodes.map((node) => [node.index, node]));
  const tokens = new Set(),
    controls = new Set(),
    matches = [];
  for (const candidate of receipt.candidates) {
    assert(
      candidate &&
        typeof candidate.token === 'string' &&
        /^[A-Za-z0-9-]{1,128}$/.test(candidate.token) &&
        ['mediaIndex', 'containerIndex', 'controlIndex'].every((key) =>
          validIndex(candidate[key])
        ) &&
        !tokens.has(candidate.token) &&
        !controls.has(candidate.controlIndex),
      'Transcript candidate identity is malformed or duplicated'
    );
    tokens.add(candidate.token);
    controls.add(candidate.controlIndex);
    const container = byIndex.get(candidate.containerIndex),
      mediaRoot = byIndex.get(candidate.mediaIndex),
      control = byIndex.get(candidate.controlIndex);
    assert(
      container &&
        has(container, 'c-message_kit__actions') &&
        mediaRoot &&
        control &&
        tree.descendants(container).some((node) => node.index === mediaRoot.index) &&
        tree.descendants(mediaRoot).some((node) => node.index === control.index),
      'Transcript control is not bound to its captured message/media ancestry'
    );
    const timestamps = tree
      .descendants(container)
      .filter(
        (node) =>
          node.role === 'AXLink' &&
          has(node, 'c-timestamp') &&
          !tree.ancestor(node, (parent) => has(parent, 'c-message_attachment'))
      );
    if (timestamps.length !== 1) continue;
    const permalink = timestamps[0].url,
      messageRef = sourceReference(permalink);
    const source = resolved.sources?.find(
      (item) => item.messageRef === messageRef && item.permalink === permalink
    );
    if (!source || !messageRef) continue;
    const binding = extractMedia(container, tree, { messageRef }).bindings.find(
      (item) => item.rootIndex === mediaRoot.index
    );
    if (!binding || binding.media.ref !== reference.ref) continue;
    assert(
      sameIdentity(binding.media, resolved.media) &&
        ['audio', 'video'].includes(binding.media.kind) &&
        binding.media.transcript.state === 'available',
      'Transcript candidate differs from the verified attachment'
    );
    const within = new Set(tree.descendants(mediaRoot).map((node) => node.index));
    const buttons = tree
      .descendants(mediaRoot)
      .filter(
        (node) =>
          node.role === 'AXButton' &&
          !tree.ancestor(
            node,
            (parent) =>
              within.has(parent.index) &&
              (isMediaRoot(parent) || has(parent, 'c-message_kit__actions'))
          )
      );
    const existing = buttons.filter((node) => existingLabel.test(readLabel(node)));
    const generating = buttons.filter((node) => generateLabel.test(readLabel(node)));
    assert(
      existing.length === 1 && generating.length === 0 && existing[0].index === control.index,
      'Existing transcript control is missing, ambiguous or changed; no input selected'
    );
    matches.push(candidate);
  }
  assert(
    matches.length > 0,
    'No existing transcript control matches the verified attachment; reread its source'
  );
  // Same-file copies were already reconciled by resolveMedia. Bind one actual
  // control deterministically, never a filename or positional guess.
  matches.sort((a, b) => a.controlIndex - b.controlIndex);
  return matches[0];
}

export function timestampSeconds(value) {
  const clock = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (clock) {
    const [, hours, minutes, seconds] = clock;
    if (Number(seconds) >= 60 || (hours !== undefined && Number(minutes) >= 60)) return null;
    const total = Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
    return Number.isSafeInteger(total) ? total : null;
  }
  const parts = [...value.matchAll(/(\d+) (hours?|minutes?|seconds?)/g)];
  if (
    !parts.length ||
    value.replace(/\d+ (?:hours?|minutes?|seconds?)/g, '').replace(/[,\s]/g, '') !== ''
  )
    return null;
  let previous = Infinity,
    total = 0;
  for (const [, number, unit] of parts) {
    const factor = unit.startsWith('hour') ? 3600 : unit.startsWith('minute') ? 60 : 1;
    if (factor >= previous) return null;
    previous = factor;
    total += Number(number) * factor;
  }
  return Number.isSafeInteger(total) ? total : null;
}

function audioPopoverRows(tree, hider) {
  const direct = tree.children(tree.root);
  assert(
    (direct.length === 2 || direct.length === 3) &&
      direct[0] === hider &&
      direct.at(-1).role === 'AXGroup' &&
      has(direct.at(-1), 'p-media_transcript__footer') &&
      (direct.length === 2 ||
        (direct[1].role === 'AXGroup' &&
          has(direct[1], 'c-scrollbar__bar') &&
          tree.children(direct[1]).length === 0)),
    'Audio transcript popover has unsupported outer structure'
  );
  const containers = tree.nodes.filter((node) => has(node, 'p-media_transcript__scrollable'));
  const children = tree.children(hider);
  assert(
    containers.length === 1 &&
      children.length === 1 &&
      children[0] === containers[0] &&
      children[0].role === 'AXGroup',
    'Audio transcript requires one direct scrollable container'
  );
  const rows = tree.children(containers[0]);
  const [actions, heading, caption, ...segments] = rows;
  assert(
    actions?.role === 'AXGroup' && has(actions, 'p-media_transcript__action_buttons'),
    'Audio transcript action header is unverified'
  );
  const buttons = tree.children(actions);
  assert(
    buttons.length === 2 &&
      buttons.every((node) => node.role === 'AXButton' && tree.children(node).length === 0) &&
      has(buttons[0], 'p-media_transcript__copy_button') &&
      readLabel(buttons[0]) === 'Copy' &&
      has(buttons[1], 'p-media_transcript__close_button') &&
      readLabel(buttons[1]) === 'Close transcript',
    'Audio transcript action controls are unsupported or ambiguous'
  );
  const plainText = (node) =>
    node.role === 'AXStaticText' && node.classes.length === 0 && tree.children(node).length === 0;
  const headingText = heading ? tree.children(heading) : [];
  assert(
    heading?.role === 'AXHeading' &&
      readLabel(heading) === 'Transcript (auto-generated)' &&
      headingText.length === 1 &&
      plainText(headingText[0]) &&
      readLabel(headingText[0]) === readLabel(heading),
    'Audio transcript title is unverified'
  );
  const metadata = caption ? tree.children(caption) : [];
  assert(
    caption?.role === 'AXGroup' &&
      has(caption, 'caption') &&
      has(caption, 'sk_foreground_max_solid') &&
      metadata.length === 4 &&
      metadata.every(plainText),
    'Audio transcript metadata header has unsupported structure'
  );
  assert(
    segments.length > 0 &&
      segments.every(
        (node) =>
          has(node, 'p-media_transcript__timestamp') || has(node, 'p-media_transcript__text')
      ),
    'Audio transcript contains unsupported segment wrappers'
  );
  return [...segments, ...direct.slice(1)];
}

export function transcriptOutput(receipt, resolved) {
  assert(
    receipt?.operation === 'read-transcript' &&
      receipt.requested === resolved?.requested &&
      !receipt.error &&
      receipt.status !== 'stopped',
    'Transcript receipt does not match the requested media'
  );
  const candidate = selectTranscriptCandidate(receipt.preflight, resolved);
  assert(
    candidateFields.every((field) => receipt.selection?.[field] === candidate[field]),
    'Opened transcript does not match the verified selected control'
  );
  assert(
    receipt.verification?.sourceMatched === true &&
      receipt.verification?.panelOpened === true &&
      receipt.verification?.playbackUnchanged === true &&
      receipt.transcript?.stable === true,
    'Transcript source, panel transition or playback state was not verified'
  );
  const content = receipt.transcript.content;
  assert(content?.truncated === false, 'Transcript capture is incomplete');
  const tree = indexTree(content.nodes);
  assert(
    tree.root.role === 'AXGroup' &&
      has(tree.root, 'p-media_transcript') &&
      tree.nodes.filter((node) => has(node, 'p-media_transcript')).length === 1,
    'Expected one verified transcript panel'
  );
  const audio = resolved.media.kind === 'audio';
  const bindingMode = audio ? 'audio-popover' : 'video-active-control';
  assert(
    receipt.verification.bindingMode === bindingMode &&
      receipt.activeControl?.mode === bindingMode &&
      receipt.activeControl.verified === true &&
      receipt.activeControl.enabled === audio &&
      Array.isArray(receipt.activeControl.classes) &&
      receipt.activeControl.classes.includes('c-button--disabled') === !audio &&
      has(tree.root, 'p-media_transcript--popover') === audio,
    'Transcript panel lacks the verified media-specific source binding'
  );
  assert(
    !tree.nodes.some((node) => ['AXTextArea', 'AXTextField'].includes(node.role)),
    'Transcript capture includes an unsupported text-entry control'
  );
  const direct = tree.children(tree.root);
  const hiders = tree.nodes.filter((node) => has(node, 'c-scrollbar__hider'));
  assert(hiders.length <= 1, 'Transcript scroll containers are ambiguous');
  const hider = hiders[0];
  const isSegment = (node) =>
    has(node, 'p-media_transcript__timestamp') || has(node, 'p-media_transcript__text');
  if (hider) {
    assert(
      hider.role === 'AXGroup' && hider.parent === tree.root.index && !direct.some(isSegment),
      'Transcript segments mix direct and unsupported nested ancestry'
    );
    if (!audio) {
      const children = tree.children(hider);
      assert(
        children.length > 0 && children.every(isSegment),
        'Transcript scroll container contains an unsupported structure'
      );
    }
  }
  assert(!audio || hider, 'Audio transcript requires its observed popover scroll container');
  // Slack exposes either direct segment pairs or one direct scrollbar hider
  // containing those same pairs. Do not recursively flatten arbitrary wrappers.
  const rows = audio
      ? audioPopoverRows(tree, hider)
      : direct.flatMap((node) => (node === hider ? tree.children(node) : [node])),
    segments = [];
  let pending = null,
    previous = -1,
    footerSeen = false;
  for (const node of rows) {
    if (has(node, 'p-media_transcript__timestamp')) {
      assert(
        !pending && !footerSeen && node.role === 'AXButton',
        'Unpaired or misplaced transcript timestamp'
      );
      const timestamp = readLabel(node).trim(),
        seconds = timestampSeconds(timestamp);
      assert(
        seconds !== null && seconds >= previous,
        'Transcript timestamps are unsupported or out of order'
      );
      pending = { timestamp, seconds };
    } else if (has(node, 'p-media_transcript__text')) {
      assert(
        pending && !footerSeen && node.role === 'AXButton',
        'Transcript text lacks its timestamp'
      );
      const text = readLabel(node).trim();
      assert(text.length > 0, 'Transcript segment text is unavailable');
      segments.push({ timestamp: pending.timestamp, text });
      previous = pending.seconds;
      pending = null;
    } else if (
      node.role === 'AXGroup' &&
      (has(node, 'c-scrollbar__bar') || has(node, 'p-media_transcript__footer'))
    ) {
      assert(!pending, 'Transcript timestamp lacks its text');
      if (has(node, 'p-media_transcript__footer')) footerSeen = true;
      assert(
        !tree
          .descendants(node)
          .some(
            (child) =>
              has(child, 'p-media_transcript__timestamp') || has(child, 'p-media_transcript__text')
          ),
        'Transcript segments have unsupported ancestry'
      );
    } else
      throw new Error('Transcript panel contains an unsupported structure; no transcript returned');
    assert(
      !tree
        .descendants(node)
        .some(
          (child) =>
            has(child, 'p-media_transcript__timestamp') || has(child, 'p-media_transcript__text')
        ),
      'Transcript segments have unsupported ancestry'
    );
  }
  assert(!pending && segments.length > 0, 'Existing transcript segments are missing or incomplete');
  const navigation = resolved.navigation;
  const refreshReference =
    parseMediaReference(resolved.requested).kind === 'message' &&
    !navigation?.some(
      (item) => item.command === 'inspect' && Array.isArray(item.args) && item.args.length === 0
    );
  return {
    schemaVersion: 1,
    operation: 'read-transcript',
    status: 'ok',
    requested: resolved.requested,
    workspace: resolved.workspace,
    view: resolved.view,
    media: resolved.media,
    sources: resolved.sources,
    navigation: refreshReference
      ? [...(navigation ?? []), { command: 'inspect', args: [] }]
      : navigation,
    transcript: {
      contentRead: true,
      segments,
      text: segments.map((segment) => segment.text).join('\n'),
    },
    coverage: {
      scope: 'exposed existing transcript',
      complete: false,
      transcriptRead: true,
      mediaBytesRead: false,
      segmentCount: segments.length,
      firstTimestamp: segments[0].timestamp,
      lastTimestamp: segments.at(-1).timestamp,
      reason:
        'Existing accessible transcript segments only; no generation, playback or media bytes were requested. Exposed segments and timestamps do not prove transcript completeness or accuracy.',
    },
  };
}
