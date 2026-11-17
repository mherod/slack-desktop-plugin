// Pure extraction from a private, already-verified native accessibility receipt.
// No UI actions, network requests, file reads, or inferred message permalinks.
import { extractMedia, quotedMessageSource } from './slack-media.mjs';
import { canonicalChannelSearch } from './slack-search-identity.mjs';

const hasClass = (node, name) => node.classes?.includes(name) === true;
const text = (node) => (typeof node?.label === 'string' && node.label !== '' ? node.label : null);
const optionalString = (value) => (typeof value === 'string' && value !== '' ? value : null);
const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const threadNavigation = (ref) => (ref ? { command: 'read-thread', args: [ref] } : null);
function channelNavigation(name) {
  if (typeof name !== 'string') return null;
  const normalized = name.startsWith('#') ? name.slice(1) : name;
  return [...normalized].length <= 80 && /^[\p{L}\p{N}_-]+$/u.test(normalized)
    ? { command: 'read-channel', args: [name] }
    : null;
}

// Navigation is derived from the whole observed set, including group names.
// Individual reads verify picker identity; group references verify the exact
// conversation ID and group kind after navigation through supported controls.
export function withDMNavigation(dms) {
  const names = new Map();
  for (const dm of dms) {
    if (!names.has(dm.name)) names.set(dm.name, new Set());
    names.get(dm.name).add(dm.id);
  }
  return dms.map((dm) => {
    const name = dm.name;
    if (
      dm.kind === 'group' &&
      typeof dm.id === 'string' &&
      dm.id.match(/^[CG][A-Z0-9]+$/)?.[0] === dm.id
    )
      return { ...dm, navigation: { command: 'read-dm', args: [`group:${dm.id}`] } };
    const safe =
      ['one-to-one', 'self'].includes(dm.kind) &&
      /^D[A-Z0-9]+$/.test(dm.id) &&
      typeof name === 'string' &&
      name.length > 0 &&
      name.length <= 500 &&
      name.trim() === name &&
      !name.startsWith('@') &&
      !name.startsWith('group:') &&
      !name.startsWith('group-name:') &&
      !/[\p{Cc}\p{Cf}]/u.test(name) &&
      names.get(name).size === 1;
    return { ...dm, navigation: safe ? { command: 'read-dm', args: [name] } : null };
  });
}

function parsedURL(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function indexTree(rawNodes) {
  requireState(
    Array.isArray(rawNodes) && rawNodes.length > 0,
    'Structured content nodes are missing'
  );
  const nodes = rawNodes.map((node) => ({
    ...node,
    classes: Array.isArray(node.classes) ? node.classes : [],
  }));
  const byIndex = new Map();
  const childMap = new Map();
  for (const node of nodes) {
    requireState(
      Number.isInteger(node.index) && !byIndex.has(node.index),
      'Invalid or duplicate accessibility node index'
    );
    byIndex.set(node.index, node);
    childMap.set(node.index, []);
  }
  const roots = [];
  for (const node of nodes) {
    if (node.parent === null) roots.push(node);
    else {
      requireState(byIndex.has(node.parent), 'Accessibility node parent is missing');
      childMap.get(node.parent).push(node);
    }
  }
  requireState(roots.length === 1, 'Expected one captured accessibility root');
  const children = (node) => childMap.get(node.index) ?? [];
  const descendants = (node) => {
    const result = [],
      pending = [...children(node)].reverse(),
      seen = new Set([node.index]);
    while (pending.length) {
      const child = pending.pop();
      requireState(!seen.has(child.index), 'Accessibility tree contains a cycle');
      seen.add(child.index);
      result.push(child);
      pending.push(...children(child).slice().reverse());
    }
    return result;
  };
  requireState(
    descendants(roots[0]).length + 1 === nodes.length,
    'Accessibility tree contains disconnected nodes'
  );
  const ancestor = (node, predicate) => {
    for (let parent = byIndex.get(node.parent); parent; parent = byIndex.get(parent.parent)) {
      if (predicate(parent)) return parent;
    }
    return null;
  };
  return { nodes, root: roots[0], children, descendants, ancestor };
}

function narrowIdentity(value, fallback = null) {
  return {
    title: optionalString(value?.title) ?? optionalString(value?.label) ?? text(fallback),
    url: optionalString(value?.url) ?? optionalString(fallback?.url),
  };
}

function workspaceIdentity(tree, target) {
  const root = tree.root;
  const path = parsedURL(root.url)?.pathname.split('/').filter(Boolean) ?? [];
  const contextId = path[0] === 'client' ? (path[1] ?? null) : null;
  const wrappers = tree.nodes.filter((node) => hasClass(node, 'p-client_workspace_wrapper'));
  let name = wrappers.length === 1 ? text(wrappers[0]) : null;
  const prefix = target ? conversationTitlePrefix(text(root), target.name, target.kind) : null;
  if (!name && prefix) {
    const remainder = text(root).slice(prefix.length);
    if (remainder.endsWith(' - Slack'))
      name = remainder.slice(0, -8).replace(/ - \d+ new items?$/, '');
  }
  return { name, contextId, id: /^T[A-Z0-9]+$/.test(contextId ?? '') ? contextId : null };
}

function observedLink(node) {
  const url = parsedURL(node.url);
  return url && ['https:', 'http:', 'mailto:'].includes(url.protocol)
    ? { label: text(node), url: node.url }
    : null;
}

function sidebarChannels(tree) {
  const sidebars = tree.nodes.filter((node) => hasClass(node, 'p-channel_sidebar'));
  requireState(sidebars.length === 1, 'Expected one exposed channel sidebar');
  const rows = tree
    .descendants(sidebars[0])
    .filter((node) => node.role === 'AXRow' && /^[CG][A-Z0-9]+$/.test(node.id ?? ''));
  const channels = new Map();
  let skipped = 0;
  for (const row of rows) {
    const content = tree.descendants(row);
    const groups = content.filter((node) => hasClass(node, 'p-channel_sidebar__channel'));
    if (groups.length !== 1) {
      skipped++;
      continue;
    }
    const group = groups[0];
    // Observed group DMs can have C-prefixed IDs. Semantic markers take priority.
    if (
      hasClass(group, 'p-channel_sidebar__channel--mpim') ||
      hasClass(group, 'p-channel_sidebar__channel--im') ||
      hasClass(group, 'p-channel_sidebar__channel--im-you') ||
      content.some((node) => hasClass(node, 'p-channel_sidebar__user_avatar'))
    )
      continue;
    const names = tree.children(group).filter((node) => node.role === 'AXStaticText' && text(node));
    if (names.length !== 1) {
      skipped++;
      continue;
    }
    const name = text(names[0]);
    const section = tree.ancestor(
      row,
      (node) => node.role === 'AXRow' && node.id?.startsWith('sectionHeading-')
    );
    const links = content
      .filter((node) => node.role === 'AXLink')
      .map(observedLink)
      .filter(Boolean);
    const existing = channels.get(row.id);
    requireState(
      !existing || existing.name === name,
      'One sidebar channel ID has conflicting names'
    );
    if (existing) {
      if (text(section) && !existing.sections.includes(text(section)))
        existing.sections.push(text(section));
      if (hasClass(group, 'p-channel_sidebar__channel--unread')) existing.unread = true;
      if (hasClass(group, 'p-channel_sidebar__channel--selected')) existing.selected = true;
      continue;
    }
    channels.set(row.id, {
      id: row.id,
      name,
      url: links.length === 1 ? links[0].url : null,
      isPrivate: null,
      unread: hasClass(group, 'p-channel_sidebar__channel--unread') ? true : null,
      selected: hasClass(group, 'p-channel_sidebar__channel--selected') ? true : null,
      sections: text(section) ? [text(section)] : [],
      navigation: channelNavigation(name),
    });
  }
  return { channels: [...channels.values()], skipped };
}

function sidebarDMs(tree) {
  const sidebars = tree.nodes.filter((node) => hasClass(node, 'p-channel_sidebar'));
  requireState(sidebars.length === 1, 'Expected one exposed DM sidebar');
  const outlines = tree.nodes.filter(
    (node) => node.role === 'AXOutline' && text(node) === 'Channels and direct messages'
  );
  requireState(
    outlines.length === 1 && tree.ancestor(outlines[0], (node) => node.index === sidebars[0].index),
    'Expected one DM outline inside the verified sidebar'
  );
  requireState(
    !tree.nodes.some((node) => node.role === 'AXComboBox' && text(node) === 'Query'),
    'Search picker appeared during DM capture'
  );
  requireState(
    tree
      .descendants(sidebars[0])
      .filter((node) => node.role === 'AXRow' && /^[CDG][A-Z0-9]+$/.test(node.id ?? ''))
      .every((row) => tree.ancestor(row, (node) => node.index === outlines[0].index)),
    'DM rows are outside the verified sidebar outline'
  );
  const outlineRows = tree.descendants(outlines[0]).filter((node) => node.role === 'AXRow');
  requireState(outlineRows.length > 0, 'DM sidebar rows are not exposed');
  const rows = outlineRows.filter((node) => /^[CDG][A-Z0-9]+$/.test(node.id ?? ''));
  const dms = new Map();
  let skipped = 0;
  const dmMarker = (node) =>
    hasClass(node, 'p-channel_sidebar__channel--mpim') ||
    hasClass(node, 'p-channel_sidebar__channel--im') ||
    hasClass(node, 'p-channel_sidebar__channel--im-you') ||
    hasClass(node, 'p-channel_sidebar__user_avatar');
  for (const row of rows) {
    const content = tree.descendants(row);
    const groups = content.filter((node) => hasClass(node, 'p-channel_sidebar__channel'));
    const individualId = /^D[A-Z0-9]+$/.test(row.id);
    if (!individualId && !content.some(dmMarker)) continue;
    if (groups.length !== 1) {
      skipped++;
      continue;
    }
    const group = groups[0];
    const mpim = hasClass(group, 'p-channel_sidebar__channel--mpim');
    const im = hasClass(group, 'p-channel_sidebar__channel--im');
    const self = hasClass(group, 'p-channel_sidebar__channel--im-you');
    const avatar = content.some((node) => hasClass(node, 'p-channel_sidebar__user_avatar'));
    const tokens = tree
      .children(group)
      .filter((node) => node.role === 'AXStaticText' && text(node))
      .map(text);
    let name = null,
      kind = null;
    if (mpim && !im && !self && /^[CG][A-Z0-9]+$/.test(row.id)) {
      if (
        tokens.length >= 3 &&
        tokens.length % 2 === 1 &&
        tokens.every((token, index) => (index % 2 === 1 ? token === ', ' : token !== ', '))
      ) {
        name = tokens.join('');
        kind = 'group';
      }
    } else if (individualId && !mpim && (avatar || im || self)) {
      if (
        tokens.length > 0 &&
        tokens.slice(1).every((token) => token === 'guest' || (self && token === 'you'))
      ) {
        name = tokens[0];
        kind = self ? 'self' : 'one-to-one';
      }
    }
    if (name === null || kind === null) {
      skipped++;
      continue;
    }
    const section = tree.ancestor(
      row,
      (node) => node.role === 'AXRow' && node.id?.startsWith('sectionHeading-')
    );
    const existing = dms.get(row.id);
    requireState(
      !existing || (existing.name === name && existing.kind === kind),
      'One sidebar DM ID has conflicting names or kinds'
    );
    if (existing) {
      if (text(section) && !existing.sections.includes(text(section)))
        existing.sections.push(text(section));
      if (hasClass(group, 'p-channel_sidebar__channel--unread')) existing.unread = true;
      if (hasClass(group, 'p-channel_sidebar__channel--selected')) existing.selected = true;
      continue;
    }
    const links = content
      .filter((node) => node.role === 'AXLink')
      .map(observedLink)
      .filter(Boolean);
    dms.set(row.id, {
      id: row.id,
      name,
      kind,
      url: links.length === 1 ? links[0].url : null,
      handle: null,
      unread: hasClass(group, 'p-channel_sidebar__channel--unread') ? true : null,
      selected: hasClass(group, 'p-channel_sidebar__channel--selected') ? true : null,
      sections: text(section) ? [text(section)] : [],
      navigation: null,
    });
  }
  return { dms: withDMNavigation([...dms.values()]), skipped };
}

const canonicalDMID = (value) =>
  typeof value === 'string' && value.match(/^[CDG][A-Z0-9]+$/)?.[0] === value;
const sameHubScope = (left, right) =>
  left &&
  right &&
  JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());

