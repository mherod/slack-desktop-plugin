// Pure validation for send, edit and delete. No UI or persistence.
import emojiMap from '../references/emoji-map.json' with { type: 'json' };

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const emojiComponent = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}️⃣]/u;
const codepoints = (text) =>
  Array.from(text, (point) =>
    point.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  ).join('-');
const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const COMPOSE_OPERATIONS = new Set(['send', 'edit', 'delete']);
export const MAX_MESSAGE_CHARACTERS = 4000;

const threadRef = /^[CDG][A-Z0-9]+:[0-9]{10}\.[0-9]{6}$/;
const permalink =
  /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[CDG][A-Z0-9]+\/p[0-9]{16}(?:\?.*)?$/;

export function validMessageReference(value) {
  return typeof value === 'string' && (threadRef.test(value) || permalink.test(value));
}

// send accepts #channel, thread:REF, group:ID, @handle or an exact DM name.
export function validSendDestination(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f-\x9f]/.test(value))
    return false;
  if (value.startsWith('#')) return /^#[^\s#]{1,80}$/u.test(value);
  if (value.startsWith('thread:')) return validMessageReference(value.slice('thread:'.length));
  if (value.startsWith('group:')) return /^group:[CG][A-Z0-9]+$/.test(value);
  if (value.startsWith('group-name:')) return false;
  return Array.from(value).length <= 200 && value === value.trim();
}

// Slack's editor drops raw emoji pasted through accessibility. Submit the
// pinned Slack shortcode for every recognised emoji; refuse unknown emoji
// rather than sending altered text.
export function normalizeMessageText(text) {
  requireState(typeof text === 'string', 'Message text must be a string');
  const normalized = text.replace(/\r\n?/g, '\n');
  requireState(normalized.trim() !== '', 'Message text must not be empty');
  requireState(
    !/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(normalized),
    'Message text must not contain control characters other than newlines'
  );
  const substitutions = [];
  let submittedText = '';
  let previousShortcode = false;
  for (const { segment } of segmenter.segment(normalized)) {
    const shortcode = emojiComponent.test(segment) ? (emojiMap[codepoints(segment)] ?? null) : null;
    requireState(
      shortcode !== null || !emojiComponent.test(segment),
      'Message contains an emoji without a known Slack shortcode; write its :shortcode: instead. Nothing was sent.'
    );
    if (shortcode) {
      if (submittedText && !/\s$/u.test(submittedText) && !previousShortcode) submittedText += ' ';
      submittedText += shortcode;
      substitutions.push({ unicode: segment, shortcode });
      previousShortcode = true;
    } else {
      if (previousShortcode && !/^\s/u.test(segment)) submittedText += ' ';
      submittedText += segment;
      previousShortcode = false;
    }
  }
  requireState(
    Array.from(submittedText).length <= MAX_MESSAGE_CHARACTERS,
    `Message text exceeds ${MAX_MESSAGE_CHARACTERS} characters`
  );
  return { requestedText: text, submittedText, substitutions };
}

function permalinkRef(value) {
  const match =
    typeof value === 'string' &&
    /^https:\/\/[^/]+\/archives\/([CDG][A-Z0-9]+)\/p([0-9]{10})([0-9]{6})/.exec(value);
  return match ? `${match[1]}:${match[2]}.${match[3]}` : null;
}

export function compactCompose(receipt, operation, requested) {
  requireState(object(receipt), 'Composition receipt is unavailable');
  requireState(COMPOSE_OPERATIONS.has(operation), 'Unsupported composition operation');
  const base = { schemaVersion: 1, operation, requested };
  if (receipt.status !== 'ok') {
    requireState(
      ['stopped', 'ambiguous', 'not-found'].includes(receipt.status),
      'Composition receipt status is invalid'
    );
    // A destination that could not be selected never reaches the composer.
    const candidates = Array.isArray(receipt.candidates)
      ? receipt.candidates
          .filter((candidate) => object(candidate) && typeof candidate.name === 'string')
          .slice(0, 8)
          .map((candidate) => ({
            name: candidate.name,
            handle: typeof candidate.handle === 'string' ? candidate.handle : null,
          }))
      : null;
    return {
      ...base,
      status: 'stopped',
      ...(candidates ? { candidates } : {}),
      error: typeof receipt.error === 'string' ? receipt.error : `${operation} stopped`,
      // Unknown evidence stays unknown: an early stop never claims "nothing happened".
      actionMayHaveOccurred:
        typeof receipt.actionMayHaveOccurred === 'boolean'
          ? receipt.actionMayHaveOccurred
          : candidates
            ? false
            : null,
      next:
        typeof receipt.next === 'string'
          ? receipt.next
          : 'Read the conversation before any retry; nothing is replayed automatically.',
      ...(Array.isArray(receipt.recovery) && receipt.recovery.length
        ? { recovery: receipt.recovery.filter((step) => typeof step === 'string') }
        : {}),
      ...(readbackEvidence(receipt.readback)
        ? { readback: readbackEvidence(receipt.readback) }
        : {}),
    };
  }
  requireState(
    receipt.operation === operation && /^[0-9]{10}\.[0-9]{6}$/.test(receipt.timestamp ?? ''),
    'Composition receipt lacks verified message identity'
  );
  const ref =
    permalinkRef(receipt.permalink) ??
    (operation !== 'send' && validMessageReference(requested)
      ? (permalinkRef(requested) ?? requested)
      : null);
  if (operation === 'delete')
    requireState(typeof receipt.placeholder === 'boolean', 'Deletion evidence is missing');
  return {
    ...base,
    status: 'ok',
    timestamp: receipt.timestamp,
    ref,
    permalink: typeof receipt.permalink === 'string' ? receipt.permalink : null,
    ...(operation === 'delete' ? { placeholder: receipt.placeholder } : {}),
    ...(operation === 'send' && typeof receipt.composer === 'string'
      ? { composer: receipt.composer }
      : {}),
  };
}

