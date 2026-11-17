// Logical pages over independently verified Slack captures. No UI or persistence.
// A --since read stops at its start, so it may page further than the ten pages --pages allows.
export const MAX_SINCE_PAGES = 30;
const timestampPattern = /^\d{10}\.\d{6}$/;
const referencePattern = /^([CDG][A-Z0-9]+):(\d{10}\.\d{6})$/;
const operations = new Set(['read-channel', 'read-dm', 'read-thread']);
const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};

function timestamps(values, name) {
  requireState(Array.isArray(values), `Pagination ${name} timestamps are unavailable`);
  requireState(
    values.every((value) => typeof value === 'string' && timestampPattern.test(value)),
    `Pagination ${name} timestamps are invalid`
  );
  requireState(
    values.every((value, index) => index === 0 || values[index - 1] < value),
    `Pagination ${name} timestamps are duplicated or out of order`
  );
  return values;
}

function messageTimestamp(message, conversationId, rootTS = null) {
  requireState(message && typeof message === 'object', 'Pagination message is unavailable');
  const identity =
    message.id?.match(/^message-list_(\d{10}\.\d{6})$/) ??
    message.id?.match(/^[CDG][A-Z0-9]+-\d{10}\.\d{6}-thread-list-Thread_(\d{10}\.\d{6})$/);
  let fromLink = null;
  if (message.permalink !== null && message.permalink !== undefined) {
    let url;
    try {
      url = new URL(message.permalink);
    } catch {
      /* Validation below reports the field. */
    }
    const match = url?.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/);
    requireState(
      url?.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.hash &&
        (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) &&
        match?.[1] === conversationId,
      'Pagination permalink belongs to an invalid or different conversation'
    );
    const roots = url.searchParams.getAll('thread_ts');
    const channels = url.searchParams.getAll('cid');
    requireState(
      roots.length <= 1 &&
        channels.length <= 1 &&
        (!channels.length || channels[0] === conversationId) &&
        (!roots.length || timestampPattern.test(roots[0])) &&
        (!rootTS || !roots.length || roots[0] === rootTS),
      'Pagination permalink has conflicting thread identity'
    );
    fromLink = `${match[2]}.${match[3]}`;
  }
  requireState(identity || fromLink, 'Pagination message has no verified timestamp');
  requireState(
    !identity || !fromLink || identity[1] === fromLink,
    'Pagination message identity differs from its permalink'
  );
  return fromLink ?? identity[1];
}