// Slack's contenteditable search field exposes this adornment in its raw value
// and two text children. Strip it only when both observations agree exactly.
export function dmSearchQuery(filterValue, filterText) {
  requireState(
    typeof filterValue === 'string' &&
      Array.isArray(filterText) &&
      filterText.every((label) => typeof label === 'string'),
    'DMs search query observations are invalid'
  );
  const suffix = '\u00a0 \u00a0';
  if (filterValue.endsWith(suffix)) {
    const query = filterValue.slice(0, -suffix.length);
    if (filterText.length === 2 && filterText[0] === `${query}\u00a0` && filterText[1] === '\u00a0')
      return query;
  }
  return filterValue;
}

export function verifyDMSearchRequest(receipt, requested, scope) {
  if (requested === undefined) return;
  requireState(
    typeof requested === 'string' &&
      Array.from(requested).length <= 200 &&
      !/[\x00-\x1f\x7f-\x9f]/.test(requested),
    'DMs search request is invalid'
  );
  requireState(
    receipt?.operation === 'dms' &&
      receipt.dmSearch?.requested === requested &&
      receipt.dmSearch.verified === true,
    'DMs search request lacks matching native verification'
  );
  if (scope !== undefined)
    requireState(
      scope?.source === 'dms-view' && scope.searchQuery === requested,
      'DMs search query differs from the requested search'
    );
}

// Match only after the complete capture/collection and its navigation hints
// have been verified. Hidden names must still participate in ambiguity checks.
export function applyDMFilter(compact, query) {
  if (query == null) return compact;
  requireState(
    typeof query === 'string' &&
      Array.from(query).length <= 200 &&
      !/[\x00-\x1f\x7f-\x9f]/.test(query),
    'DM filter must contain at most 200 characters without controls'
  );
  requireState(
    compact?.operation === 'dms' &&
      ['dms-view', 'dms-search-autocomplete'].includes(compact.coverage?.source) &&
      Array.isArray(compact.dms),
    'Local DM matching requires verified DMs view records'
  );
  const needle = query.toLowerCase();
  const dms = compact.dms.filter((dm) => {
    requireState(Array.isArray(dm.participantLabels ?? []), 'DM participant labels are invalid');
    const labels = [dm.name, ...(dm.participantLabels ?? [])];
    requireState(
      labels.every((label) => typeof label === 'string'),
      'DM match labels are invalid'
    );
    return !query || labels.some((label) => label.toLowerCase().includes(needle));
  });
  return {
    ...compact,
    dms,
    ...(compact.pagination?.supported
      ? { pagination: { ...compact.pagination, returnedCount: dms.length } }
      : {}),
    coverage: {
      ...compact.coverage,
      match: {
        query,
        fields: ['name', 'participantLabels'],
        observedCount: compact.dms.length,
        matchedCount: dms.length,
        scope: 'captured DM names and observed participant header labels',
      },
    },
  };
}

const messageSeconds = (message) => {
  const match = /^message-list_([0-9]{10})\.[0-9]{6}$/.exec(message?.id ?? '');
  return match ? Number(match[1]) : null;
};

// The span of the collected conversation messages, taken from their row
// identities. Recorded before any local selection so it describes what was
// scanned, not what was kept.
export function withMessageRange(compact) {
  if (!['read-channel', 'read-dm'].includes(compact?.operation) || !Array.isArray(compact.messages))
    return compact;
  const dated = compact.messages.filter((message) => messageSeconds(message) !== null);
  if (dated.length === 0 || dated.length !== compact.messages.length) return compact;
  const ordered = [...dated].sort((a, b) => messageSeconds(a) - messageSeconds(b));
  const oldest = ordered[0],
    newest = ordered.at(-1);
  return {
    ...compact,
    coverage: {
      ...compact.coverage,
      range: {
        oldestTimestamp: messageSeconds(oldest),
        newestTimestamp: messageSeconds(newest),
        oldest: typeof oldest.displayedTime === 'string' ? oldest.displayedTime : null,
        newest: typeof newest.displayedTime === 'string' ? newest.displayedTime : null,
      },
    },
  };
}

// Keep the collected messages on or after a requested start. `reached` says
// whether the collection actually extends back to that start; when it does
// not, older matching messages may exist beyond the collected pages.
export function applySince(compact, since) {
  if (since == null) return compact;
  requireState(
    Number.isSafeInteger(since.epoch) && since.epoch > 0 && typeof since.requested === 'string',
    'Since boundary is invalid'
  );
  requireState(
    ['read-channel', 'read-dm'].includes(compact?.operation) && Array.isArray(compact.messages),
    'A since boundary requires verified conversation messages'
  );
  const seconds = compact.messages.map(messageSeconds);
  requireState(
    seconds.every((value) => value !== null),
    'A collected message has no timestamp identity'
  );
  const messages = compact.messages.filter((_, index) => seconds[index] >= since.epoch);
  return {
    ...compact,
    messages,
    coverage: {
      ...compact.coverage,
      since: {
        requested: since.requested,
        epoch: since.epoch,
        observedCount: compact.messages.length,
        matchedCount: messages.length,
        reached: seconds.some((value) => value <= since.epoch),
      },
    },
  };
}

// Local author selection over already verified messages. It never changes what
// Slack was asked for; it only narrows the collected records and says how many
// were scanned, so an empty result is not mistaken for an empty conversation.
export function applyAuthorFilter(compact, query) {
  if (query == null) return compact;
  requireState(
    typeof query === 'string' &&
      query.trim() !== '' &&
      Array.from(query).length <= 200 &&
      !/[\x00-\x1f\x7f-\x9f]/.test(query),
    'Author filter must contain 1–200 characters without controls'
  );
  requireState(
    ['read-channel', 'read-dm', 'search'].includes(compact?.operation) &&
      Array.isArray(compact.messages),
    'Local author matching requires verified message records'
  );
  const needle = query.toLowerCase();
  const messages = compact.messages.filter((message) => {
    requireState(
      message.author == null || typeof message.author === 'string',
      'Message author is invalid'
    );
    return (message.author ?? '').toLowerCase().includes(needle);
  });
  return {
    ...compact,
    messages,
    coverage: {
      ...compact.coverage,
      authorMatch: {
        query,
        field: 'author',
        observedCount: compact.messages.length,
        matchedCount: messages.length,
        scope: 'observed author names of the collected messages',
      },
    },
  };
}

