// Pure validation of the native close-thread receipt. No UI or persistence.
const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function compactThreadClose(receipt) {
  requireState(object(receipt), 'Thread close receipt is unavailable');
  requireState(
    ['ok', 'stopped'].includes(receipt.status) &&
      (receipt.operation === 'close-thread' ||
        (receipt.status === 'stopped' && receipt.operation === undefined)),
    'Thread close receipt status or operation is invalid'
  );
  const base = {
    schemaVersion: 1,
    operation: 'close-thread',
    status: receipt.status,
    ...(receipt.observedAt ? { observedAt: receipt.observedAt } : {}),
  };
  if (receipt.status === 'stopped') {
    requireState(
      receipt.closeAttempted === undefined || typeof receipt.closeAttempted === 'boolean',
      'Thread close attempt evidence is invalid'
    );
    return {
      ...base,
      error: typeof receipt.error === 'string' ? receipt.error : 'Thread close stopped',
      next:
        typeof receipt.next === 'string'
          ? receipt.next
          : 'Inspect the current Slack view before another request; no close is replayed.',
      // Unknown evidence is reported as unknown, never as "nothing was pressed".
      closeMayHaveBeenRequested: receipt.closeAttempted ?? null,
    };
  }
  requireState(
    typeof receipt.wasOpen === 'boolean' &&
      typeof receipt.closed === 'boolean' &&
      typeof receipt.closeAttempted === 'boolean' &&
      // A verified close needs an open pane and exactly one press; a no-op needs neither.
      receipt.closed === receipt.wasOpen &&
      receipt.closeAttempted === receipt.wasOpen,
    'Thread close evidence is missing or inconsistent'
  );
  let thread = null;
  if (receipt.thread !== null && receipt.thread !== undefined) {
    requireState(
      receipt.wasOpen &&
        object(receipt.thread) &&
        /^[CDG][A-Z0-9]+$/.test(receipt.thread.conversationId ?? '') &&
        /^[0-9]{10}\.[0-9]{6}$/.test(receipt.thread.rootTS ?? ''),
      'Closed thread identity is invalid'
    );
    thread = {
      conversationId: receipt.thread.conversationId,
      rootTS: receipt.thread.rootTS,
      ref: `${receipt.thread.conversationId}:${receipt.thread.rootTS}`,
    };
  }
  return { ...base, wasOpen: receipt.wasOpen, closed: receipt.closed, thread };
}
