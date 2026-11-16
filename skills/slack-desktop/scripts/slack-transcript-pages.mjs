// Pure collection of independently verified transcript panels. No Slack input.
import { timestampSeconds, transcriptOutput } from './slack-transcript.mjs';

const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function groups(segments) {
  const result = [];
  for (const segment of segments) {
    const seconds = timestampSeconds(segment.timestamp);
    requireState(seconds !== null, 'Transcript page has an unsupported timestamp');
    const previous = result.at(-1);
    requireState(!previous || seconds >= previous.seconds, 'Transcript page order changed');
    if (previous?.seconds === seconds) previous.segments.push(segment);
    else result.push({ seconds, segments: [segment] });
  }
  return result;
}

function sameGroup(left, right) {
  return (
    left.seconds === right.seconds &&
    same(
      left.segments.map((segment) => segment.text),
      right.segments.map((segment) => segment.text)
    )
  );
}

function extension(previous, current) {
  const start = previous.findIndex((group) => group.seconds === current[0].seconds);
  requireState(start >= 0, 'Transcript pages lack the verified preceding overlap');
  const overlap = previous.slice(start);
  requireState(
    current.length >= overlap.length,
    'Transcript page lost the preceding final timestamp group'
  );
  requireState(
    overlap.every((group, index) => sameGroup(group, current[index])),
    'Transcript overlap changed text, occurrence order or timestamp groups'
  );
  const added = current.slice(overlap.length);
  requireState(
    added.every((group) => group.seconds > previous.at(-1).seconds),
    'Transcript page appended an earlier or repeated timestamp group'
  );
  return added;
}

function idlePlayback(value) {
  requireState(
    Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (control) =>
          control &&
          typeof control.label === 'string' &&
          /^Play(?:$|,|\s)/.test(control.label) &&
          control.value === '0'
      ),
    'Transcript page playback is active, unknown or unavailable'
  );
  return value.map(({ label, value }) => ({ label, value }));
}

