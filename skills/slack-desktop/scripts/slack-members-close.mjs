// Pure validation of the native close-members receipt. No UI or persistence.
const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, maximum) =>
  typeof value === 'string' &&
  value.length > 0 &&
  [...value].length <= maximum &&
  !/[\p{Cc}\p{Cs}]/u.test(value);
const next = 'Inspect the current Slack view before another request; no close is replayed.';

function booleanOrUnknown(value) {
  return typeof value === 'boolean' ? value : null;
}

export function stoppedMembersClose(receipt, error) {
  return {
    schemaVersion: 1,
    operation: 'close-members',
    status: 'stopped',
    error,
    // A malformed later field must not erase evidence of a possible press.
    closeMayHaveBeenRequested:
      receipt?.closeAttempted === true || receipt?.closeMayHaveBeenRequested === true
        ? true
        : booleanOrUnknown(receipt?.closeMayHaveBeenRequested),
    dialogMayBeOpen: booleanOrUnknown(receipt?.dialogMayBeOpen),
    next: typeof receipt?.next === 'string' ? receipt.next : next,
  };
}

function view(value) {
  if (!object(value) || !Number.isSafeInteger(value.windowId) || value.windowId < 1) return null;
  if (!safeText(value.title, 1000) || typeof value.url !== 'string') return null;
  // Preserve the actual client path; do not normalize a different workspace or view.
  if (!/^https:\/\/app\.slack\.com\/client\/[TE][A-Z0-9]+(?:\/[^?#\s]*)?$/.test(value.url))
    return null;
  return value;
}

function channelTitle(title, name) {
  return [title, title.replace(/^[!*] /, '')].some((value) =>
    value.startsWith(`${name} (Channel) - `)
  );
}

export function compactMembersClose(receipt, { code = 0 } = {}) {
  requireState(object(receipt), 'Members close receipt is unavailable');
  requireState(
    ['ok', 'stopped'].includes(receipt.status) &&
      (receipt.operation === 'close-members' ||
        (receipt.status === 'stopped' && receipt.operation === undefined)),
    'Members close receipt status or operation is invalid'
  );
  if (receipt.status === 'stopped')
    return stoppedMembersClose(
      receipt,
      typeof receipt.error === 'string' ? receipt.error : 'Members close stopped'
    );
  requireState(code === 0 && !receipt.error, 'Members close success conflicts with native failure');
  const before = view(receipt.before);
  const after = view(receipt.after);
  requireState(
    before &&
      after &&
      before.url === after.url &&
      before.windowId === after.windowId &&
      after.dialogPresent === false,
    'Members close workspace, window or after-state is unverified'
  );
  requireState(
    typeof receipt.wasOpen === 'boolean' &&
      before.dialogPresent === receipt.wasOpen &&
      receipt.closed === receipt.wasOpen &&
      receipt.closeAttempted === receipt.wasOpen &&
      receipt.closeMayHaveBeenRequested === receipt.wasOpen &&
      receipt.dialogMayBeOpen === false,
    'Members close evidence is missing or inconsistent'
  );
  let channel = null;
  if (receipt.wasOpen) {
    const source = receipt.channel;
    requireState(
      object(source) &&
        safeText(source.name, 80) &&
        /^[CG][A-Z0-9]+$/.test(source.id ?? '') &&
        source.url === before.url &&
        source.url.match(
          /^https:\/\/app\.slack\.com\/client\/[TE][A-Z0-9]+\/([CG][A-Z0-9]+)$/
        )?.[1] === source.id &&
        channelTitle(before.title, source.name) &&
        channelTitle(after.title, source.name) &&
        object(receipt.verification) &&
        ['dialogMatched', 'membersTabVerified', 'memberListVerified', 'controlVerified'].every(
          (field) => receipt.verification[field] === true
        ),
      'Members close channel or dialog ownership is unverified'
    );
    channel = { name: source.name, id: source.id, url: source.url };
  } else {
    requireState(receipt.channel === null, 'Members close no-op has an unexpected channel binding');
  }
  return {
    schemaVersion: 1,
    operation: 'close-members',
    status: 'ok',
    ...(receipt.observedAt ? { observedAt: receipt.observedAt } : {}),
    wasOpen: receipt.wasOpen,
    closed: receipt.closed,
    closeMayHaveBeenRequested: receipt.closeMayHaveBeenRequested,
    dialogMayBeOpen: false,
    channel,
  };
}
