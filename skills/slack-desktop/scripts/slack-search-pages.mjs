// Pure collection of independently verified native search-page receipts.
import { compactOutput } from './slack-output.mjs';

const controls = new Set([
  'AXButton',
  'AXPopUpButton',
  'AXCheckBox',
  'AXComboBox',
  'AXRadioButton',
]);
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

function resultKey(permalink) {
  let url;
  try {
    url = new URL(permalink);
  } catch {
    /* Report the identity below. */
  }
  const path = url?.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/);
  requireState(
    typeof permalink === 'string' &&
      url?.protocol === 'https:' &&
      path &&
      (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !permalink.includes('#') &&
      !/^https:\/\/[^/]*@/i.test(permalink),
    'Search match has no canonical observed Slack permalink'
  );
  const roots = url.searchParams.getAll('thread_ts'),
    channels = url.searchParams.getAll('cid');
  requireState(
    roots.length <= 1 &&
      channels.length <= 1 &&
      (!roots.length || /^\d{10}\.\d{6}$/.test(roots[0])) &&
      (!channels.length || channels[0] === path[1]),
    'Search match permalink has conflicting identity parameters'
  );
  return `${url.hostname}:${path[1]}:${path[2]}.${path[3]}`;
}

function observedScope(frame, empty) {
  const nodes = frame.content.nodes;
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const beneath = (node, parent) => {
    for (let next = byIndex.get(node.parent); next; next = byIndex.get(next.parent))
      if (next.index === parent.index) return true;
    return false;
  };
  const containers = nodes.filter((node) => node.id === 'filters-container');
  requireState(containers.length === 1, 'Search filter container is unavailable or ambiguous');
  const container = containers[0];
  const owner = byIndex.get(container.parent);
  const views = nodes.filter(
    (node) => node.classes?.includes('p-view_contents') && node.label === 'Search'
  );
  requireState(
    views.length === 1 && beneath(container, views[0]),
    'Search filter view is unavailable or ambiguous'
  );
  requireState(
    owner?.index === views[0].index
      ? owner.role === 'AXGroup'
      : owner?.classes?.includes('c-scrollbar__hider'),
    'Search filters are outside the results container'
  );
  const lists = nodes.filter(
    (node) => node.role === 'AXList' && node.label?.startsWith('Message results,')
  );
  requireState(
    empty ? lists.length === 0 : lists.length === 1 && lists[0].parent === container.parent,
    'Search filters do not belong to the verified result list'
  );
  const descendants = nodes.filter((node) => beneath(node, container));
  if (empty) {
    const emptyStates = nodes.filter((node) => node.classes?.includes('c-empty_state'));
    requireState(
      emptyStates.length === 1 && beneath(emptyStates[0], owner),
      'Empty search state is outside the verified results container'
    );
  }
  const toolbars = descendants.filter(
    (node) => node.role === 'AXToolbar' && node.label === 'Filter by'
  );
  requireState(toolbars.length === 1, 'Search filter toolbar is unavailable or ambiguous');
  const resetClassSets = [
    new Set(['c-button-unstyled', 'p-search_filter__reset_button']),
    new Set(['c-button--focus-visible', 'c-button-unstyled', 'p-search_filter__reset_button']),
  ];
  const observedReset = (node) =>
    node.id === '' &&
    node.role === 'AXButton' &&
    node.label === 'Reset' &&
    node.parent === toolbars[0].index &&
    toolbars[0].parent === container.index &&
    node.stateValue === '' &&
    node.selected === false &&
    node.url == null &&
    Array.isArray(node.classes) &&
    resetClassSets.some(
      (expected) =>
        node.classes.length === expected.size &&
        new Set(node.classes).size === expected.size &&
        node.classes.every((name) => expected.has(name))
    ) &&
    !nodes.some((child) => child.parent === node.index);
  const sorts = descendants.filter((node) => node.id === 'search-filter-sort-filter');
  const observedFeedback = (node) =>
    node.id === '' &&
    node.role === 'AXButton' &&
    node.label === 'Give feedback' &&
    node.parent === container.index &&
    toolbars[0].parent === container.index &&
    sorts.length === 1 &&
    sorts[0].role === 'AXPopUpButton' &&
    sorts[0].parent === container.index &&
    node.stateValue === '' &&
    node.selected === false &&
    node.url == null &&
    Array.isArray(node.classes) &&
    (same([...node.classes].sort(), ['c-link--button']) ||
      same([...node.classes].sort(), ['c-link--button', 'c-link--focus-visible'])) &&
    !nodes.some((child) => child.parent === node.index);
  const scope = descendants
    .filter((node) => controls.has(node.role))
    .map((node) => {
      requireState(
        typeof node.id === 'string' &&
          (node.id.length > 0 || observedReset(node) || observedFeedback(node)) &&
          (node.stateValue === null || typeof node.stateValue === 'string') &&
          (node.selected === null || typeof node.selected === 'boolean') &&
          Array.isArray(node.classes) &&
          node.classes.every((value) => typeof value === 'string'),
        'Search filter state is incomplete'
      );
      return {
        role: node.role,
        id: node.id,
        label: node.label ?? '',
        value: node.stateValue,
        selected: node.selected,
        classes: [...node.classes].sort(),
      };
    })
    .sort((left, right) =>
      left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : left.label < right.label
            ? -1
            : left.label > right.label
              ? 1
              : 0
    );
  requireState(
    // Only the two independently recognized idless shapes may coexist. Keep
    // their actual IDs in output; labels disambiguate only the uniqueness key.
    new Set(scope.map((node) => JSON.stringify([node.id, node.id === '' ? node.label : null])))
      .size === scope.length &&
      scope.some(
        (node) => node.id === 'search-filter-sort-filter' && node.role === 'AXPopUpButton'
      ),
    'Search sort/filter controls are unavailable or ambiguous'
  );
  return scope;
}

