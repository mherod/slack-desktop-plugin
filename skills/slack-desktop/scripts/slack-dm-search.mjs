// The native helper owns autocomplete interaction and identity extraction.
// Bind its bounded receipts to the caller before retaining any suggestion page.
import { verifyDMSearchRequest } from './slack-output.mjs';

const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clean = (value, limit = 2000) =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  Array.from(value).length <= limit &&
  !/[\x00-\x1f\x7f-\x9f]/.test(value);
const safeHandle = (value) => clean(value, 200) && /^[A-Za-z0-9._-]+$/.test(value);

function observedScope(scope, requested) {
  let url;
  try {
    url = new URL(scope?.url);
  } catch {}
  const contextId = url?.pathname.match(/^\/client\/([TE][A-Z0-9]{1,63})\/dms$/)?.[1];
  requireState(
    scope?.source === 'dms-search-autocomplete' &&
      url?.href === scope.url &&
      url.protocol === 'https:' &&
      url.hostname === 'app.slack.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      contextId &&
      clean(scope.workspaceName) &&
      scope.query === requested &&
      typeof scope.unreadOnly === 'boolean',
    'DMs autocomplete workspace, query or control scope is invalid'
  );
  return {
    source: scope.source,
    url: scope.url,
    workspaceName: scope.workspaceName,
    contextId,
    query: scope.query,
    unreadOnly: scope.unreadOnly,
  };
}

function observedPage(page, requested) {
  const scope = observedScope(page?.scope, requested);
  requireState(
    Array.isArray(page.matches) &&
      page.matches.length <= 500 &&
      typeof page.empty === 'boolean' &&
      page.empty === (page.matches.length === 0),
    'DMs autocomplete matches or explicit empty state are invalid'
  );
  const keys = new Set();
  const records = page.matches.map((match) => {
    requireState(
      typeof match?.key === 'string' &&
        /^option:(?:0|[1-9]\d*)$/.test(match.key) &&
        Number.isSafeInteger(Number(match.key.slice(7))) &&
        !keys.has(match.key) &&
        ['person', 'group'].includes(match.kind) &&
        clean(match.name) &&
        (match.handle === null || clean(match.handle, 200)) &&
        (match.kind !== 'group' || match.handle === null),
      'DMs autocomplete suggestion identity is invalid or duplicated'
    );
    keys.add(match.key);
    return {
      suggestionKey: match.key,
      id: null,
      kind: match.kind,
      name: match.name,
      handle: match.handle,
      existence: 'unknown',
      participantLabels: [],
      url: null,
      unread: null,
      selected: null,
      sections: [],
      navigation: null,
    };
  });
  return { scope, records, keys: [...keys], empty: page.empty };
}

function navigation(records) {
  const names = new Map(),
    handles = new Map();
  for (const record of records) {
    if (record.kind === 'group') names.set(record.name, (names.get(record.name) ?? 0) + 1);
    if (record.kind === 'person' && record.handle)
      handles.set(record.handle, (handles.get(record.handle) ?? 0) + 1);
  }
  return records.map((record) => ({
    ...record,
    navigation:
      record.kind === 'group' &&
      clean(record.name, 200) &&
      !/[\u202a-\u202e\u2066-\u2069]/.test(record.name) &&
      names.get(record.name) === 1
        ? { command: 'read-dm', args: [`group-name:${record.name}`, '--allow-clipboard'] }
        : record.kind === 'person' && safeHandle(record.handle) && handles.get(record.handle) === 1
          ? { command: 'read-dm', args: [`@${record.handle}`] }
          : null,
  }));
}