export function collectTranscriptPages(receipt, resolved, requestedPages) {
  const frames = receipt?.transcriptPages,
    batch = receipt?.transcriptBatch;
  requireState(
    receipt?.operation === 'read-transcript' &&
      receipt.phase === 'result' &&
      receipt.requested === resolved?.requested &&
      Number.isSafeInteger(receipt.pid) &&
      receipt.pid > 0 &&
      receipt.preflight?.pid === receipt.pid &&
      Number.isInteger(requestedPages) &&
      requestedPages >= 2 &&
      requestedPages <= 10 &&
      batch?.requestedPages === requestedPages &&
      batch.direction === 'down' &&
      Array.isArray(frames) &&
      frames.length > 0 &&
      frames.length <= requestedPages &&
      batch.completedPages === frames.length &&
      Number.isInteger(batch.attemptedPages) &&
      batch.attemptedPages >= frames.length &&
      batch.attemptedPages <= requestedPages &&
      ['page-limit', 'no-progress', 'error', 'time-limit'].includes(batch.stopReason),
    'Transcript collection page budget, identity or counters are invalid'
  );
  const accepted = [],
    segments = [];
  let previous = null,
    baseline = null,
    capturedCount = 0,
    scrollAttempts = 0;
  let error =
    receipt.error == null
      ? null
      : typeof receipt.error === 'string' && receipt.error.trim()
        ? receipt.error
        : 'Transcript collection returned a malformed error receipt';
  for (const [index, frame] of frames.entries()) {
    try {
      requireState(frame && typeof frame === 'object', 'Transcript page is unavailable');
      const pagination = frame.pagination;
      requireState(
        pagination?.index === index + 1 &&
          pagination.scrollAttempts === (index === 0 ? 0 : 1) &&
          (index === 0
            ? pagination.status === 'initial' && pagination.edge === null
            : ['advanced', 'no-progress'].includes(pagination.status)),
        'Transcript page position or scroll receipt is invalid'
      );
      requireState(
        !frame.error && !['partial', 'stopped'].includes(frame.status),
        'Transcript page reports an unverified capture'
      );
      const page = transcriptOutput(
        {
          operation: receipt.operation,
          requested: receipt.requested,
          preflight: receipt.preflight,
          selection: receipt.selection,
          transcript: frame.transcript,
          verification: frame.verification,
          activeControl: frame.activeControl,
        },
        resolved
      );
      const before = idlePlayback(frame.playback?.before);
      const afterOpen = idlePlayback(frame.playback?.afterOpen);
      const afterCapture = idlePlayback(frame.playback?.afterCapture);
      requireState(
        same(before, afterOpen) &&
          same(before, afterCapture) &&
          (!baseline || same(before, baseline)),
        'Transcript playback differs from the initial idle baseline'
      );
      const current = groups(page.transcript.segments);
      let additions = current;
      if (previous) {
        requireState(
          accepted.at(-1).pagination.status !== 'no-progress',
          'Transcript collection continued after no progress'
        );
        const edge = previous.at(-1).segments.at(-1);
        requireState(
          pagination.edge?.timestamp === edge.timestamp && pagination.edge?.text === edge.text,
          'Transcript page edge does not match the preceding verified page'
        );
        additions = extension(previous, current);
        requireState(
          pagination.status === (additions.length ? 'advanced' : 'no-progress'),
          'Transcript page progress disagrees with its captured segments'
        );
      }
      // Commit only a completely verified page. Never merge a malformed suffix.
      segments.push(...additions.flatMap((group) => group.segments));
      capturedCount += page.transcript.segments.length;
      scrollAttempts += pagination.scrollAttempts;
      baseline ??= before;
      previous = current;
      accepted.push({ page, pagination });
    } catch (cause) {
      if (!accepted.length) throw cause;
      error = cause.message ?? String(cause);
      break;
    }
  }
  if (!error) {
    try {
      requireState(
        receipt.status === 'ok' && batch.attemptedPages === accepted.length,
        'Successful transcript collection has an unverified attempt'
      );
      requireState(
        (batch.stopReason === 'page-limit' &&
          accepted.length === requestedPages &&
          accepted.at(-1).pagination.status !== 'no-progress') ||
          (batch.stopReason === 'no-progress' &&
            accepted.length > 1 &&
            accepted.at(-1).pagination.status === 'no-progress'),
        'Transcript collection stop reason disagrees with its verified final page'
      );
    } catch (cause) {
      error = cause.message;
    }
  }
  const result = structuredClone(accepted[0].page);
  result.status = error ? 'partial' : 'ok';
  result.transcript.segments = structuredClone(segments);
  result.transcript.text = segments.map((segment) => segment.text).join('\n');
  result.pagination = {
    supported: true,
    direction: 'down',
    status: accepted.at(-1).pagination.status,
    hasMore: null,
    nextCursor: null,
    capturedCount,
    returnedCount: segments.length,
    scrollAttempts,
    batch: {
      ...batch,
      completedPages: accepted.length,
      stopReason: error
        ? batch.stopReason === 'time-limit'
          ? 'time-limit'
          : 'error'
        : batch.stopReason,
      deduplicatedCount: capturedCount - segments.length,
    },
  };
  result.coverage = {
    ...result.coverage,
    complete: false,
    segmentCount: segments.length,
    firstTimestamp: segments[0].timestamp,
    lastTimestamp: segments.at(-1).timestamp,
    reason:
      'A bounded collection of verified existing transcript panels; matching overlap is deduplicated while segment occurrence order is preserved. Unexposed transcript content and completeness remain unknown.',
    warnings: [
      ...(batch.stopReason === 'no-progress' && !error
        ? ['No additional segments were verified; the end of the transcript remains unknown.']
        : []),
      ...(error ? ['Collection stopped early; only the verified page prefix is included.'] : []),
    ],
  };
  if (error) {
    result.error = error;
    result.next =
      'Verified transcript segments are retained. Inspect the current Slack state before another command; do not replay an uncertain input.';
  }
  return result;
}