function verifiedFrame(frame, query, pid, index) {
  requireState(
    frame?.operation === 'search' && frame.pid === pid,
    'Search process or operation changed'
  );
  const compact = compactOutput(frame, 'search', query),
    page = frame.searchPagination;
  requireState(
    page &&
      page.query === query &&
      typeof page.emptyResults === 'boolean' &&
      page.pressAttempts === (index === 0 ? 0 : 1),
    'Search page receipt is invalid'
  );
  let url;
  try {
    url = new URL(compact.view?.url);
  } catch {
    /* Check below. */
  }
  requireState(
    url?.protocol === 'https:' &&
      url.hostname === 'app.slack.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.pathname === `/client/${compact.workspace?.contextId}/search` &&
      compact.workspace?.contextId,
    'Search workspace identity is unavailable'
  );
  const empty = page.emptyResults;
  requireState(
    Array.isArray(compact.messages) && compact.messages.length <= 100,
    'Search page exceeds the bounded result count'
  );
  if (empty)
    requireState(
      index === 0 &&
        compact.search.totalResults === 0 &&
        compact.messages.length === 0 &&
        compact.search.page === null &&
        compact.search.pageCount === null &&
        page.page === null &&
        page.pageCount === null &&
        page.nextPage === null,
      'Empty search lacks matching native and semantic evidence'
    );
  else
    requireState(
      Number.isSafeInteger(page.page) &&
        Number.isSafeInteger(page.pageCount) &&
        page.page > 0 &&
        page.page <= page.pageCount &&
        (index > 0 || page.page === 1) &&
        compact.search.page === page.page &&
        compact.search.pageCount === page.pageCount &&
        compact.messages.length > 0 &&
        page.nextPage === (page.page < page.pageCount ? page.page + 1 : null),
      'Search page numbers or continuation are invalid'
    );
  const keys = compact.messages.map((message) => resultKey(message.permalink));
  requireState(
    same(keys, page.resultKeys),
    'Search semantic result identities differ from the native capture'
  );
  const scope = observedScope(frame, empty);
  requireState(
    same(scope, page.scope),
    'Search semantic filter state differs from the native capture'
  );
  return {
    compact,
    page,
    keys,
    identity: JSON.stringify([
      url.href,
      compact.workspace.contextId,
      compact.workspace.id,
      query,
      page.pageCount,
      scope,
    ]),
  };
}