// Observe the list independently of the native page metadata. The DMs hub also
// exposes an adjacent conversation and message previews; neither supplies names,
// handles, links or row identity for this listing.
export function hubObservation(receipt) {
  const content = receipt?.content;
  requireState(
    Array.isArray(content?.nodes) && content.nodes.length <= 5000 && content.truncated !== true,
    'DMs view capture is unavailable or exceeds its bounds'
  );
  const tree = indexTree(content.nodes),
    root = tree.root,
    url = parsedURL(root.url),
    wrappers = tree.nodes.filter((node) => hasClass(node, 'p-client_workspace_wrapper'));
  requireState(
    root.role === 'AXWebArea' &&
      text(root) &&
      url?.protocol === 'https:' &&
      url.hostname === 'app.slack.com' &&
      url.href === root.url &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      !url.search &&
      /^\/client\/[A-Z0-9]+\/dms$/.test(url.pathname) &&
      receipt.after?.url === root.url &&
      receipt.after?.title === text(root) &&
      wrappers.length === 1 &&
      text(wrappers[0]),
    'DMs view workspace identity is unavailable or changed during capture'
  );
  requireState(
    !tree.nodes.some((node) => node.role === 'AXComboBox' && text(node) === 'Query'),
    'Search picker appeared during DMs view capture'
  );
  const beneath = (node, parent) =>
    tree.ancestor(node, (ancestor) => ancestor.index === parent.index) !== null;
  const tabs = tree.nodes.filter((node) => node.role === 'AXRadioButton' && node.id === 'dms');
  requireState(
    tabs.length === 1 &&
      hasClass(tabs[0], 'p-tab_rail__button') &&
      text(tabs[0]) === 'DMs' &&
      tabs[0].stateValue === '1' &&
      tabs[0].selected === true,
    'DMs tab is unavailable or not selected'
  );
  const views = tree.nodes.filter(
    (node) =>
      hasClass(node, 'p-view_contents') &&
      hasClass(node, 'p-view_contents--sidebar') &&
      ['Direct messages', 'Direct Messages'].includes(text(node))
  );
  requireState(
    views.length === 1 &&
      beneath(views[0], wrappers[0]) &&
      tree.ancestor(
        views[0],
        (node) => hasClass(node, 'p-client_workspace__tabpanel') && text(node) === 'DMs'
      ),
    'Expected one DMs view in the selected workspace'
  );
  const view = views[0],
    viewNodes = tree.descendants(view),
    recent = viewNodes.filter((node) => hasClass(node, 'p-recent_page'));
  requireState(recent.length === 1, 'DMs recent-conversations container is ambiguous');
  const lists = tree
    .descendants(recent[0])
    .filter((node) => node.role === 'AXList' && hasClass(node, 'c-virtual_list__scroll_container'));
  requireState(
    lists.length === 1 &&
      ['Direct messages', 'Recent conversations'].includes(text(lists[0])) &&
      // The list is a direct child of the recent page in some client builds
      // and sits under a scrollbar hider in others.
      tree
        .children(recent[0])
        .some(
          (node) =>
            node.index === lists[0].index ||
            (hasClass(node, 'c-scrollbar__hider') &&
              tree.children(node).some((child) => child.index === lists[0].index))
        ),
    'Expected one supported recent-conversations list in the DMs view'
  );
  // Identify wrappers before checking their children: an extra candidate with a
  // missing or malformed query field must still make the destination ambiguous.
  const isHeaderDestination = (node) => {
    if (node.role !== 'AXGroup' || node.id !== '' || node.label !== '') return false;
    const bar = tree.ancestor(node, () => true);
    if (
      !bar ||
      bar.role !== 'AXGroup' ||
      bar.id !== '' ||
      bar.label !== '' ||
      !hasClass(bar, 'p-dms_page_header_search_bar')
    )
      return false;
    const header = tree.ancestor(bar, () => true);
    return (
      header?.role === 'AXGroup' &&
      header.id === '' &&
      header.label === 'Search DMs' &&
      hasClass(header, 'p-dms_page_header') &&
      hasClass(header, 'p-dms_page_header__search-bar') &&
      header.parent === view.index &&
      view.role === 'AXGroup' &&
      view.id === ''
    );
  };
  const list = lists[0],
    fields = viewNodes.filter((node) => node.id === 'dms_tab_page__destination'),
    filterContainers = viewNodes.filter(
      (node) =>
        hasClass(node, 'p-dms_page_header_search_bar__destination__multi_select_input') ||
        isHeaderDestination(node)
    ),
    unreadControls = viewNodes.filter((node) => hasClass(node, 'p-unreads_toggle'));
  requireState(
    fields.length === 1 &&
      fields[0].role === 'AXComboBox' &&
      text(fields[0]) === 'Search query' &&
      typeof fields[0].stateValue === 'string' &&
      fields[0].stateValue === fields[0].AXValue &&
      filterContainers.length === 1 &&
      tree.children(filterContainers[0]).length === 1 &&
      tree.children(filterContainers[0])[0].index === fields[0].index &&
      tree
        .descendants(fields[0])
        .every(
          (node) =>
            node.role === 'AXStaticText' &&
            typeof node.label === 'string' &&
            (node.label.trim() === '' || node.label.trim() === fields[0].stateValue.trim())
        ) &&
      unreadControls.length === 1 &&
      unreadControls[0].role === 'AXCheckBox' &&
      text(unreadControls[0])?.startsWith('Filter by unread messages; ') &&
      ['0', '1'].includes(unreadControls[0].stateValue),
    'DMs view filter state is missing, ambiguous or contains unsupported recipient chips'
  );
  const rows = tree.children(list);
  requireState(
    rows.length > 0 &&
      rows.every(
        (node) =>
          node.role === 'AXGroup' &&
          hasClass(node, 'c-virtual_list__item') &&
          canonicalDMID(node.id)
      ) &&
      new Set(rows.map((row) => row.id)).size === rows.length &&
      tree
        .descendants(recent[0])
        .filter((node) => hasClass(node, 'c-virtual_list__item') && canonicalDMID(node.id))
        .every((node) => node.parent === list.index),
    'DMs view row identities are missing, duplicated or outside the verified list'
  );
  const dms = [];
  let skipped = 0;
  for (const row of rows) {
    const containers = tree.children(row),
      bodies = containers.length === 1 ? tree.children(containers[0]) : [];
    if (
      containers.length !== 1 ||
      containers[0].role !== 'AXGroup' ||
      !hasClass(containers[0], 'p-activity_ia4_page__item_container') ||
      bodies.length !== 1 ||
      bodies[0].role !== 'AXGroup' ||
      !hasClass(bodies[0], 'c-message_kit__message') ||
      !hasClass(bodies[0], 'p-activity_ia4_page__item') ||
      !hasClass(bodies[0], 'p-activity_ia4_page__item--dms')
    ) {
      skipped++;
      continue;
    }
    const body = bodies[0],
      children = tree.children(body),
      meta = children.filter((node) => hasClass(node, 'p-dms_channel__meta')),
      metaIndex = meta.length === 1 ? children.indexOf(meta[0]) : -1,
      header = metaIndex >= 0 ? children.slice(0, metaIndex) : [],
      labels = header.filter((node) => node.role === 'AXStaticText' && text(node)),
      stacked = header.filter(
        (node) => node.role === 'AXGroup' && hasClass(node, 'c-base_icon_image_stacked')
      ),
      avatars = header.filter((node) => node.role === 'AXImage');
    let kind = null;
    if (/^[CG]/.test(row.id) && stacked.length === 1 && avatars.length === 0) kind = 'group';
    if (row.id.startsWith('D') && stacked.length === 0 && avatars.length > 0) {
      const self =
        labels.length === 3 && labels[1].label.trim() === '' && labels[2].label === '(you)';
      kind = self ? 'self' : labels.length === 1 ? 'one-to-one' : null;
    }
    if (
      meta.length !== 1 ||
      meta[0].role !== 'AXGroup' ||
      !labels.length ||
      labels[0].label.trim() === '' ||
      !kind
    ) {
      skipped++;
      continue;
    }
    dms.push({
      id: row.id,
      name: labels[0].label,
      kind,
      participantLabels:
        kind === 'group'
          ? labels
              .slice(1)
              .map((node) => node.label)
              .filter((value) => value.trim() !== '')
          : [],
      url: null,
      handle: null,
      unread: hasClass(body, 'p-activity_ia4_page__item--unread--dm') ? true : null,
      selected: hasClass(body, 'p-activity_ia4_page__item--selected--dm') ? true : null,
      sections: [],
      navigation: null,
    });
  }
  requireState(
    dms.length > 0,
    'No supported DM rows were exposed; no empty-directory claim returned'
  );
  const filterText = tree.descendants(fields[0]).map((node) => node.label);
  const searchQuery = Object.hasOwn(receipt.dmPagination?.scope ?? {}, 'searchQuery')
    ? dmSearchQuery(fields[0].stateValue, filterText)
    : undefined;
  return {
    dms: withDMNavigation(dms),
    skipped,
    rowKeys: rows.map((row) => row.id),
    scope: {
      source: 'dms-view',
      url: root.url,
      title: text(root),
      workspaceName: text(wrappers[0]),
      viewLabel: text(view),
      listLabel: text(list),
      filterValue: fields[0].stateValue,
      filterText,
      ...(searchQuery !== undefined ? { searchQuery } : {}),
      unreadOnly: unreadControls[0].stateValue === '1',
      tabSelected: true,
    },
  };
}

const metadataClasses = new Set([
  'c-message__sender_button',
  'c-timestamp',
  'c-message__reply_count',
  'c-message__reply_bar_description',
  'c-message_kit__reaction_bar',
  'c-reaction_bar',
  'c-message_kit__file',
  'p-message_gallery_image_file',
  'c-file_gallery_image_file',
]);
const isMetadata = (node) =>
  node.classes.some((name) => metadataClasses.has(name)) ||
  node.classes.some((name) =>
    /^(?:p-composer|p-message_input|p-workspace__input|c-message_actions)/.test(name)
  );
