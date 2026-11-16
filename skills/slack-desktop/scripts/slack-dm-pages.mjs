// Pure collection of independently verified DMs-view captures. No UI or persistence.
import {
  compactOutput,
  hubObservation,
  withDMNavigation,
  verifyDMSearchRequest,
} from './slack-output.mjs';

const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
};
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function verifiedFrame(frame, pid, index, options) {
  requireState(
    frame?.operation === 'dms' &&
      frame.pid === pid &&
      frame.dmPagination?.scope?.source === 'dms-view',
    'DMs view process, operation or source changed'
  );
  const compact = compactOutput(frame, 'dms', null, options),
    observed = hubObservation(frame),
    page = frame.dmPagination;
  requireState(
    same(page.scope, observed.scope) &&
      same(page.afterRowKeys, observed.rowKeys) &&
      same(
        page.dmIds,
        compact.dms.map((dm) => dm.id)
      ),
    'DMs view rows, scope or semantic identities differ from the native capture'
  );
  requireState(
    Array.isArray(page.beforeRowKeys) &&
      (index === 0
        ? page.status === 'initial' &&
          page.scrollAttempts === 0 &&
          page.edgeKey === null &&
          same(page.beforeRowKeys, observed.rowKeys)
        : ['advanced', 'no-progress'].includes(page.status) && page.scrollAttempts === 1),
    'DMs view pagination state or scroll count is invalid'
  );
  return {
    compact,
    page,
    ...observed,
  };
}

function verifyAdvance(previous, current) {
  const before = previous.rowKeys,
    after = current.rowKeys,
    edge = before.at(-1),
    edgeIndex = after.indexOf(edge);
  requireState(
    previous.page.status !== 'no-progress' &&
      same(current.page.beforeRowKeys, before) &&
      current.page.edgeKey === edge &&
      edgeIndex >= 0,
    'DMs view continuation lost its verified edge'
  );
  const beforeSet = new Set(before),
    afterSet = new Set(after);
  requireState(
    same(
      before.filter((key) => afterSet.has(key)),
      after.filter((key) => beforeSet.has(key))
    ),
    'DMs view common rows changed order'
  );
  const newPositions = after.flatMap((key, index) => (beforeSet.has(key) ? [] : [index]));
  requireState(
    newPositions.every((index) => index > edgeIndex),
    'DMs view exposed new rows before its downward edge'
  );
  requireState(
    current.page.status === (newPositions.length ? 'advanced' : 'no-progress'),
    'DMs view progress status disagrees with its observed rows'
  );
}

export function collectDMViewPages(receipt, options = {}) {
  const frames = receipt?.pages,
    batch = receipt?.batch;
  requireState(
    receipt?.operation === 'dms' &&
      Number.isSafeInteger(receipt.pid) &&
      receipt.pid > 0 &&
      batch?.direction === 'down' &&
      Number.isInteger(batch.requestedPages) &&
      batch.requestedPages >= 2 &&
      batch.requestedPages <= 10 &&
      Array.isArray(frames) &&
      frames.length > 0 &&
      batch.completedPages === frames.length &&
      Number.isInteger(batch.attemptedPages) &&
      batch.attemptedPages >= frames.length &&
      batch.attemptedPages <= batch.requestedPages &&
      ['page-limit', 'no-progress', 'error', 'time-limit'].includes(batch.stopReason),
    'DMs view collection page budget or counts are invalid'
  );
  verifyDMSearchRequest(receipt, options.dmSearch);
  const verified = [],
    records = new Map();
  let error = typeof receipt.error === 'string' && receipt.error ? receipt.error : null;
  let capturedCount = 0,
    scrollAttempts = 0;
  for (const [index, frame] of frames.entries()) {
    try {
      const current = verifiedFrame(frame, receipt.pid, index, options),
        previous = verified.at(-1);
      if (previous) {
        requireState(same(current.scope, previous.scope), 'DMs view workspace or filters changed');
        verifyAdvance(previous, current);
      }
      // Validate the complete capture before accepting any newly exposed row.
      for (const record of current.dms)
        requireState(
          !records.has(record.id) ||
            (records.get(record.id).name === record.name &&
              records.get(record.id).kind === record.kind &&
              same(records.get(record.id).participantLabels, record.participantLabels)),
          'One DM ID has conflicting names, kinds or participant labels across DMs view captures'
        );
      for (const record of current.dms)
        if (!records.has(record.id)) records.set(record.id, structuredClone(record));
      capturedCount += current.dms.length;
      scrollAttempts += current.page.scrollAttempts;
      verified.push(current);
    } catch (cause) {
      if (!verified.length) throw cause;
      error = cause.message ?? String(cause);
      break;
    }
  }
  const last = verified.at(-1);
  if (!error) {
    try {
      requireState(
        receipt.status === 'ok' && batch.attemptedPages === verified.length,
        'Successful DMs view collection has an unverified attempt'
      );
      requireState(
        (batch.stopReason === 'page-limit' &&
          verified.length === batch.requestedPages &&
          last.page.status !== 'no-progress') ||
          (batch.stopReason === 'no-progress' && last.page.status === 'no-progress'),
        'DMs view stop reason disagrees with its verified final capture'
      );
    } catch (cause) {
      error = cause.message;
    }
  }
  const result = structuredClone(last.compact);
  result.status = error ? 'partial' : 'ok';
  result.dms = withDMNavigation([...records.values()]);
  result.pagination = {
    supported: true,
    direction: 'down',
    status: last.page.status,
    hasMore: null,
    nextCursor: null,
    capturedCount,
    returnedCount: records.size,
    scrollAttempts,
    batch: {
      ...batch,
      completedPages: verified.length,
      stopReason: error
        ? batch.stopReason === 'time-limit'
          ? 'time-limit'
          : 'error'
        : batch.stopReason,
      deduplicatedCount: capturedCount - records.size,
    },
  };
  result.coverage = {
    ...result.coverage,
    complete: false,
    observedCount: records.size,
    capturedCount,
    reason:
      'A bounded downward collection from the current DMs view position and filters; unexposed conversations and the full workspace directory remain outside coverage.',
    warnings: [...new Set(verified.flatMap((item) => item.compact.coverage?.warnings ?? []))],
  };
  if (error) {
    result.error = error;
    result.next =
      'Verified DMs are retained. Inspect the current Slack DMs view before another command.';
    result.coverage.warnings.push(
      'DMs view collection stopped early; only the verified capture prefix is included.'
    );
  }
  return result;
}