export function collectSearchPages(receipt, query) {
  const frames = receipt?.pages,
    batch = receipt?.batch;
  requireState(
    receipt?.operation === 'search' &&
      Number.isSafeInteger(receipt.pid) &&
      receipt.pid > 0 &&
      typeof query === 'string' &&
      query.length > 0 &&
      batch?.direction === 'next' &&
      Number.isInteger(batch.requestedPages) &&
      batch.requestedPages >= 2 &&
      batch.requestedPages <= 10 &&
      Array.isArray(frames) &&
      frames.length > 0 &&
      batch.completedPages === frames.length &&
      Number.isInteger(batch.attemptedPages) &&
      batch.attemptedPages >= frames.length &&
      batch.attemptedPages <= batch.requestedPages &&
      ['page-limit', 'no-next-page', 'no-progress', 'error', 'time-limit'].includes(
        batch.stopReason
      ),
    'Search collection page budget or counts are invalid'
  );
  const verified = [],
    matches = new Map();
  let error = typeof receipt.error === 'string' && receipt.error ? receipt.error : null;
  let capturedCount = 0,
    pressAttempts = 0;
  for (const [index, frame] of frames.entries()) {
    try {
      const current = verifiedFrame(frame, query, receipt.pid, index),
        previous = verified.at(-1);
      if (previous) {
        requireState(
          current.identity === previous.identity,
          'Search query, workspace, filters or page count changed'
        );
        requireState(
          previous.page.nextPage === current.page.page &&
            current.page.page === previous.page.page + 1,
          'Search page did not follow the preceding continuation'
        );
        requireState(
          !same(current.keys, previous.keys),
          'Search result page did not advance beyond its prior contents'
        );
        requireState(previous.added > 0, 'Search continued after a page added no new matches');
      }
      let added = 0;
      for (const [position, key] of current.keys.entries())
        if (!matches.has(key)) {
          matches.set(key, structuredClone(current.compact.messages[position]));
          added++;
        }
      current.added = added;
      capturedCount += current.keys.length;
      pressAttempts += current.page.pressAttempts;
      verified.push(current);
    } catch (cause) {
      if (!verified.length) throw cause;
      error = cause.message ?? String(cause);
      break;
    }
  }
  const first = verified[0],
    last = verified.at(-1);
  if (!error) {
    try {
      requireState(
        receipt.status === 'ok' && batch.attemptedPages === verified.length,
        'Successful search collection has an unverified attempt'
      );
      requireState(
        (batch.stopReason === 'page-limit' && verified.length === batch.requestedPages) ||
          (batch.stopReason === 'no-next-page' && last.page.nextPage === null) ||
          (batch.stopReason === 'no-progress' && verified.length > 1 && last.added === 0),
        'Search stop reason disagrees with its verified final page'
      );
    } catch (cause) {
      error = cause.message;
    }
  }
  const result = structuredClone(last.compact);
  result.status = error ? 'partial' : 'ok';
  result.requested = query;
  result.messages = [...matches.values()];
  result.search = { ...result.search, firstPage: first.page.page, lastPage: last.page.page };
  result.pagination = {
    supported: true,
    direction: 'next',
    hasMore: error ? null : last.page.nextPage !== null,
    nextCursor: null,
    nextPage: error || batch.stopReason === 'no-progress' ? null : last.page.nextPage,
    capturedCount,
    returnedCount: matches.size,
    pressAttempts,
    batch: {
      ...batch,
      completedPages: verified.length,
      stopReason: error
        ? batch.stopReason === 'time-limit'
          ? 'time-limit'
          : 'error'
        : batch.stopReason,
      deduplicatedCount: capturedCount - matches.size,
    },
  };
  result.coverage = {
    ...result.coverage,
    complete: false,
    observedCount: matches.size,
    capturedCount,
    reason:
      'A bounded collection of observed search snippets in Slack result order; matching message content and search completeness remain unknown.',
    warnings: [...new Set(verified.flatMap((item) => item.compact.coverage?.warnings ?? []))],
  };
  if (error) {
    result.error = error;
    result.next =
      'Verified matches are retained. Inspect the current Slack search before starting another command.';
    result.coverage.warnings.push(
      'Search collection stopped early; only the verified page prefix is included.'
    );
  }
  return result;
}