// Search highlighting splits one paragraph into adjacent static-text runs ("From ", "BlackSmith",
// " ^"). A run whose every word starts with, or begins, a term of the observed query is a highlight.
export function searchHighlight(query) {
  const terms = String(query ?? '')
    .split(/\s+/)
    .filter((term) => term && !/^-?[a-z]+:/i.test(term))
    .map((term) => term.replace(/^["']+|["']+$/g, '').toLowerCase())
    .filter((term) => /[\p{L}\p{N}]/u.test(term));
  if (!terms.length) return null;
  return (value) => {
    const words = String(value ?? '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return (
      words.length > 0 &&
      words.every((word) => terms.some((term) => word.startsWith(term) || term.startsWith(word)))
    );
  };
}

function renderBodyTokens(
  node,
  tree,
  links,
  verbatim = false,
  excludedNodes = new Set(),
  highlight = null
) {
  const literal = (value) => (value ? [{ value, emoji: false }] : []);
  if (excludedNodes.has(node.index)) return [];
  if (hasClass(node, 'c-search__expand')) return literal(' … ');
  if (
    isMetadata(node) ||
    ['AXTextArea', 'AXTextField', 'AXComboBox', 'AXButton', 'AXCheckBox', 'AXPopUpButton'].includes(
      node.role
    )
  )
    return [];
  if (hasClass(node, 'c-mrkdwn__br')) return literal('\n');
  verbatim ||= hasClass(node, 'c-mrkdwn__pre') || hasClass(node, 'c-mrkdwn__code');
  const children = tree.children(node);
  if (node.role === 'AXLink') {
    const link = observedLink(node);
    if (link && !links.some((item) => item.url === link.url && item.label === link.label))
      links.push(link);
    return children.length
      ? children.flatMap((child) =>
          renderBodyTokens(child, tree, links, verbatim, excludedNodes, highlight)
        )
      : literal(text(node));
  }
  if (node.role === 'AXStaticText')
    return children.length
      ? children.flatMap((child) =>
          renderBodyTokens(child, tree, links, verbatim, excludedNodes, highlight)
        )
      : literal(text(node));
  if (node.role === 'AXImage')
    return (hasClass(node, 'c-emoji') ||
      tree.ancestor(node, (parent) => hasClass(parent, 'c-emoji'))) &&
      text(node)
      ? [{ value: text(node), emoji: !verbatim }]
      : [];
  const body = children.flatMap((child, index) => {
    const tokens = renderBodyTokens(child, tree, links, verbatim, excludedNodes, highlight);
    // Adjacent AX static-text nodes can represent separate flattened paragraphs, except where
    // search highlighting split one paragraph around a matched term.
    const previous = children[index - 1];
    const highlighted =
      highlight !== null &&
      !verbatim &&
      (highlight(text(child)) || highlight(text(previous)));
    const separator =
      tokens.length &&
      index > 0 &&
      child.role === 'AXStaticText' &&
      previous.role === 'AXStaticText' &&
      !highlighted
        ? literal('\n')
        : [];
    return [...separator, ...tokens];
  });
  return body.length &&
    (hasClass(node, 'p-rich_text_section') ||
      hasClass(node, 'c-mrkdwn__pre') ||
      hasClass(node, 'c-mrkdwn__quote') ||
      node.role === 'AXListItem')
    ? [...body, ...literal('\n')]
    : body;
}

function joinBodyTokens(tokens) {
  let result = '',
    previous = null;
  for (const token of tokens) {
    if (!token.value) continue;
    const emojiBoundary = token.emoji || previous?.emoji;
    const needsSpace =
      emojiBoundary &&
      result &&
      !/\s$/.test(result) &&
      !/^\s/.test(token.value) &&
      !/[([{]$/.test(result) &&
      !/^[.,!?;:)\]}]/.test(token.value);
    result += `${needsSpace ? ' ' : ''}${token.value}`;
    previous = token;
  }
  return result;
}

function messageRecord(item, tree, conversationId, day, searchResult = false, highlight = null) {
  const nodes = tree.descendants(item);
  const containers = nodes.filter(
    (node) =>
      hasClass(node, 'c-message_kit__actions') &&
      !tree.ancestor(node, (parent) => hasClass(parent, 'c-message_kit__actions'))
  );
  requireState(containers.length === 1, 'Message content container is absent or ambiguous');
  const container = containers[0];
  for (const node of nodes.filter(
    (node) => hasClass(node, 'c-message_kit__actions') && node.index !== container.index
  )) {
    const card = tree.ancestor(node, (parent) => hasClass(parent, 'c-message_attachment'));
    requireState(
      card && quotedMessageSource(card, tree),
      'Nested message content lacks verified quoted attribution'
    );
  }
  const headers = searchResult
    ? tree.children(container).filter((node) => hasClass(node, 'c-search_message__content_header'))
    : [];
  if (searchResult)
    requireState(headers.length === 1, 'Search result header is absent or ambiguous');
  const metadata = (searchResult ? tree.descendants(headers[0]) : nodes).filter(
    (node) => !tree.ancestor(node, (parent) => hasClass(parent, 'c-message_attachment'))
  );
  const authors = metadata.filter((node) => hasClass(node, 'c-message__sender_button'));
  const timestamps = metadata.filter((node) => hasClass(node, 'c-timestamp'));
  requireState(authors.length <= 1 && timestamps.length <= 1, 'Message metadata is ambiguous');
  const timestamp = timestamps[0] ?? null;
  const permalinkURL = timestamp ? parsedURL(timestamp.url) : null;
  const permalinkPath = permalinkURL?.pathname.match(/^\/archives\/([A-Z0-9]+)\/p\d+$/);
  if (permalinkPath && conversationId !== null)
    requireState(
      permalinkPath[1] === conversationId,
      'Message permalink belongs to a different conversation'
    );
  const permalink =
    permalinkPath &&
    permalinkURL.protocol === 'https:' &&
    (permalinkURL.hostname === 'slack.com' || permalinkURL.hostname.endsWith('.slack.com'))
      ? timestamp.url
      : null;
  const children = tree.children(container);
  const timestampChild =
    timestamp &&
    children.find(
      (child) =>
        child.index === timestamp.index ||
        tree.descendants(child).some((node) => node.index === timestamp.index)
    );
  const timestampPosition = timestampChild ? children.indexOf(timestampChild) : -1;
  const bodyNodes =
    timestampPosition >= 0
      ? children.slice(timestampPosition + 1)
      : children.filter(
          (node) =>
            hasClass(node, 'p-rich_text_section') ||
            node.classes.some((name) => name.startsWith('c-mrkdwn__'))
        );
  const messageRef = messageThreadRef(permalink, 1);
  const { attachments, previews, excludedNodes } = extractMedia(container, tree, {
    messageRef,
    permalink,
  });
  const cards = tree
    .descendants(container)
    .filter(
      (node) =>
        hasClass(node, 'c-message_attachment') &&
        !tree.ancestor(node, (parent) => hasClass(parent, 'c-message_attachment')) &&
        tree.descendants(node).some((child) => hasClass(child, 'c-message_attachment__author_name'))
    );
  const quotedMessages = cards.map((card) => {
    const content = tree.descendants(card);
    const source = quotedMessageSource(card, tree);
    const links = [];
    const quoteExcluded = new Set(excludedNodes);
    for (const node of content) {
      if (
        hasClass(node, 'c-message_attachment__author_name') ||
        hasClass(node, 'c-message_attachment__permalink') ||
        hasClass(node, 'c-message_attachment__footer') ||
        hasClass(node, 'c-message_attachment')
      )
        quoteExcluded.add(node.index);
    }
    const body = joinBodyTokens(
      tree
        .children(card)
        .flatMap((node) => renderBodyTokens(node, tree, links, false, quoteExcluded, highlight))
    ).trim();
    return {
      author: source?.author ?? null,
      permalink: source?.permalink ?? null,
      text: body || null,
      links,
      textComplete: false,
    };
  });
  for (const card of cards) excludedNodes.add(card.index);
  const links = [];
  const body = joinBodyTokens(
    bodyNodes.flatMap((node) =>
      renderBodyTokens(node, tree, links, false, excludedNodes, highlight)
    )
  ).trim();
  const replies = nodes.filter(
    (node) =>
      hasClass(node, 'c-message__reply_count') &&
      !tree.ancestor(node, (parent) => hasClass(parent, 'c-message_attachment'))
  );
  const replyLabel = replies.length === 1 ? text(replies[0]) : null;
  const count = replyLabel?.match(/^(\d+) repl(?:y|ies)$/);
  const replyCount = count ? Number(count[1]) : null;
  const ref = messageThreadRef(permalink, replies[0]?.role === 'AXButton' ? replyCount : null);
  return {
    id: item.id,
    author: authors.length === 1 ? text(authors[0]) : null,
    displayedTime: text(timestamp),
    displayedDay: day,
    permalink,
    text: body || null,
    links,
    attachments,
    previews,
    quotedMessages,
    thread: {
      displayedSummary: replyLabel,
      replyCount,
      repliesRead: false,
      ref,
      navigation: threadNavigation(ref),
    },
    textComplete: false,
  };
}

function verifiedDMForeword(item, tree, kind = 'dm') {
  if (
    item.id !== 'message-list_0000000000.000001' ||
    item.role !== 'AXGroup' ||
    !hasClass(item, 'c-virtual_list__item')
  )
    return false;
  const children = tree.children(item);
  // Two observed welcome layouts share the description group: the classic
  // avatars/profile-button row and the newer entity avatar/name-button row.
  const layouts = [
    [
      ['AXGroup', 'p-message_pane__foreword__avatars'],
      ['AXGroup', 'p-message_pane__foreword__description'],
      ['AXButton', 'p-message_pane__foreword__profile-button'],
    ],
    [
      ['AXButton', 'p-new_im_foreword-entity__avatar-button'],
      ['AXButton', 'p-new_im_foreword-entity__name_button'],
      ['AXGroup', 'p-message_pane__foreword__description'],
    ],
    // Channel welcome: a title heading and description, followed by action cards.
    [
      ['AXHeading', 'p-message_pane__foreword__title'],
      ['AXGroup', 'p-message_pane__foreword__description'],
    ],
  ];
  const description = children.find(
    (node) => node.role === 'AXGroup' && hasClass(node, 'p-message_pane__foreword__description')
  );
  const descriptionChildren = description ? tree.children(description) : [];
  const [intro, profile, outro] = descriptionChildren;
  const profileURL = parsedURL(profile?.url);
  const profileClasses = ['c-link', 'c-member_slug', 'c-member_slug--light', 'c-member_slug--link'];
  // The observed individual-DM introduction owns one profile link. This is not
  // a general exception for links inside welcome rows or message-like sentinels.
  const linkedIntroduction =
    kind === 'dm' &&
    layouts[1].every(
      ([role, name]) =>
        children.filter((node) => node.role === role && hasClass(node, name)).length === 1
    ) &&
    descriptionChildren.length === 3 &&
    intro.role === 'AXStaticText' &&
    text(intro) === 'This conversation is just between you and ' &&
    outro.role === 'AXStaticText' &&
    text(outro) === '. Take a look at their profile to learn more about them.' &&
    profile.role === 'AXLink' &&
    text(profile) &&
    profile.classes.length === profileClasses.length &&
    profileClasses.every((name) => hasClass(profile, name)) &&
    profileURL?.protocol === 'https:' &&
    (profileURL.hostname === 'slack.com' || profileURL.hostname.endsWith('.slack.com')) &&
    !profileURL.username &&
    !profileURL.password &&
    !profileURL.port &&
    !profileURL.search &&
    !profileURL.hash &&
    profile.url === `${profileURL.origin}${profileURL.pathname}` &&
    profileURL.pathname.match(/^\/team\/U[A-Z0-9]+$/)?.[0] === profileURL.pathname;
  return (
    // DM layouts never authorise a channel row, and the channel layout never a DM row.
    (kind === 'channel' ? layouts.slice(2) : layouts.slice(0, 2)).some((markers) =>
      markers.every(
        ([role, name]) =>
          children.filter((node) => node.role === role && hasClass(node, name)).length === 1
      )
    ) &&
    ![item, ...tree.descendants(item)].some(
      (node) =>
        hasClass(node, 'c-message_kit__actions') ||
        hasClass(node, 'c-timestamp') ||
        (node.role === 'AXLink' && !(linkedIntroduction && node.index === profile.index)) ||
        /^\/archives\/[CDG][A-Z0-9]+\/p[0-9]+$/.test(parsedURL(node.url)?.pathname ?? '')
    )
  );
}

function verifiedGroupDMForeword(item, tree) {
  if (
    item.id !== 'message-list_0000000000.000001' ||
    item.role !== 'AXGroup' ||
    !hasClass(item, 'c-virtual_list__item')
  )
    return false;
  const children = tree.children(item);
  const avatars = children[0];
  const notification = children.at(-1);
  const wrappedAvatars =
    avatars?.role === 'AXGroup' && hasClass(avatars, 'p-message_pane__foreword__avatars');
  // One observed group welcome layout exposes the avatar buttons directly.
  // Accept only its contiguous leaf-button prefix, never arbitrary flattened content.
  const directAvatarClasses = [
    'c-button-unstyled',
    'p-message_pane__foreword__avatar',
    'c-avatar',
    'c-avatar--interactive',
  ];
  const directAvatarLayouts = [
    directAvatarClasses,
    [...directAvatarClasses, 'c-avatar--deleted_member'],
    [...directAvatarClasses, 'c-button--focus-visible'],
    [...directAvatarClasses, 'c-button--focus-visible', 'c-avatar--deleted_member'],
  ];
  const isDirectAvatar = (node) =>
    node.role === 'AXButton' &&
    directAvatarLayouts.some(
      (expected) =>
        node.classes.length === expected.length && expected.every((name) => hasClass(node, name))
    ) &&
    tree.children(node).length === 0;
  const introIndex = wrappedAvatars ? 1 : children.findIndex((node) => !isDirectAvatar(node));
  const avatarChildren = wrappedAvatars ? tree.children(avatars) : children.slice(0, introIndex);
  if (
    introIndex < 1 ||
    children[introIndex]?.role !== 'AXStaticText' ||
    text(children[introIndex]) !==
      'This is the very beginning of your direct message history with ' ||
    notification?.role !== 'AXGroup' ||
    !hasClass(notification, 'p-message_pane__foreword__notification_setting')
  )
    return false;
  const members = children.slice(introIndex + 1, -1);
  const profile = (node) => {
    const url = parsedURL(node.url);
    return (
      node.role === 'AXLink' &&
      hasClass(node, 'c-member_slug') &&
      hasClass(node, 'c-member_slug--link') &&
      url?.protocol === 'https:' &&
      (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      node.url === `${url.origin}${url.pathname}` &&
      url.pathname.match(/^\/team\/U[A-Z0-9]+$/)?.[0] === url.pathname
    );
  };
  if (
    members.length < 3 ||
    members.length % 2 !== 1 ||
    !members.every((node, index) =>
      index % 2 === 0
        ? profile(node)
        : node.role === 'AXStaticText' && [', ', ' and ', ', and '].includes(text(node))
    )
  )
    return false;
  const memberCount = (members.length + 1) / 2;
  const descendants = [item, ...tree.descendants(item)];
  return (
    avatarChildren.length === memberCount &&
    avatarChildren.every(
      (node) => node.role === 'AXButton' && hasClass(node, 'p-message_pane__foreword__avatar')
    ) &&
    descendants.filter((node) => node.role === 'AXLink').length === memberCount &&
    !descendants.some(
      (node) =>
        hasClass(node, 'c-message_kit__actions') ||
        hasClass(node, 'c-timestamp') ||
        parsedURL(node.url)?.pathname.startsWith('/archives/')
    )
  );
}

function mainConversationPanes(tree) {
  return tree.nodes.filter(
    (node) =>
      hasClass(node, 'p-message_pane') &&
      tree.ancestor(node, (parent) => hasClass(parent, 'p-workspace__primary_view_body')) &&
      !tree.ancestor(node, (parent) =>
        parent.classes.some((name) => /^(?:p-thread|p-threads)/.test(name))
      )
  );
}

function conversationListMatches(node, name, kind) {
  const kinds = kind === 'channel' ? ['channel', 'private channel', 'shared channel'] : [kind];
  return (
    node.role === 'AXList' &&
    kinds.some((value) => {
      const prefix = `${name} (${value}`;
      return text(node)?.startsWith(`${prefix},`) || text(node) === `${prefix})`;
    })
  );
}

const hasTitleMarker = (value) => typeof value === 'string' && /^[*!] /.test(value);
function conversationTitlePrefix(title, name, kind) {
  const prefix = `${name} (${kind === 'dm' ? 'DM' : 'Channel'}) - `;
  return (
    [prefix, `* ${prefix}`, `! ${prefix}`].find((candidate) => title?.startsWith(candidate)) ?? null
  );
}

function corroboratedTitleName(tree, titleName, kind) {
  if (!hasTitleMarker(titleName)) return titleName;
  const panes = mainConversationPanes(tree);
  requireState(panes.length === 1, 'Expected one main conversation message pane');
  // A leading marker is removable only when the primary conversation's own list
  // exposes that exact name. Literal leading-marker names remain unchanged.
  const lists = tree.descendants(panes[0]);
  const candidates = [titleName, titleName.slice(2)].filter(
    (name) => name && lists.some((node) => conversationListMatches(node, name, kind))
  );
  requireState(
    candidates.length === 1,
    'Expected one message list corroborating the conversation title'
  );
  return candidates[0];
}

// Slack omits the sender on a row grouped under the previous message from the
// same person; such a row carries an adjacent compact timestamp in its upper
// actions block. Conversation lists use `p-message_pane_message__compact_timestamp`
// and thread panes use `p-thread_compact_gutter_generic`, each with an
// `--adjacent` modifier. Inherit the author only from the structurally preceding
// row of the same capture, and return the sender state for the next row.
const GROUPED_GUTTERS = [
  'p-message_pane_message__compact_timestamp',
  'p-thread_compact_gutter_generic',
];

function inferGroupedSender(message, descendants, tree, sender) {
  const compactTimestamp = descendants.find(
    (node) =>
      GROUPED_GUTTERS.some((name) => hasClass(node, name) && hasClass(node, `${name}--adjacent`)) &&
      tree.descendants(node).some((child) => hasClass(child, 'c-timestamp'))
  );
  const grouped =
    compactTimestamp &&
    tree.ancestor(
      compactTimestamp,
      (node) =>
        hasClass(node, 'c-message_kit__actions') && hasClass(node, 'c-message_kit__actions--above')
    );
  if (message.author) return { author: message.author, messageId: message.id };
  if (grouped && sender) {
    message.author = sender.author;
    message.authorInferred = true;
    message.authorSourceMessageId = sender.messageId;
    return sender;
  }
  return null;
}

function conversationMessages(tree, target, conversationId) {
  const panes = mainConversationPanes(tree);
  requireState(panes.length === 1, 'Expected one main conversation message pane');
  const kind =
    target.kind === 'dm'
      ? target.dmKind === 'group'
        ? 'group direct message'
        : 'direct message'
      : 'channel';
  const lists = tree
    .descendants(panes[0])
    .filter((node) => conversationListMatches(node, target.name, kind));
  requireState(lists.length === 1, 'Expected one message list matching the verified conversation');
  const messages = [],
    seen = new Set();
  let day = null,
    skipped = 0,
    sender = null,
    previousTimestamp = null;
  for (const item of tree.children(lists[0])) {
    const descendants = tree.descendants(item);
    if (
      (target.kind === 'dm' &&
        (target.dmKind === 'group'
          ? verifiedGroupDMForeword(item, tree)
          : verifiedDMForeword(item, tree))) ||
      (target.kind === 'channel' && verifiedDMForeword(item, tree, 'channel'))
    ) {
      sender = null;
      previousTimestamp = null;
      continue;
    }
    if (descendants.some((node) => hasClass(node, 'c-message_list__day_divider__label'))) {
      day = text(
        descendants.find((node) => hasClass(node, 'c-message_list__day_divider__label__pill'))
      );
      sender = null;
      previousTimestamp = null;
      continue;
    }
    if (!/^message-list_\d+\.\d+$/.test(item.id ?? '')) {
      if (descendants.some((node) => hasClass(node, 'c-message_kit__hover'))) skipped++;
      sender = null;
      previousTimestamp = null;
      continue;
    }
    requireState(!seen.has(item.id), 'Duplicate message identity in the exposed list');
    seen.add(item.id);
    const timestamp = BigInt(item.id.slice('message-list_'.length).replace('.', ''));
    if (previousTimestamp !== null && timestamp <= previousTimestamp) sender = null;
    const message = messageRecord(item, tree, conversationId, day);
    sender = inferGroupedSender(message, descendants, tree, sender);
    previousTimestamp = timestamp;
    messages.push(message);
  }
  return { messages, skipped, listLabel: text(lists[0]) };
}

function threadPermalink(value) {
  const url = parsedURL(value);
  const match = url?.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/);
  requireState(
    url?.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) &&
      match,
    'Invalid thread message permalink'
  );
  const roots = url.searchParams.getAll('thread_ts'),
    channels = url.searchParams.getAll('cid');
  requireState(roots.length <= 1 && channels.length <= 1, 'Ambiguous thread permalink parameters');
  requireState(!roots.length || /^\d{10}\.\d{6}$/.test(roots[0]), 'Invalid thread root timestamp');
  requireState(
    !channels.length || channels[0] === match[1],
    'Thread permalink channel parameter conflicts with its path'
  );
  return {
    host: url.hostname,
    conversationId: match[1],
    messageTS: `${match[2]}.${match[3]}`,
    rootTS: roots[0] ?? null,
  };
}

function messageThreadRef(permalink, replyCount) {
  try {
    const link = threadPermalink(permalink);
    return replyCount > 0 ? `${link.conversationId}:${link.messageTS}` : null;
  } catch {
    return null;
  }
}

function threadRequest(value, target) {
  const reference = value.match(/^([CDG][A-Z0-9]+):(\d{10}\.\d{6})$/);
  if (!reference) return threadPermalink(value);
  const host = optionalString(target.requestedHost);
  requireState(
    host && /^(?:[a-z0-9-]+\.)*slack\.com$/.test(host),
    'Verified native workspace host is required for a compact thread reference'
  );
  return { host, conversationId: reference[1], messageTS: reference[2], rootTS: null };
}

function threadRowIdentity(node) {
  return node.id?.match(/^([CDG][A-Z0-9]+)-(\d{10}\.\d{6})-thread-list-Thread_(\d{10}\.\d{6})$/);
}

function threadMessages(tree, target, query) {
  requireState(
    target?.kind === 'thread' &&
      /^\d{10}\.\d{6}$/.test(target.rootTS ?? '') &&
      /^\d{10}\.\d{6}$/.test(target.requestedMessageTS ?? ''),
    'Verified native thread metadata is required'
  );
  requireState(target.url === tree.root.url, 'Verified thread view changed before extraction');
  requireState(
    optionalString(query) && query === target.requestedURL,
    'Requested thread reference changed before extraction'
  );
  const requested = threadRequest(query, target);
  requireState(
    requested.conversationId === target.conversationId &&
      requested.messageTS === target.requestedMessageTS &&
      (requested.rootTS === null || requested.rootTS === target.rootTS),
    'Requested thread identity conflicts with verified metadata'
  );
  requireState(
    !tree.nodes.some((node) => node.role === 'AXComboBox' && text(node) === 'Query'),
    'Search overlay appeared during thread capture'
  );
  const panes = tree.nodes.filter((node) => hasClass(node, 'p-threads_flexpane'));
  requireState(panes.length === 1, 'Expected one exposed thread pane');
  const pane = panes[0];
  const scope = tree.ancestor(pane, (node) => hasClass(node, 'p-view_contents'));
  requireState(scope, 'Thread view container is unavailable');
  const headers = tree
    .descendants(scope)
    .filter(
      (node) => node.role === 'AXLink' && hasClass(node, 'p-threads_flexpane__header_permalink')
    );
  requireState(headers.length <= 1, 'Thread root header permalink is ambiguous');
  const verifiedRootLink = (value) => {
    const link = threadPermalink(value);
    requireState(
      link.host === requested.host &&
        link.conversationId === requested.conversationId &&
        link.messageTS === target.rootTS &&
        (link.rootTS === null || link.rootTS === target.rootTS),
      'Thread root permalink belongs to a different root or workspace'
    );
    return value;
  };
  // A conflicting header is an error even when another root link is available.
  let rootPermalink = headers.length ? verifiedRootLink(headers[0].url) : null;
  const listCandidates = tree
    .children(pane)
    .flatMap((node) => (hasClass(node, 'c-scrollbar__hider') ? tree.children(node) : [node]));
  const lists = listCandidates.filter(
    (node) =>
      node.role === 'AXList' &&
      hasClass(node, 'c-virtual_list__scroll_container') &&
      (text(node)?.startsWith('Thread in ') || text(node)?.startsWith('Thread with '))
  );
  requireState(lists.length === 1, 'Expected one thread message list');
  const list = lists[0],
    messages = [],
    seen = new Set();
  const listLabel = text(list);
  requireState(
    !listLabel.startsWith('Thread with ') ||
      (headers.length === 1 &&
        requested.conversationId.match(/^D[A-Z0-9]+$/)?.[0] === requested.conversationId &&
        /^Thread with .+ \(direct message(?:,|\))/.test(listLabel)),
    'Individual DM thread caption requires its verified direct-message header'
  );
  const listIdentity = listLabel.match(
    /^Thread (?:in|with) (.+) \((?:private |public )?(channel|direct message|group direct message)(?:,|\))/
  );
  const linkFromRows = (rows) => {
    requireState(rows.length <= 1, 'Thread root row is ambiguous');
    if (!rows.length) return null;
    const timestamps = tree
      .descendants(rows[0])
      .filter((node) => node.role === 'AXLink' && hasClass(node, 'c-timestamp'));
    requireState(timestamps.length <= 1, 'Thread root timestamp is ambiguous');
    return optionalString(timestamps[0]?.url) ? verifiedRootLink(timestamps[0].url) : null;
  };
  if (!rootPermalink) {
    rootPermalink = linkFromRows(
      tree.children(list).filter((node) => threadRowIdentity(node)?.[3] === target.rootTS)
    );
  }
  const currentURL = parsedURL(tree.root.url);
  const currentTitle = currentURL.pathname.endsWith(`/${target.conversationId}`)
    ? text(tree.root)?.match(/^(.*?) \((Channel|DM)\) - /)
    : null;
  const currentGroupDM =
    currentTitle?.[2] === 'DM' && /^[CG][A-Z0-9]+$/.test(target.conversationId);
  let currentTitleName = currentTitle?.[1] ?? null;
  let rootAnchorFromMain = false;
  if (currentTitle && (!rootPermalink || hasTitleMarker(currentTitleName))) {
    const mainPanes = mainConversationPanes(tree);
    requireState(mainPanes.length <= 1, 'Main conversation pane is ambiguous');
    const kind =
      currentTitle[2] === 'DM'
        ? currentGroupDM
          ? 'group direct message'
          : 'direct message'
        : 'channel';
    const names = hasTitleMarker(currentTitleName)
      ? [currentTitleName, currentTitleName.slice(2)].filter(Boolean)
      : [currentTitleName];
    let mainLists = [];
    if (mainPanes.length) {
      mainLists = tree
        .descendants(mainPanes[0])
        .filter((node) => names.some((name) => conversationListMatches(node, name, kind)));
      requireState(mainLists.length <= 1, 'Main conversation message list is ambiguous');
    }
    const corroborated = names.filter(
      (name) =>
        mainLists.some((node) => conversationListMatches(node, name, kind)) ||
        listLabel === `Thread in ${name}` ||
        (listIdentity?.[1] === name && listIdentity[2] === kind)
    );
    requireState(corroborated.length <= 1, 'Conversation title matches conflicting thread names');
    if (hasTitleMarker(currentTitleName)) currentTitleName = corroborated[0] ?? null;
    if (!rootPermalink && mainLists.length) {
      rootPermalink = linkFromRows(
        tree.children(mainLists[0]).filter((node) => node.id === `message-list_${target.rootTS}`)
      );
      rootAnchorFromMain = rootPermalink !== null;
    }
  }
  requireState(rootPermalink, 'Observed thread root permalink is unavailable');
  let day = null,
    sender = null,
    previousTS = null;
  for (const item of tree.children(list)) {
    const descendants = tree.descendants(item);
    if (descendants.some((node) => hasClass(node, 'c-message_list__day_divider__label'))) {
      day = text(
        descendants.find((node) => hasClass(node, 'c-message_list__day_divider__label__pill'))
      );
      sender = null;
      previousTS = null;
      continue;
    }
    const identity = threadRowIdentity(item);
    if (!identity) {
      requireState(
        !descendants.some((node) => hasClass(node, 'c-message_kit__actions')),
        'Thread message row has an unsupported identity'
      );
      sender = null;
      previousTS = null;
      continue;
    }
    const namespaceMatches = identity[1] === target.conversationId && identity[2] === target.rootTS;
    const messageTS = identity[3];
    requireState(!seen.has(messageTS), 'Duplicate message identity in the exposed thread');
    seen.add(messageTS);
    const orderKey = BigInt(messageTS.replace('.', ''));
    if (previousTS !== null && orderKey <= previousTS) sender = null;
    previousTS = orderKey;
    const timestamps = descendants.filter((node) => hasClass(node, 'c-timestamp'));
    requireState(timestamps.length <= 1, 'Thread message timestamp is ambiguous');
    if (optionalString(timestamps[0]?.url)) {
      const link = threadPermalink(timestamps[0].url);
      requireState(
        link.host === requested.host &&
          link.conversationId === target.conversationId &&
          link.messageTS === messageTS &&
          (link.rootTS === null || link.rootTS === target.rootTS),
        'Thread message permalink disagrees with its row or root'
      );
      // Slack can retain an old list namespace when switching threads. Only a
      // permalink explicitly tying this message to the current root repairs it.
      requireState(
        (namespaceMatches && !rootAnchorFromMain) ||
          messageTS === target.rootTS ||
          link.rootTS === target.rootTS,
        'Thread reply lacks explicit permalink root proof'
      );
    } else {
      requireState(
        namespaceMatches && (!rootAnchorFromMain || messageTS === target.rootTS),
        'Thread row lacks a verifying permalink'
      );
    }
    const record = messageRecord(item, tree, target.conversationId, day);
    sender = inferGroupedSender(record, descendants, tree, sender);
    messages.push({ timestamp: messageTS, record });
  }
  requireState(
    !rootAnchorFromMain || messages.length > 0,
    'Thread root relationship is not exposed'
  );
  requireState(
    target.requestedMessageTS === target.rootTS || seen.has(target.requestedMessageTS),
    'The requested message is not exposed in this thread'
  );
  const root = messages.find((message) => message.timestamp === target.rootTS)?.record ?? null;
  const replies = messages
    .filter((message) => message.timestamp !== target.rootTS)
    .map((message) => message.record);
  const separators = tree
    .descendants(list)
    .filter((node) => hasClass(node, 'p-threads_flexpane__separator'));
  const countLabels = separators
    .flatMap((node) =>
      tree
        .descendants(node)
        .filter((child) => child.role === 'AXStaticText')
        .map(text)
    )
    .map((label) => label?.match(/^(\d+) repl(?:y|ies)$/)?.[1])
    .filter((value) => value !== undefined);
  const listCount = text(list)?.match(/(?:\(|,\s*)(\d+) repl(?:y|ies)(?=,|\))/)?.[1];
  if (listCount !== undefined) countLabels.push(listCount);
  const counts = [...new Set(countLabels.map(Number))];
  requireState(
    counts.length <= 1 && counts.every(Number.isSafeInteger),
    'Thread reply count changed during capture'
  );
  const displayedReplyCount = counts[0] ?? null;
  requireState(
    displayedReplyCount === null || replies.length <= displayedReplyCount,
    'More thread replies captured than the displayed count'
  );
  requireState(
    replies.length > 0 || displayedReplyCount === 0,
    'Thread replies are not exposed; loading or coverage remains unknown'
  );
  const rootRef = messageThreadRef(rootPermalink, displayedReplyCount ?? replies.length);
  if (root)
    root.thread = {
      ...root.thread,
      replyCount: displayedReplyCount,
      repliesRead: replies.length > 0,
      ref: rootRef,
      navigation: threadNavigation(rootRef),
    };
  const titleFallback = !headers.length ? currentTitle : null;
  const name = text(headers[0]) ?? listIdentity?.[1] ?? (titleFallback ? currentTitleName : null);
  const kind = listIdentity
    ? listIdentity[2] === 'channel'
      ? 'channel'
      : 'dm'
    : titleFallback
      ? titleFallback[2] === 'Channel'
        ? 'channel'
        : 'dm'
      : null;
  const ref = `${target.conversationId}:${target.rootTS}`;
  const channelAction = kind === 'channel' ? channelNavigation(name) : null;
  return {
    conversation: {
      id: target.conversationId,
      name,
      kind,
      ...(listIdentity?.[2] === 'group direct message' || (rootAnchorFromMain && currentGroupDM)
        ? { dmKind: 'group' }
        : {}),
      url: currentURL.pathname.endsWith(`/${target.conversationId}`) ? tree.root.url : null,
      handle: null,
    },
    thread: {
      ref,
      requestedMessageTS: target.requestedMessageTS,
      rootTS: target.rootTS,
      rootPermalink,
      displayedReplyCount,
      observedReplyCount: replies.length,
      root,
      replies,
    },
    navigation: [threadNavigation(ref), ...(channelAction ? [channelAction] : [])],
    listLabel,
  };
}

export function structuredOutput(receipt, operation, query = null, options = {}) {
  requireState(
    options.dmSearch === undefined || operation === 'dms',
    'Native DMs search request requires the dms operation'
  );
  requireState(
    ['channels', 'dms', 'read-channel', 'read-dm', 'read-thread'].includes(operation),
    'Unsupported structured-output operation'
  );
  const content = receipt?.content;
  const tree = indexTree(Array.isArray(content) ? content : content?.nodes);
  const root = tree.root;
  const url = parsedURL(root.url);
  requireState(
    root.role === 'AXWebArea' && url?.protocol === 'https:' && url.hostname === 'app.slack.com',
    'Expected a Slack workspace web area'
  );
  const after = narrowIdentity(receipt.after, root);
  requireState(
    after.url === root.url && after.title === text(root),
    'Conversation changed between verification and extraction'
  );
  const target = receipt.target ?? null;
  const result = {
    schemaVersion: 1,
    operation,
    requested: operation === 'dms' ? null : optionalString(query),
    observedAt: optionalString(content?.observedAt) ?? optionalString(receipt.observedAt),
    workspace: workspaceIdentity(tree, operation === 'read-thread' ? null : target),
    before: narrowIdentity(receipt.before),
    after,
    desktop: receipt.desktop ?? null,
    pagination: { supported: false, hasMore: null, nextCursor: null },
    coverage: {
      scope:
        operation === 'channels'
          ? 'currently exposed sidebar channels'
          : operation === 'dms'
            ? 'currently exposed sidebar DMs'
            : 'currently exposed main conversation messages',
      complete: false,
      virtualized: true,
      threadRepliesIncluded: false,
      reason:
        'Slack virtualizes its sidebar and history. No scrolling or pagination was performed, so exposed nodes cannot establish whether more remain.',
      captureTruncated: typeof content?.truncated === 'boolean' ? content.truncated : null,
      warnings: [],
    },
  };
  if (operation === 'channels') {
    const { channels, skipped } = sidebarChannels(tree);
    result.channels = channels;
    result.coverage.observedCount = channels.length;
    if (skipped)
      result.coverage.warnings.push(
        `${skipped} sidebar rows lacked an unambiguous channel structure and were omitted`
      );
    return result;
  }
  if (operation === 'dms') {
    const hub = receipt.dmPagination?.scope?.source;
    requireState(
      hub === 'dms-view' || (hub === undefined && url?.pathname.split('/').at(-1) !== 'dms'),
      'DMs view source metadata is missing or unsupported'
    );
    const observation = hub === 'dms-view' ? hubObservation(receipt) : sidebarDMs(tree);
    if (options.dmSearch !== undefined)
      verifyDMSearchRequest(receipt, options.dmSearch, observation.scope ?? null);
    const { dms, skipped } = observation;
    if (hub === 'dms-view') {
      const page = receipt.dmPagination;
      requireState(
        sameHubScope(page.scope, observation.scope) &&
          JSON.stringify(page.afterRowKeys) === JSON.stringify(observation.rowKeys) &&
          JSON.stringify(page.dmIds) === JSON.stringify(dms.map((dm) => dm.id)),
        'DMs view rows, identities or scope differ from the native capture'
      );
      Object.assign(result.coverage, {
        source: 'dms-view',
        filters: {
          query: observation.scope.searchQuery ?? observation.scope.filterValue.trim(),
          unreadOnly: observation.scope.unreadOnly,
        },
        scope: 'currently exposed DMs view conversations',
        reason:
          'Slack virtualizes the DMs view. This capture preserves the current filters and position; unexposed conversations and the full workspace directory remain unknown.',
      });
      if (options.dmSearch !== undefined)
        result.coverage.search = {
          source: 'slack-dms-view',
          requestedQuery: options.dmSearch,
          verified: true,
        };
    }
    result.dms = dms;
    result.coverage.observedCount = dms.length;
    result.coverage.warnings.push(
      `DM names and group labels are ${hub === 'dms-view' ? 'DMs view' : 'sidebar'} observations; messages, handles and complete membership were not read.`
    );
    if (skipped)
      result.coverage.warnings.push(
        `${skipped} ${hub === 'dms-view' ? 'DMs view' : 'sidebar'} rows lacked an unambiguous DM structure and were omitted`
      );
    return result;
  }
  if (operation === 'read-thread') {
    const extracted = threadMessages(tree, target, query);
    result.conversation = extracted.conversation;
    result.thread = extracted.thread;
    result.navigation = extracted.navigation;
    Object.assign(result.coverage, {
      scope: 'currently exposed root message and thread replies',
      threadRepliesIncluded: true,
      observedCount: extracted.thread.replies.length + (extracted.thread.root ? 1 : 0),
      listLabel: extracted.listLabel,
      reason:
        'Slack virtualizes thread replies. No scrolling or pagination was performed; displayed counts do not prove completeness.',
      textFormat:
        'Accessibility text in child order; paragraph layout may differ from the visual message',
    });
    if (
      extracted.thread.displayedReplyCount !== null &&
      extracted.thread.replies.length < extracted.thread.displayedReplyCount
    ) {
      result.coverage.warnings.push(
        `${extracted.thread.replies.length} of ${extracted.thread.displayedReplyCount} displayed thread replies are exposed`
      );
    }
    if (!extracted.thread.root) result.coverage.warnings.push('Root message is outside this view.');
    result.coverage.warnings.push(
      'Unexposed replies and attachment contents were not read; missing metadata remains null'
    );
    return result;
  }
  const kind = operation === 'read-dm' ? 'dm' : 'channel';
  const isGroupDM = kind === 'dm' && target?.dmKind === 'group';
  requireState(
    target?.kind === kind && optionalString(target.name),
    'Verified native conversation metadata is required'
  );
  requireState(
    conversationTitlePrefix(text(root), target.name, kind),
    'Conversation title does not match the verified target'
  );
  requireState(
    !target.url || target.url === root.url,
    'Verified target URL changed before extraction'
  );
  const conversationId = url.pathname.split('/').filter(Boolean).at(-1);
  requireState(
    kind === 'dm' && !isGroupDM
      ? /^D[A-Z0-9]+$/.test(conversationId)
      : /^[CG][A-Z0-9]+$/.test(conversationId),
    'Conversation URL does not match the verified kind'
  );
  if (isGroupDM)
    requireState(
      conversationId.match(/^[CG][A-Z0-9]+$/)?.[0] === conversationId &&
        target.conversationId === conversationId &&
        target.requested === `group:${conversationId}` &&
        (query === target.requested ||
          (query === target.requestedLookup && query === `group-name:${target.name}`)) &&
        !target.handle,
      'Group DM reference does not match the verified conversation identity'
    );
  const extracted = conversationMessages(tree, target, conversationId);
  if (target.lookup !== undefined) {
    requireState(
      operation === 'read-dm' &&
        !isGroupDM &&
        target.lookup?.source === 'dms-search-autocomplete' &&
        target.lookup.query === query &&
        target.requested === query &&
        target.lookup.conversationId === conversationId &&
        target.lookup.exactMatchCount === 1 &&
        (query?.startsWith('@') ? target.handle === query : target.name === query),
      'Direct DM fallback does not match the requested person and conversation'
    );
    result.lookup = { ...target.lookup };
  }
  result.conversation = {
    kind,
    ...(isGroupDM ? { dmKind: 'group' } : {}),
    name: target.name,
    id: conversationId,
    url: root.url,
    handle: optionalString(target.handle),
  };
  result.messages = extracted.messages;
  result.coverage.observedCount = extracted.messages.length;
  result.coverage.listLabel = extracted.listLabel;
  result.coverage.textFormat =
    'Accessibility text in child order; paragraph layout may differ from the visual message';
  if (extracted.skipped)
    result.coverage.warnings.push(
      `${extracted.skipped} unrecognized message containers were omitted`
    );
  result.coverage.warnings.push(
    'Unexposed history, thread replies and attachment contents were not read; missing metadata remains null'
  );
  return result;
}

function trimmedStructured(receipt, operation, query, options) {
  const { before, after, desktop, ...result } = structuredOutput(
    receipt,
    operation,
    query,
    options
  );
  return { ...result, view: after };
}

function searchSummary(tree, receipt, operation, query) {
  const lists = tree.nodes.filter(
    (node) => node.role === 'AXList' && text(node)?.startsWith('Message results,')
  );
  requireState(lists.length <= 1, 'Search result lists are ambiguous');
  const searchButtons = tree.nodes.filter(
    (node) => node.role === 'AXButton' && text(node)?.startsWith('Search: ')
  );
  requireState(searchButtons.length === 1, 'Submitted search query is unavailable');
  const observedQuery = text(searchButtons[0]).slice('Search: '.length);
  if (operation === 'search')
    requireState(
      canonicalChannelSearch(observedQuery) === canonicalChannelSearch(query),
      'Search query changed during capture'
    );
  let messages = [],
    totalResults = null,
    page = null,
    pageCount = null;
  if (lists.length) {
    const list = lists[0];
    const match = text(list)?.match(/^Message results, page (\d+) of (\d+)$/);
    if (match) {
      page = Number(match[1]);
      pageCount = Number(match[2]);
    }
    const counts = tree.nodes.filter(
      (node) =>
        node.role === 'AXStaticText' &&
        /^[\d,]+ results?$/.test(text(node) ?? '') &&
        !tree.ancestor(node, (parent) => parent.index === list.index)
    );
    if (counts.length === 1)
      totalResults = Number(
        text(counts[0])
          .match(/^[\d,]+/)[0]
          .replaceAll(',', '')
      );
    const highlight = searchHighlight(observedQuery);
    messages = tree.children(list).map((item) => {
      const record = messageRecord(item, tree, null, null, true, highlight);
      const headers = tree
        .descendants(item)
        .filter((node) => hasClass(node, 'c-search_message__content_header'));
      const channelLabels =
        headers.length === 1
          ? tree
              .descendants(headers[0])
              .filter(
                (node) =>
                  node.role === 'AXStaticText' &&
                  !tree.ancestor(
                    node,
                    (parent) =>
                      hasClass(parent, 'c-timestamp') ||
                      hasClass(parent, 'c-message__sender_button')
                  )
              )
          : [];
      return {
        ...record,
        channel: channelLabels.length === 1 ? text(channelLabels[0]) : null,
        snippet: true,
      };
    });
  } else {
    const empty = tree.nodes.filter((node) => hasClass(node, 'c-empty_state'));
    const labels =
      empty.length === 1
        ? tree
            .descendants(empty[0])
            .filter((node) => node.role === 'AXStaticText')
            .map(text)
        : [];
    requireState(
      labels.includes('Nothing turned up') &&
        [
          'You may want to try using different keywords, checking for typos, or adjusting filters.',
          'You may want to try using different keywords, checking for typos or adjusting filters.',
        ].some((guidance) => labels.includes(guidance)),
      'Search results are not exposed'
    );
    totalResults = 0;
  }
  return {
    schemaVersion: 1,
    operation,
    requested: query,
    observedAt: receipt.content.observedAt,
    workspace: workspaceIdentity(tree, null),
    view: narrowIdentity(null, tree.root),
    search: { query: observedQuery, totalResults, page, pageCount },
    messages,
    coverage: {
      scope: 'exposed search snippets',
      complete: false,
      observedCount: messages.length,
      warnings: ['Search results are snippets; full messages and thread replies were not read.'],
    },
    pagination: {
      supported: false,
      hasMore: page !== null && pageCount !== null ? page < pageCount : null,
      nextCursor: null,
    },
  };
}

// All public commands share semantic output. Raw trees and diagnostic samples
// stay in the private receipt, emitted only by --format=full-json.
export function mediaObservationOutput(observation) {
  const tree = indexTree(observation?.content?.nodes);
  const root = tree.root;
  const url = parsedURL(root.url);
  requireState(
    root.role === 'AXWebArea' &&
      url?.protocol === 'https:' &&
      url.hostname === 'app.slack.com' &&
      observation.content.truncated === false &&
      observation.before?.url === root.url &&
      observation.after?.url === root.url &&
      observation.before?.title === text(root) &&
      observation.after?.title === text(root),
    'Media source view changed or was incompletely captured; reread the source'
  );
  requireState(
    !tree.nodes.some((node) => node.role === 'AXComboBox' && text(node) === 'Query'),
    'Close the Search picker before reading media'
  );
  const inspected = compactOutput(
    {
      ...observation,
      after: { nodes: [{ role: 'AXWebArea', label: text(root), url: root.url }] },
    },
    'inspect'
  );
  const messages = [...(inspected.messages ?? [])];
  const panes = tree.nodes.filter((node) => hasClass(node, 'p-threads_flexpane'));
  requireState(
    panes.length === (observation.threadTarget ? 1 : 0),
    'Exposed thread has no verified source identity; reread its source'
  );
  if (observation.threadTarget) {
    const thread = structuredOutput(
      {
        ...observation,
        target: observation.threadTarget,
      },
      'read-thread',
      observation.threadTarget.requestedURL
    ).thread;
    if (thread.root) messages.push(thread.root);
    messages.push(...thread.replies);
  }
  return {
    workspace: workspaceIdentity(tree, null),
    view: narrowIdentity(null, root),
    observedAt: observation.content.observedAt,
    messages,
  };
}

export function compactOutput(receipt, operation, query = null, options = {}) {
  requireState(
    options.dmSearch === undefined || operation === 'dms',
    'Native DMs search request requires the dms operation'
  );
  if (operation === 'permissions' || receipt.status === 'permission-required') {
    const {
      executable,
      permissionScope,
      accessibilityTrusted,
      accessibilityProbe,
      postEventAccess,
      promptRequested,
      settingsOpenRequested,
      next,
      note,
      error,
    } = receipt;
    let status = receipt.status;
    const accessVerified =
      accessibilityProbe === undefined || accessibilityProbe?.status === 'accessible';
    // A trust flag is not proof that Slack accepts AX messages. Failed live
    // probes outrank optimistic readiness and keyboard-only setup advice.
    if (!accessVerified && ['ready', 'inspection-only'].includes(status))
      status =
        accessibilityProbe?.status === 'api-disabled' ? 'permission-required' : 'unavailable';
    const inspectionOnly =
      status === 'ready' &&
      !error &&
      accessVerified &&
      accessibilityTrusted === true &&
      postEventAccess === false;
    return {
      operation: 'permissions',
      status: inspectionOnly ? 'inspection-only' : status,
      ...(permissionScope !== undefined ? { permissionScope } : {}),
      accessibilityTrusted,
      ...(accessibilityProbe !== undefined ? { accessibilityProbe } : {}),
      postEventAccess,
      promptRequested,
      settingsOpenRequested,
      executable,
      next: inspectionOnly
        ? 'Inspection is available, but keyboard navigation is not in this execution context. First verify the approved execution context through the runner’s normal approval mechanism, then rerun read-only permissions there. Stop if execution approval is denied. Check the host’s Accessibility/input access in System Settings only if access remains unavailable in that approved context. Do not replay an earlier action automatically.'
        : next,
      note,
      ...(error !== undefined ? { error } : {}),
    };
  }
  if (
    receipt.status === 'ambiguous' ||
    receipt.status === 'not-found' ||
    (receipt.status === 'stopped' && Array.isArray(receipt.candidates))
  ) {
    return {
      status: receipt.status,
      operation,
      error: receipt.error,
      next: receipt.next,
      query: receipt.query,
      candidates: receipt.candidates,
      candidateCount: receipt.candidateCount,
      ...(receipt.exactMatchCount !== undefined
        ? { exactMatchCount: receipt.exactMatchCount }
        : {}),
      candidatesTruncated: receipt.candidatesTruncated,
    };
  }
  if (receipt.status === 'stopped' || receipt.error) {
    return {
      status: 'stopped',
      operation,
      error: receipt.error,
      next: receipt.next,
      ...(operation === 'read-transcript' &&
      (typeof receipt.openingMayHaveBeenRequested === 'boolean' ||
        receipt.openingMayHaveBeenRequested === null)
        ? { openingMayHaveBeenRequested: receipt.openingMayHaveBeenRequested }
        : {}),
      ...(receipt.accessStatus !== undefined ? { accessStatus: receipt.accessStatus } : {}),
      ...(receipt.accessibilityProbe !== undefined
        ? { accessibilityProbe: receipt.accessibilityProbe }
        : {}),
    };
  }
  if (['channels', 'dms', 'read-channel', 'read-dm', 'read-thread'].includes(operation))
    return trimmedStructured(receipt, operation, query, options);
  if (!receipt.content) {
    requireState(
      operation === 'inspect',
      'The final view could not be captured; inspect before retrying'
    );
    const views = (receipt.after?.nodes ?? []).filter((node) => node.role === 'AXWebArea');
    return {
      schemaVersion: 1,
      operation,
      view: views.length === 1 ? narrowIdentity(null, views[0]) : null,
      coverage: {
        scope: 'window summary',
        complete: false,
        warnings: [
          'No unique main workspace surface; use --format=full-json for the complete inspection receipt.',
        ],
      },
    };
  }
  const tree = indexTree(receipt.content.nodes),
    root = tree.root;
  const observed = (receipt.after?.nodes ?? []).filter(
    (node) => node.role === 'AXWebArea' && node.url === root.url && node.label === root.label
  );
  requireState(observed.length === 1, 'View changed during capture');
  const fields = tree.nodes.filter((node) => node.role === 'AXComboBox' && node.label === 'Query');
  if (fields.length) {
    requireState(
      operation === 'inspect',
      'Search overlay reopened during capture; submission is no longer verified'
    );
    requireState(fields.length === 1, 'Query fields are ambiguous');
    const suggestions = tree.nodes.filter(
      (node) =>
        node.role === 'AXStaticText' && node.id?.startsWith('c-search_autocomplete__suggestion_')
    );
    return {
      schemaVersion: 1,
      operation,
      view: narrowIdentity(null, root),
      query: {
        value: fields[0].AXValue || null,
        suggestions: suggestions.map((node) => ({
          label: node.label,
          handle: text(
            tree
              .descendants(node)
              .find((child) => child.role === 'AXStaticText' && text(child)?.startsWith('@'))
          ),
        })),
      },
      coverage: { scope: 'open search suggestions', complete: false },
    };
  }
  if (operation === 'search')
    requireState(
      parsedURL(root.url)?.pathname.endsWith('/search'),
      'Search view changed during capture'
    );
  if (operation === 'channel')
    requireState(
      receipt.target?.kind === 'channel' &&
        receipt.target.url === root.url &&
        conversationTitlePrefix(text(root), receipt.target.name, 'channel'),
      'Channel view changed during capture'
    );
  if (parsedURL(root.url)?.pathname.endsWith('/search'))
    return searchSummary(tree, receipt, operation, query);
  const nameAndKind = text(root)?.match(/^(.*?) \((Channel|DM)\) - /);
  if (nameAndKind) {
    const conversationId = parsedURL(root.url)?.pathname.split('/').filter(Boolean).at(-1);
    const groupDM =
      nameAndKind[2] === 'DM' &&
      typeof conversationId === 'string' &&
      conversationId.match(/^[CG][A-Z0-9]+$/)?.[0] === conversationId;
    const target = receipt.target ?? {
      name: corroboratedTitleName(
        tree,
        nameAndKind[1],
        groupDM ? 'group direct message' : nameAndKind[2] === 'DM' ? 'direct message' : 'channel'
      ),
      kind: nameAndKind[2] === 'DM' ? 'dm' : 'channel',
      url: root.url,
      ...(groupDM ? { dmKind: 'group', conversationId, requested: `group:${conversationId}` } : {}),
    };
    const adapted = { ...receipt, target, after: narrowIdentity(null, root) };
    const result = trimmedStructured(
      adapted,
      target.kind === 'dm' ? 'read-dm' : 'read-channel',
      target.dmKind === 'group' ? `group:${conversationId}` : query
    );
    return { ...result, operation, requested: optionalString(query) };
  }
  requireState(operation === 'inspect', 'Destination changed during capture');
  return {
    schemaVersion: 1,
    operation,
    view: narrowIdentity(null, root),
    workspace: workspaceIdentity(tree, null),
    coverage: {
      scope: 'current view summary',
      complete: false,
      warnings: [
        'This view has no supported message list. Use --format=full-json for diagnostics.',
      ],
    },
  };
}