export function paginateOutput(compact, nativePage) {
  requireState(
    operations.has(compact?.operation),
    'Pagination requires a conversation or thread read'
  );
  requireState(
    nativePage && typeof nativePage === 'object',
    'Verified native pagination is unavailable'
  );
  const { direction, cursor, status, scrollAttempts } = nativePage;
  requireState(
    direction === null || direction === 'older' || direction === 'newer',
    'Pagination direction is invalid'
  );
  requireState(
    Number.isSafeInteger(scrollAttempts) && scrollAttempts >= 0,
    'Pagination scroll attempt count is invalid'
  );
  requireState(
    direction === null
      ? status === 'initial' && cursor === null && scrollAttempts === 0
      : ['advanced', 'no-progress'].includes(status),
    'Pagination state is inconsistent'
  );
  const conversationId = compact.conversation?.id;
  requireState(
    typeof conversationId === 'string' && /^[CDG][A-Z0-9]+$/.test(conversationId),
    'Pagination conversation identity is unavailable'
  );
  if (compact.operation === 'read-dm')
    requireState(
      compact.conversation.kind === 'dm' &&
        (compact.conversation.dmKind === 'group'
          ? conversationId.match(/^[CG][A-Z0-9]+$/)?.[0] === conversationId
          : /^D[A-Z0-9]+$/.test(conversationId)),
      'Pagination group DM identity is invalid or individual DM identity changed'
    );
  const before = timestamps(nativePage.beforeTimestamps, 'before');
  const after = timestamps(nativePage.afterTimestamps, 'after');
  const reference = typeof cursor === 'string' ? cursor.match(referencePattern) : null;
  if (direction !== null) {
    requireState(
      reference?.[1] === conversationId,
      'Pagination cursor belongs to a different conversation'
    );
    requireState(
      before.includes(reference[2]),
      'Pagination cursor is stale or not exposed before paging'
    );
  }
  if (scrollAttempts > 0)
    requireState(
      after.includes(direction === 'older' ? before[0] : before.at(-1)),
      'Pagination snapshots do not retain the verified scrolled edge'
    );

  const isThread = compact.operation === 'read-thread';
  const rootTS = isThread ? compact.thread?.rootTS : null;
  if (isThread)
    requireState(
      typeof rootTS === 'string' &&
        timestampPattern.test(rootTS) &&
        compact.thread.ref === `${conversationId}:${rootTS}`,
      'Pagination thread root identity is invalid'
    );
  const records = isThread ? compact.thread?.replies : compact.messages;
  requireState(Array.isArray(records), 'Pagination message records are unavailable');
  const canonical = records.map((message) => messageTimestamp(message, conversationId, rootTS));
  timestamps(canonical, 'captured');
  const root = isThread ? compact.thread.root : null;
  if (root)
    requireState(
      messageTimestamp(root, conversationId, rootTS) === rootTS,
      'Pagination root message identity changed'
    );
  if (isThread)
    requireState(
      canonical.every((value) => value > rootTS),
      'Pagination replies contain the root or an earlier message'
    );
  const captured = root ? [rootTS, ...canonical] : canonical;
  requireState(
    captured.length === after.length && captured.every((value, index) => value === after[index]),
    'Pagination semantic messages differ from the verified native capture'
  );

  const eligible = canonical.flatMap((value, index) =>
    direction === null || (direction === 'older' ? value < reference[2] : value > reference[2])
      ? [{ timestamp: value, record: records[index] }]
      : []
  );
  requireState(
    status !== 'advanced' || eligible.length > 0,
    'Pagination reported advancement without new messages'
  );
  requireState(
    status !== 'no-progress' || eligible.length === 0,
    'Pagination reported no progress despite eligible messages'
  );
  const forward = direction === 'newer' || (direction === null && isThread);
  const selected = forward ? eligible.slice(0, 10) : eligible.slice(-10);
  const result = structuredClone(compact);
  const pageRecords = selected.map(({ record }) => structuredClone(record));
  if (isThread) {
    result.thread.replies = pageRecords;
    result.thread.observedReplyCount = pageRecords.length;
    result.thread.capturedReplyCount = records.length;
  } else result.messages = pageRecords;

  const isGroupDM = result.operation === 'read-dm' && result.conversation.dmKind === 'group';
  const argument = isThread
    ? result.thread.ref
    : isGroupDM
      ? `group:${conversationId}`
      : result.conversation.name;
  requireState(
    typeof argument === 'string' && argument.length > 0,
    'Pagination navigation destination is unavailable'
  );
  const action = (way, timestamp) => {
    if (!timestamp) return null;
    const ref = `${conversationId}:${timestamp}`;
    return {
      cursor: ref,
      navigation: {
        command: result.operation,
        args: [argument, `--${way === 'older' ? 'before' : 'after'}=${ref}`],
      },
    };
  };
  const first = selected[0]?.timestamp;
  const last = selected.at(-1)?.timestamp;
  let older = action('older', first);
  let newer = action('newer', last);
  if (direction === null && !isThread) newer = null;
  if (isThread && root && first === canonical[0]) older = null;
  const total = isThread ? result.thread.displayedReplyCount : null;
  if (
    isThread &&
    root &&
    Number.isSafeInteger(total) &&
    total === records.length &&
    last === canonical.at(-1)
  )
    newer = null;
  if (status === 'no-progress') {
    older = direction === 'older' ? null : action('older', canonical[0]);
    newer = direction === 'newer' ? null : action('newer', canonical.at(-1));
  }
  const next = (direction ?? (isThread ? 'newer' : 'older')) === 'older' ? older : newer;
  result.pagination = {
    supported: true,
    direction,
    cursor,
    status,
    hasMore: null,
    nextCursor: next?.cursor ?? null,
    older,
    newer,
    capturedCount: records.length,
    eligibleCount: eligible.length,
    returnedCount: pageRecords.length,
    scrollAttempts,
  };
  const warnings = (result.coverage?.warnings ?? []).filter(
    (warning) =>
      !/^\d+ of \d+ displayed thread replies are exposed$/.test(warning) &&
      !warning.includes('No scrolling or pagination was performed')
  );
  if (isThread && Number.isSafeInteger(total) && records.length < total)
    warnings.push(`${records.length} of ${total} displayed thread replies are exposed`);
  if (status === 'no-progress')
    warnings.push(
      'No additional messages were verified in this direction; the end of history is unknown.'
    );
  result.coverage = {
    ...result.coverage,
    complete: false,
    observedCount: pageRecords.length + (root ? 1 : 0),
    capturedCount: records.length + (root ? 1 : 0),
    reason:
      'One logical page of verified loaded messages. Background pagination preserves overlap; unexposed history and message content remain unknown.',
    warnings,
  };
  return result;
}