// Readback evidence describes where composer text diverged by offset, length and
// character kind only. Anything that is not one of these fields is dropped, so
// no message text can pass through.
const READBACK_KIND = /^(?:letter|digit|U\+[0-9A-F]{4,6})$/;
function readbackEvidence(value) {
  if (!object(value) || typeof value.observed !== 'boolean') return null;
  const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
  const kinds = (list) =>
    Array.isArray(list) && list.length <= 7 && list.every((k) => READBACK_KIND.test(k))
      ? list
      : null;
  const flag = (b) => (typeof b === 'boolean' ? b : null);
  const evidence = { observed: value.observed, expectedLength: count(value.expectedLength) };
  if (!value.observed) return evidence;
  return {
    ...evidence,
    observedLength: count(value.observedLength),
    firstDifference: count(value.firstDifference),
    windowStart: count(value.windowStart),
    expectedAround: kinds(value.expectedAround),
    observedAround: kinds(value.observedAround),
    comparedWithoutShortcodes: flag(value.comparedWithoutShortcodes),
    equalAfterQuoteFolding: flag(value.equalAfterQuoteFolding),
    equalIgnoringWhitespace: flag(value.equalIgnoringWhitespace),
    observedIsPrefix: flag(value.observedIsPrefix),
  };
}

function readbackLine(readback) {
  if (!readback.observed) return 'Readback: the composer value could not be read.';
  const hints = [
    readback.equalAfterQuoteFolding && 'matches once curly quotes are folded',
    readback.equalIgnoringWhitespace && 'matches ignoring whitespace',
    readback.observedIsPrefix && 'Slack showed only the start of the text',
  ].filter(Boolean);
  const around = (list) => (list ? list.join(' ') : 'unknown');
  return [
    `Readback: first difference at character ${readback.firstDifference ?? '?'} (expected ${readback.expectedLength ?? '?'} characters, observed ${readback.observedLength ?? '?'}).`,
    `Expected near it: ${around(readback.expectedAround)}; observed: ${around(readback.observedAround)}.`,
    hints.length ? `Likely cause: ${hints.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function renderCompose(compact) {
  if (compact.status !== 'ok') {
    const lines = [`${compact.operation} stopped: ${compact.error}`];
    if (compact.actionMayHaveOccurred === true)
      lines.push('The action may have taken effect; check before retrying.');
    if (compact.actionMayHaveOccurred === false) lines.push('Nothing was changed.');
    if (compact.readback) lines.push(readbackLine(compact.readback));
    if (compact.candidates?.length)
      lines.push(
        `Candidates: ${compact.candidates.map((c) => (c.handle ? `${c.name} (${c.handle})` : c.name)).join(', ')}`
      );
    for (const step of compact.recovery ?? []) lines.push(`Recovery: ${step}`);
    lines.push(`Next: ${compact.next}`);
    return lines.join('\n');
  }
  const ref = compact.ref ? ` (${compact.ref})` : '';
  if (compact.operation === 'send') {
    const lines = [`Sent and verified${ref}.`];
    if (compact.composer) lines.push(`Composer: ${compact.composer}`);
    if (compact.permalink) lines.push(compact.permalink);
    if (compact.ref)
      lines.push(
        `Edit: edit ${compact.ref} --text=…`,
        `Delete: delete ${compact.ref} --confirm-delete`
      );
    return lines.join('\n');
  }
  if (compact.operation === 'edit')
    return [`Edited and verified${ref}.`, compact.permalink].filter(Boolean).join('\n');
  return compact.placeholder
    ? `Deleted${ref}; Slack shows a deleted-message placeholder because the thread has replies.`
    : `Deleted and verified removed${ref}.`;
}