export function collectDMSearchPages(receipt, requested, requestedPages = 1) {
  verifyDMSearchRequest(receipt, requested);
  const batch = receipt?.batch,
    frames = receipt?.searchPages;
  requireState(
    clean(requested, 200) &&
      Number.isSafeInteger(receipt.pid) &&
      receipt.pid > 0 &&
      ['ok', 'partial'].includes(receipt.status) &&
      Number.isInteger(requestedPages) &&
      requestedPages >= 1 &&
      requestedPages <= 10 &&
      batch?.requestedPages === requestedPages &&
      Array.isArray(frames) &&
      frames.length > 0 &&
      frames.length <= requestedPages &&
      batch.collectedPages === frames.length &&
      Number.isInteger(batch.attemptedPages) &&
      batch.attemptedPages >= frames.length &&
      batch.attemptedPages <= requestedPages &&
      ['requested-pages', 'no-progress', 'empty-results', 'guard-failed'].includes(
        batch.stopReason
      ),
    'DMs autocomplete collection budget or counts are invalid'
  );
  const accepted = [],
    records = new Map();
  let capturedCount = 0,
    error = receipt.error === undefined ? null : receipt.error;
  requireState(
    error === null || (typeof error === 'string' && error.length > 0),
    'DMs autocomplete failure is invalid'
  );
  for (const frame of frames) {
    try {
      const current = observedPage(frame, requested),
        previous = accepted.at(-1);
      if (previous) {
        requireState(
          !previous.empty && !current.empty && same(current.scope, previous.scope),
          'DMs autocomplete scope or empty state changed during collection'
        );
        const before = new Set(previous.keys),
          after = new Set(current.keys),
          edgeIndex = current.keys.indexOf(previous.keys.at(-1));
        requireState(
          edgeIndex >= 0 &&
            same(
              previous.keys.filter((key) => after.has(key)),
              current.keys.filter((key) => before.has(key))
            ) &&
            current.keys.every((key, index) => before.has(key) || index > edgeIndex) &&
            current.keys.some((key) => !records.has(key)),
          'DMs autocomplete page order changed or supplied no new suggestions'
        );
      }
      for (const record of current.records) {
        const prior = records.get(record.suggestionKey);
        requireState(
          !prior || same(prior, record),
          'One autocomplete option has conflicting identities across captures'
        );
      }
      for (const record of current.records)
        if (!records.has(record.suggestionKey)) records.set(record.suggestionKey, record);
      capturedCount += current.records.length;
      accepted.push(current);
    } catch (cause) {
      if (!accepted.length) throw cause;
      error = cause.message;
      break;
    }
  }
  const last = accepted.at(-1);
  if (!error) {
    try {
      requireState(
        receipt.status === 'ok' &&
          ((batch.stopReason === 'requested-pages' &&
            accepted.length === requestedPages &&
            batch.attemptedPages === accepted.length &&
            !last.empty) ||
            (batch.stopReason === 'no-progress' &&
              batch.attemptedPages === accepted.length + 1 &&
              !last.empty) ||
            (batch.stopReason === 'empty-results' &&
              accepted.length === 1 &&
              batch.attemptedPages === 1 &&
              last.empty)),
        'DMs autocomplete terminal state does not match its verified captures'
      );
    } catch (cause) {
      error = cause.message;
    }
  }
  return {
    schemaVersion: 1,
    operation: 'dms',
    status: error ? 'partial' : 'ok',
    requested: null,
    workspace: {
      name: last.scope.workspaceName,
      contextId: last.scope.contextId,
      id: last.scope.contextId.startsWith('T') ? last.scope.contextId : null,
    },
    view: { url: last.scope.url },
    dms: navigation([...records.values()]),
    coverage: {
      source: 'dms-search-autocomplete',
      complete: false,
      scope: 'captured Slack DMs autocomplete suggestions',
      observedCount: records.size,
      filters: { query: requested },
      controls: { unreadOnly: last.scope.unreadOnly, appliesToSearch: null },
      search: { source: 'dms-search-autocomplete', requestedQuery: requested, verified: true },
      warnings: [
        'People may be directory matches without an existing DM. Conversation IDs and complete group membership are unknown.',
        'The unread toggle is preserved; its effect on autocomplete suggestions is not verified.',
      ],
    },
    pagination: {
      supported: true,
      direction: 'down',
      hasMore: null,
      nextCursor: null,
      capturedCount,
      returnedCount: records.size,
      batch: {
        requestedPages,
        attemptedPages: batch.attemptedPages,
        completedPages: accepted.length,
        stopReason: error ? 'guard-failed' : batch.stopReason,
        deduplicatedCount: capturedCount - records.size,
      },
    },
    ...(error
      ? {
          error,
          next: 'Only verified search suggestions are retained. Inspect Slack before retrying.',
        }
      : {}),
  };
}
