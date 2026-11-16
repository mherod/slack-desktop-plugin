// Pure collection of independently verified sidebar captures. No UI or persistence.
import { compactOutput, withDMNavigation } from './slack-output.mjs';
import { collectDMViewPages } from './slack-dm-pages.mjs';

const listings = {
  channels: { pagination: 'channelPagination', ids: 'channelIds', idPattern: /^[CG][A-Z0-9]+$/ },
  dms: { pagination: 'dmPagination', ids: 'dmIds', idPattern: /^[CDG][A-Z0-9]+$/ },
};

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
const hasClass = (node, name) => node?.classes?.includes(name) === true;

function observedSidebar(frame, compact) {
  // compactOutput validates the tree's indices, ancestry and connectivity first.
  const nodes = frame.content?.nodes;
  requireState(
    Array.isArray(nodes) && nodes.length <= 5000 && frame.content.truncated !== true,
    'Sidebar capture is unavailable or exceeds its bounds'
  );
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const children = new Map(nodes.map((node) => [node.index, []]));
  for (const node of nodes) if (node.parent !== null) children.get(node.parent).push(node);
  const ancestors = (node) => {
    const result = [];
    for (let parent = byIndex.get(node.parent); parent; parent = byIndex.get(parent.parent))
      result.push(parent);
    return result;
  };
  const beneath = (node, parent) => ancestors(node).some((item) => item.index === parent.index);
  const descendants = (node) => {
    const result = [],
      pending = [...children.get(node.index)].reverse();
    while (pending.length) {
      const child = pending.pop();
      result.push(child);
      pending.push(...children.get(child.index).slice().reverse());
    }
    return result;
  };
  const root = nodes.find((node) => node.parent === null);
  let url;
  try {
    url = new URL(root.url);
  } catch {
    /* Checked below. */
  }
  requireState(
    url?.protocol === 'https:' &&
      url.hostname === 'app.slack.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.pathname.split('/')[1] === 'client' &&
      compact.workspace?.contextId &&
      url.pathname.split('/')[2] === compact.workspace.contextId &&
      typeof root.label === 'string' &&
      root.label.length > 0 &&
      frame.after?.url === root.url &&
      frame.after?.title === root.label,
    'Sidebar workspace identity is unavailable or changed during capture'
  );
  requireState(
    !nodes.some((node) => node.role === 'AXComboBox' && node.label === 'Query'),
    'Search picker appeared during sidebar collection'
  );
  const sidebars = nodes.filter((node) => hasClass(node, 'p-channel_sidebar'));
  const wrappers = nodes.filter((node) => hasClass(node, 'p-client_workspace_wrapper'));
  const outlines = nodes.filter(
    (node) => node.role === 'AXOutline' && node.label === 'Channels and direct messages'
  );
  requireState(
    sidebars.length === 1 && wrappers.length === 1 && outlines.length === 1,
    'Sidebar, workspace or outline is unavailable or ambiguous'
  );
  const sidebar = sidebars[0],
    wrapper = wrappers[0],
    outline = outlines[0],
    home = byIndex.get(sidebar.parent),
    hider = byIndex.get(outline.parent);
  requireState(
    home?.label === 'Home' &&
      hasClass(home, 'p-view_contents') &&
      hasClass(home, 'p-view_contents--sidebar') &&
      beneath(home, wrapper) &&
      typeof wrapper.label === 'string' &&
      wrapper.label.length > 0 &&
      compact.workspace.name === wrapper.label &&
      // The outline is a direct child of the sidebar in some client builds and
      // sits under a scrollbar hider in others.
      (outline.parent === sidebar.index ||
        (hider?.parent === sidebar.index && hasClass(hider, 'c-scrollbar__hider'))) &&
      hasClass(outline, 'c-virtual_list__scroll_container'),
    'Sidebar is outside the verified Home workspace structure'
  );
  requireState(
    descendants(sidebar)
      .filter(
        (node) => node.role === 'AXRow' && listings[compact.operation].idPattern.test(node.id ?? '')
      )
      .every((node) => beneath(node, outline)),
    'Sidebar rows are outside the verified sidebar outline'
  );
  const filters = descendants(home).filter(
    (node) =>
      node.role === 'AXTextField' &&
      node.label === 'Channel or user name' &&
      hasClass(node, 'c-filter_input__input')
  );
  requireState(
    filters.length === 1 &&
      typeof filters[0].stateValue === 'string' &&
      filters[0].AXValue === filters[0].stateValue,
    'Sidebar filter state is unavailable or ambiguous'
  );
  const rows = descendants(outline).filter((node) => node.role === 'AXRow');
  requireState(
    rows.length > 0 && rows.every((node) => typeof node.id === 'string' && node.id.length > 0),
    'Sidebar row identity is unavailable'
  );
  const isSection = (node) => node.role === 'AXRow' && node.id?.startsWith('sectionHeading-');
  const rowKeys = rows.map((node) =>
    JSON.stringify([
      ...ancestors(node)
        .filter(isSection)
        .reverse()
        .map((section) => section.id),
      node.id,
    ])
  );
  requireState(new Set(rowKeys).size === rowKeys.length, 'Sidebar row keys are duplicated');
  const sections = rows.filter(isSection).map((node) => {
    requireState(
      typeof node.label === 'string' &&
        (node.expanded === null || typeof node.expanded === 'boolean'),
      'Sidebar section state is incomplete'
    );
    return { id: node.id, label: node.label, expanded: node.expanded };
  });
  sections.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  requireState(
    new Set(sections.map((section) => section.id)).size === sections.length,
    'Sidebar section identities are ambiguous'
  );
  return {
    rowKeys,
    scope: {
      url: root.url,
      title: root.label,
      workspaceName: wrapper.label,
      filterValue: filters[0].stateValue,
      sections,
    },
  };
}