// Aggregate independently verified pages. `extract` keeps raw AX parsing in the
// caller and lets a later malformed capture retain only the verified prefix.
export function collectPages(frames, batch, failure = {}, extract = (frame) => frame) {
  requireState(
    batch &&
      Number.isInteger(batch.requestedPages) &&
      batch.requestedPages >= 2 &&
      batch.requestedPages <= MAX_SINCE_PAGES &&
      Array.isArray(frames) &&
      frames.length > 0 &&
      batch.completedPages === frames.length &&
      frames.length <= batch.requestedPages &&
      Number.isInteger(batch.attemptedPages) &&
      batch.attemptedPages >= frames.length &&
      batch.attemptedPages <= batch.requestedPages &&
      ['older', 'newer'].includes(batch.direction),
    'Collection page budget or counts are invalid'
  );
  requireState(
    ['page-limit', 'no-progress', 'no-next-page', 'since-reached', 'error', 'time-limit'].includes(
      batch.stopReason
    ),
    'Collection stop reason is invalid'
  );
  const pages = [],
    captured = new Set(),
    selected = new Map();
  let identity = null,
    root = null,
    capturedTotal = 0,
    scrollAttempts = 0;
  let error = failure.error ?? null;
  const sameIdentity = (compact) => {
    const url = new URL(compact.view?.url);
    requireState(
      url.protocol === 'https:' &&
        url.hostname === 'app.slack.com' &&
        url.pathname.split('/')[1] === 'client' &&
        compact.workspace?.contextId &&
        url.pathname.split('/')[2] === compact.workspace.contextId,
      'Collection workspace identity is unavailable'
    );
    return JSON.stringify([
      compact.operation,
      compact.workspace.contextId,
      compact.workspace.id,
      url.origin,
      url.pathname,
      compact.conversation?.id,
      compact.conversation?.kind,
      compact.operation === 'read-dm' ? compact.conversation?.dmKind : null,
      compact.conversation?.name,
      compact.thread?.ref,
      compact.thread?.rootTS,
    ]);
  };
  for (const [index, frame] of frames.entries()) {
    try {
      const { compact, nativePage } = extract(frame, index);
      const page = paginateOutput(compact, nativePage);
      const currentIdentity = sameIdentity(page);
      requireState(
        identity === null || identity === currentIdentity,
        'Collection workspace, conversation or thread changed'
      );
      const expectedDirection =
        page.pagination.direction ?? (page.operation === 'read-thread' ? 'newer' : 'older');
      requireState(expectedDirection === batch.direction, 'Collection direction changed');
      if (pages.length) {
        const offered = pages.at(-1).pagination[batch.direction];
        requireState(
          offered &&
            page.pagination.cursor === offered.cursor &&
            page.pagination.direction === batch.direction &&
            pages.at(-1).pagination.status !== 'no-progress',
          'Collection cursor did not follow the preceding verified page'
        );
      }
      const isThread = page.operation === 'read-thread';
      const records = isThread ? compact.thread.replies : compact.messages;
      const pageRecords = isThread ? page.thread.replies : page.messages;
      const id = page.conversation.id,
        rootTS = isThread ? page.thread.rootTS : null;
      const keys = records.map((record) => messageTimestamp(record, id, rootTS));
      const pageKeys = pageRecords.map((record) => messageTimestamp(record, id, rootTS));
      // Add whole records only after the entire frame passes. Never stitch author
      // provenance or body metadata from separate observations of one message.
      // A grouped row selected at a capture edge has no visible sender. A later
      // capture also exposing its sender row replaces it as a whole record, even
      // when that capture's page selection excludes it as the cursor boundary.
      identity = currentIdentity;
      keys.forEach((key, i) => {
        captured.add(key);
        if (selected.get(key)?.author == null && records[i].author != null && selected.has(key))
          selected.set(key, structuredClone(records[i]));
      });
      capturedTotal += keys.length;
      pageKeys.forEach((key, i) => {
        const kept = selected.get(key);
        if (!kept || (kept.author == null && pageRecords[i].author != null))
          selected.set(key, pageRecords[i]);
      });
      if (isThread && !root && page.thread.root) root = page.thread.root;
      scrollAttempts += page.pagination.scrollAttempts;
      pages.push(page);
    } catch (cause) {
      if (!pages.length) throw cause;
      error = cause.message ?? String(cause);
      break;
    }
  }
  const first = pages[0],
    last = pages.at(-1);
  if (!error) {
    try {
      requireState(failure.status !== 'partial', 'Partial collection omitted its error');
      requireState(
        batch.attemptedPages === pages.length,
        'Successful collection has an unverified attempt'
      );
      requireState(
        (batch.stopReason === 'page-limit' && pages.length === batch.requestedPages) ||
          (batch.stopReason === 'no-progress' && last.pagination.status === 'no-progress') ||
          (batch.stopReason === 'no-next-page' && !last.pagination[batch.direction]) ||
          // The native reader stops paging older once a page reaches the requested start.
          (batch.stopReason === 'since-reached' &&
            batch.direction === 'older' &&
            pages.length <= batch.requestedPages),
        'Collection stop reason disagrees with the verified final page'
      );
    } catch (cause) {
      error = cause.message;
    }
  }
  const result = structuredClone(last);
  const records = [...selected.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, record]) => structuredClone(record));
  const isThread = first.operation === 'read-thread';
  result.requested = first.requested;
  result.conversation.handle = first.conversation.handle ?? null;
  result.status = error ? 'partial' : 'ok';
  if (error) {
    result.error = error;
    result.next =
      'Collected messages are retained. Inspect the current view before starting another read; no further input was attempted after the stop.';
  }
  if (isThread) {
    result.thread.root = root ? structuredClone(root) : null;
    result.thread.replies = records;
    result.thread.observedReplyCount = records.length;
    result.thread.capturedReplyCount = captured.size;
    result.thread.requestedMessageTS = first.thread.requestedMessageTS;
  } else result.messages = records;
  result.pagination = {
    ...last.pagination,
    direction: first.pagination.direction,
    cursor: first.pagination.cursor,
    capturedCount: captured.size,
    returnedCount: records.length,
    scrollAttempts,
    batch: {
      ...batch,
      completedPages: pages.length,
      stopReason: error
        ? batch.stopReason === 'time-limit'
          ? 'time-limit'
          : 'error'
        : batch.stopReason,
      deduplicatedCount: capturedTotal - captured.size,
    },
    ...(error ? { older: null, newer: null, nextCursor: null } : {}),
  };
  const warnings = [...new Set(pages.flatMap((page) => page.coverage?.warnings ?? []))].filter(
    (warning) =>
      !/^\d+ of \d+ displayed thread replies are exposed$/.test(warning) &&
      !(root && warning === 'Root message is outside this view.')
  );
  if (error) warnings.push('Collection stopped early; only the verified page prefix is included.');
  result.coverage = {
    ...result.coverage,
    complete: false,
    observedCount: records.length + (root ? 1 : 0),
    capturedCount: captured.size + (root ? 1 : 0),
    reason:
      'A bounded collection of verified pages; repeated viewport messages are deduplicated. Unexposed history and message content remain unknown.',
    warnings,
  };
  return result;
}