function verifiedFrame(frame, pid, index, operation) {
  const listing = listings[operation];
  requireState(
    frame?.operation === operation && frame.pid === pid,
    'Sidebar process or operation changed'
  );
  const compact = compactOutput(frame, operation),
    page = frame[listing.pagination],
    records = compact[operation];
  requireState(
    page &&
      Array.isArray(records) &&
      records.every((record) => listing.idPattern.test(record.id)) &&
      new Set(records.map((record) => record.id)).size === records.length,
    'Sidebar page or semantic identities are invalid'
  );
  const observed = observedSidebar(frame, compact);
  requireState(
    same(
      page[listing.ids],
      records.map((record) => record.id)
    ),
    'Sidebar semantic identities differ from the native capture'
  );
  requireState(
    same(page.afterRowKeys, observed.rowKeys) && same(page.scope, observed.scope),
    'Sidebar rows or scope differ from the native capture'
  );
  requireState(
    Array.isArray(page.beforeRowKeys) &&
      (index === 0
        ? page.status === 'initial' &&
          page.scrollAttempts === 0 &&
          page.edgeKey === null &&
          same(page.beforeRowKeys, observed.rowKeys)
        : ['advanced', 'no-progress'].includes(page.status) && page.scrollAttempts === 1),
    'Sidebar pagination state or scroll count is invalid'
  );
  const { sections, ...scope } = observed.scope;
  return {
    compact,
    records,
    page,
    sections,
    rowKeys: observed.rowKeys,
    identity: JSON.stringify([compact.workspace.contextId, compact.workspace.id, scope]),
  };
}

function verifyAdvance(previous, current) {
  const before = previous.rowKeys,
    after = current.rowKeys,
    edge = before.at(-1),
    edgeIndex = after.indexOf(edge);
  requireState(
    previous.page.status !== 'no-progress' &&
      before.length > 0 &&
      same(current.page.beforeRowKeys, before) &&
      current.page.edgeKey === edge &&
      edgeIndex >= 0,
    'Sidebar continuation lost its verified edge'
  );
  const beforeSet = new Set(before),
    afterSet = new Set(after);
  requireState(
    same(
      before.filter((key) => afterSet.has(key)),
      after.filter((key) => beforeSet.has(key))
    ),
    'Sidebar common rows changed order'
  );
  const newPositions = after.flatMap((key, index) => (beforeSet.has(key) ? [] : [index]));
  requireState(
    newPositions.every((index) => index > edgeIndex),
    'Sidebar exposed new rows before its downward edge'
  );
  requireState(
    current.page.status === (newPositions.length ? 'advanced' : 'no-progress'),
    'Sidebar progress status disagrees with its observed rows'
  );
}

function collectSidebarPages(receipt, operation) {
  const frames = receipt?.pages,
    batch = receipt?.batch;
  requireState(
    receipt?.operation === operation &&
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
      ['page-limit', 'no-progress', 'no-next-page', 'error', 'time-limit'].includes(
        batch.stopReason
      ),
    'Sidebar collection page budget or counts are invalid'
  );
  const verified = [],
    records = new Map(),
    sections = new Map();
  let error = typeof receipt.error === 'string' && receipt.error ? receipt.error : null;
  let capturedCount = 0,
    scrollAttempts = 0;
  for (const [index, frame] of frames.entries()) {
    try {
      const current = verifiedFrame(frame, receipt.pid, index, operation),
        previous = verified.at(-1);
      if (previous) {
        requireState(
          current.identity === previous.identity,
          'Sidebar workspace, view or filter changed'
        );
        verifyAdvance(previous, current);
      }
      for (const section of current.sections)
        requireState(
          !sections.has(section.id) || same(sections.get(section.id), section),
          'Sidebar section label or expansion changed'
        );
      // Check the entire frame before accepting any records from it.
      for (const record of current.records)
        requireState(
          !records.has(record.id) ||
            (records.get(record.id).name === record.name &&
              records.get(record.id).kind === record.kind),
          'One sidebar ID has conflicting names or kinds across captures'
        );
      for (const section of current.sections) sections.set(section.id, section);
      for (const record of current.records)
        if (!records.has(record.id)) records.set(record.id, structuredClone(record));
      capturedCount += current.records.length;
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
        'Successful sidebar collection has an unverified attempt'
      );
      requireState(
        (batch.stopReason === 'page-limit' &&
          verified.length === batch.requestedPages &&
          last.page.status !== 'no-progress') ||
          (batch.stopReason === 'no-progress' && last.page.status === 'no-progress'),
        'Sidebar stop reason disagrees with its verified final capture'
      );
    } catch (cause) {
      error = cause.message;
    }
  }
  const result = structuredClone(last.compact);
  result.status = error ? 'partial' : 'ok';
  result[operation] =
    operation === 'dms' ? withDMNavigation([...records.values()]) : [...records.values()];
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
    reason: `A bounded downward collection from the current sidebar position; collapsed sections, unexposed ${operation === 'dms' ? 'DMs' : 'channels'} and the full workspace directory remain outside coverage.`,
    warnings: [...new Set(verified.flatMap((item) => item.compact.coverage?.warnings ?? []))],
  };
  if (error) {
    result.error = error;
    result.next = `Verified ${operation === 'dms' ? 'DMs' : 'channels'} are retained. Inspect the current Slack sidebar before starting another command.`;
    result.coverage.warnings.push(
      'Sidebar collection stopped early; only the verified capture prefix is included.'
    );
  }
  return result;
}

export function collectChannelPages(receipt) {
  return collectSidebarPages(receipt, 'channels');
}

export function collectDMPages(receipt, options = {}) {
  if (receipt?.pages?.[0]?.dmPagination?.scope?.source === 'dms-view')
    return collectDMViewPages(receipt, options);
  if (options.dmSearch !== undefined)
    throw new Error('Native DMs search requires verified DMs view captures');
  return collectSidebarPages(receipt, 'dms');
}
