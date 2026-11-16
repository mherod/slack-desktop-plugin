import { describe, expect, test } from 'bun:test';
import { collectChannelPages, collectDMPages } from './slack-channel-pages.mjs';
import { compactOutput } from './slack-output.mjs';

// Synthetic sidebar receipts only. Native evidence is supplied separately from
// the raw tree so mutations exercise the independent semantic cross-checks.
const channel = (id, name = id.toLowerCase(), extra = {}) => ({ id, name, ...extra });
const section = (id, children, extra = {}) => ({
  id: `sectionHeading-${id}`,
  label: id,
  expanded: true,
  children,
  ...extra,
});
const defaultEntries = () => [section('Channels', [channel('C3'), channel('C1')])];

function frame({
  operation = 'channels',
  entries = defaultEntries(),
  context = 'EDEMO',
  workspace = 'Test Workspace',
  title = `example (Channel) - ${workspace} - Slack`,
  view = 'CEXAMPLE',
  filterValue = '',
  previous = null,
  status,
  directOutline = false,
} = {}) {
  const nodes = [];
  const add = (parent, role = 'AXGroup', classes = [], label = '', extra = {}) => {
    const index = nodes.length;
    nodes.push({ index, parent, role, classes, label, id: '', ...extra });
    return index;
  };
  const root = add(null, 'AXWebArea', [], title, {
    url: `https://app.slack.com/client/${context}/${view}`,
  });
  const wrapper = add(root, 'AXGroup', ['p-client_workspace_wrapper'], workspace);
  const home = add(wrapper, 'AXGroup', ['p-view_contents', 'p-view_contents--sidebar'], 'Home');
  const filter = add(home, 'AXTextField', ['c-filter_input__input'], 'Channel or user name', {
    AXValue: filterValue,
    stateValue: filterValue,
  });
  const sidebar = add(home, 'AXGroup', ['p-channel_sidebar']);
  const hider = directOutline ? sidebar : add(sidebar, 'AXGroup', ['c-scrollbar__hider']);
  const outline = add(
    hider,
    'AXOutline',
    ['c-virtual_list__scroll_container'],
    'Channels and direct messages'
  );
  const rowKeys = [],
    channelIds = [],
    dmIds = [],
    sections = [],
    rows = [],
    names = [];
  function addEntry(parent, entry, path = []) {
    const row = add(parent, 'AXRow', [], entry.label ?? '', {
      id: entry.id,
      expanded: entry.expanded ?? null,
    });
    rows.push(row);
    rowKeys.push(JSON.stringify([...path, entry.id]));
    if (entry.id.startsWith('sectionHeading-')) {
      sections.push({ id: entry.id, label: entry.label, expanded: entry.expanded ?? null });
      const group = add(row);
      for (const child of entry.children) addEntry(group, child, [...path, entry.id]);
    } else if (entry.name !== undefined) {
      const modifiers = [...(entry.modifiers ?? [])];
      if (entry.kind === 'group-dm') modifiers.push('p-channel_sidebar__channel--mpim');
      if (entry.kind === 'dm') modifiers.push('p-channel_sidebar__channel--im');
      if (entry.kind === 'self') modifiers.push('p-channel_sidebar__channel--im-you');
      const group = add(row, 'AXGroup', ['p-channel_sidebar__channel', ...modifiers]);
      if (entry.avatar) add(group, 'AXGroup', ['p-channel_sidebar__user_avatar']);
      for (const token of entry.tokens ?? [entry.name])
        names.push(add(group, 'AXStaticText', [], token));
      if (entry.url) add(group, 'AXLink', [], 'Observed channel link', { url: entry.url });
      if (
        /^[CG][A-Z0-9]+$/.test(entry.id) &&
        !entry.kind &&
        !entry.avatar &&
        !channelIds.includes(entry.id)
      )
        channelIds.push(entry.id);
      if (['dm', 'self', 'group-dm'].includes(entry.kind) && !dmIds.includes(entry.id))
        dmIds.push(entry.id);
    }
    return row;
  }
  for (const entry of entries) addEntry(outline, entry);
  sections.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const paginationKey = operation === 'dms' ? 'dmPagination' : 'channelPagination';
  const prior = previous?.receipt[paginationKey];
  const currentStatus =
    status ??
    (prior
      ? rowKeys.some((key) => !prior.afterRowKeys.includes(key))
        ? 'advanced'
        : 'no-progress'
      : 'initial');
  const receipt = {
    operation,
    pid: 123,
    content: { nodes, observedAt: '2026-01-01T12:00:00Z', truncated: false },
    after: { title, url: nodes[root].url },
    target: {},
    [paginationKey]: {
      status: currentStatus,
      scrollAttempts: prior ? 1 : 0,
      [operation === 'dms' ? 'dmIds' : 'channelIds']: operation === 'dms' ? dmIds : channelIds,
      beforeRowKeys: prior ? [...prior.afterRowKeys] : [...rowKeys],
      afterRowKeys: rowKeys,
      edgeKey: prior?.afterRowKeys.at(-1) ?? null,
      scope: { url: nodes[root].url, title, workspaceName: workspace, filterValue, sections },
    },
  };
  return { receipt, nodes, add, root, wrapper, home, filter, sidebar, hider, outline, rows, names };
}

function envelope(frames, overrides = {}, batchOverrides = {}) {
  const firstReceipt = frames[0]?.receipt ?? frames[0];
  const lastReceipt = frames.at(-1)?.receipt ?? frames.at(-1);
  const last = lastReceipt?.dmPagination ?? lastReceipt?.channelPagination;
  return {
    operation: firstReceipt?.operation,
    pid: 123,
    status: 'ok',
    pages: frames.map((item) => item.receipt ?? item),
    batch: {
      requestedPages: Math.max(2, frames.length),
      attemptedPages: frames.length,
      completedPages: frames.length,
      direction: 'down',
      stopReason: last?.status === 'no-progress' ? 'no-progress' : 'page-limit',
      ...batchOverrides,
    },
    ...overrides,
  };
}

const retainedPrefix = (input, count = 2) => {
  const result = collectChannelPages(input);
  expect(result.status).toBe('partial');
  expect(result.channels).toHaveLength(count);
  expect(result.pagination.batch.completedPages).toBe(1);
  expect(result.pagination.batch.stopReason).toBe('error');
  expect(result.pagination.hasMore).toBeNull();
  expect(result.pagination.nextCursor).toBeNull();
  expect(result.next).toContain('Inspect');
  return result;
};

describe('sidebar outline ancestry', () => {
  test('accepts the outline under a scrollbar hider or directly under the sidebar', () => {
    for (const directOutline of [false, true]) {
      const first = frame({ directOutline });
      const second = frame({
        directOutline,
        previous: first,
        entries: [section('Channels', [channel('C1'), channel('C4')])],
      });
      const result = collectChannelPages(envelope([first, second]));
      expect(result.channels.map((item) => item.id)).toEqual(['C3', 'C1', 'C4']);
    }
  });
});

describe('bounded sidebar channel collection', () => {
  test('deduplicates canonical IDs in sidebar order while preserving the first whole record', () => {
    const first = frame({
      entries: [section('Channels', [channel('C3', 'shared-name'), channel('C1', 'shared-name')])],
    });
    const second = frame({
      previous: first,
      entries: [
        section('Channels', [
          channel('C1', 'shared-name', {
            modifiers: ['p-channel_sidebar__channel--unread'],
            url: 'https://example.com/later',
          }),
          channel('G2', 'private-looking-id'),
        ]),
      ],
    });
    const third = frame({
      previous: second,
      entries: [section('Channels', [channel('G2', 'private-looking-id'), channel('C4')])],
    });
    const input = envelope([first, second, third]);
    const original = structuredClone(input);
    const result = collectChannelPages(input);
    expect(result.status).toBe('ok');
    expect(result.channels.map((item) => item.id)).toEqual(['C3', 'C1', 'G2', 'C4']);
    expect(result.channels[1]).toMatchObject({
      unread: null,
      selected: null,
      url: null,
      sections: ['Channels'],
    });
    expect(result.channels[2].isPrivate).toBeNull();
    expect(result.pagination).toMatchObject({
      supported: true,
      direction: 'down',
      status: 'advanced',
      hasMore: null,
      nextCursor: null,
      capturedCount: 6,
      returnedCount: 4,
      scrollAttempts: 2,
      batch: { completedPages: 3, deduplicatedCount: 2, stopReason: 'page-limit' },
    });
    expect(result.coverage).toMatchObject({ complete: false, observedCount: 4, capturedCount: 6 });
    expect(result.coverage.reason).toContain('current sidebar position');
    expect(input).toEqual(original);
  });

  test('continues through DM-only progress and counts those verified captures', () => {
    const first = frame({ entries: [section('Mixed', [channel('C1')])] });
    const second = frame({
      previous: first,
      entries: [section('Mixed', [channel('C1'), channel('D1', 'Sam', { kind: 'dm' })])],
    });
    const third = frame({
      previous: second,
      entries: [section('Mixed', [channel('D1', 'Sam', { kind: 'dm' }), channel('C2')])],
    });
    const result = collectChannelPages(envelope([first, second, third]));
    expect(result.status).toBe('ok');
    expect(result.channels.map((item) => item.id)).toEqual(['C1', 'C2']);
    expect(result.pagination.batch.completedPages).toBe(3);
    expect(result.pagination.capturedCount).toBe(3);
  });

  test('keeps duplicate section appearances distinct for row progress and excludes C-prefixed DMs', () => {
    const entries = [
      section('Favorite', [channel('C1', 'one')]),
      section('Channels', [
        channel('C1', 'one', { modifiers: ['p-channel_sidebar__channel--selected'] }),
        channel('C2', 'Alex, Sam', { kind: 'group-dm' }),
        channel('C3', 'Taylor', { avatar: true }),
        channel('D1', 'Sam'),
      ]),
    ];
    const first = frame({ entries }),
      second = frame({ previous: first, entries });
    const result = collectChannelPages(envelope([first, second], {}, { requestedPages: 5 }));
    expect(result.status).toBe('ok');
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).toMatchObject({
      id: 'C1',
      sections: ['Favorite', 'Channels'],
      selected: true,
    });
    expect(result.pagination).toMatchObject({
      capturedCount: 2,
      returnedCount: 1,
      batch: { stopReason: 'no-progress', completedPages: 2, deduplicatedCount: 1 },
    });
  });

  test('retains depth-first order for nested sections and accepts native sorted dictionary keys', () => {
    const entries = [section('Outer', [section('Nested', [channel('C2')]), channel('C1')])];
    const first = frame({ entries }),
      second = frame({ previous: first, entries });
    const sorted = (value) =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, sorted(value[key])])
            )
          : value;
    const input = sorted(envelope([first, second]));
    const result = collectChannelPages(input);
    expect(result.status).toBe('ok');
    expect(result.channels.map((item) => item.id)).toEqual(['C2', 'C1']);
    expect(first.receipt.channelPagination.afterRowKeys).toContain(
      JSON.stringify(['sectionHeading-Outer', 'sectionHeading-Nested', 'C2'])
    );
  });

  test('accepts sticky section headings while requiring shared rows to retain their order', () => {
    const first = frame({
      entries: [section('Channels', [channel('C1'), channel('C2'), channel('C3')])],
    });
    const second = frame({
      previous: first,
      entries: [section('Channels', [channel('C3'), channel('C4')])],
    });
    expect(collectChannelPages(envelope([first, second])).channels.map((item) => item.id)).toEqual([
      'C1',
      'C2',
      'C3',
      'C4',
    ]);
  });

  test('rejects stale before rows, lost edge, reordered overlap and newly exposed rows before the edge', () => {
    for (const mutation of ['before', 'edge', 'lost', 'order', 'new-before', 'status', 'scroll']) {
      const first = frame();
      const entries =
        mutation === 'lost'
          ? [section('Channels', [channel('C4')])]
          : mutation === 'order'
            ? [section('Channels', [channel('C1'), channel('C3'), channel('C4')])]
            : mutation === 'new-before'
              ? [section('Channels', [channel('C4'), channel('C1')])]
              : [section('Channels', [channel('C1'), channel('C4')])];
      const second = frame({ previous: first, entries });
      if (mutation === 'before') second.receipt.channelPagination.beforeRowKeys = [];
      if (mutation === 'edge')
        second.receipt.channelPagination.edgeKey = first.receipt.channelPagination.afterRowKeys[0];
      if (mutation === 'status') second.receipt.channelPagination.status = 'no-progress';
      if (mutation === 'scroll') second.receipt.channelPagination.scrollAttempts = 0;
      retainedPrefix(envelope([first, second]));
    }
  });

  test('an unchanged row capture stops no-progress and cannot supply another continuation', () => {
    const first = frame(),
      second = frame({ previous: first }),
      third = frame({
        previous: second,
        entries: [section('Channels', [channel('C1'), channel('C4')])],
      });
    const result = collectChannelPages(envelope([first, second], {}, { requestedPages: 8 }));
    expect(result.status).toBe('ok');
    expect(result.pagination).toMatchObject({
      status: 'no-progress',
      hasMore: null,
      batch: { completedPages: 2, deduplicatedCount: 2, stopReason: 'no-progress' },
    });
    const continued = collectChannelPages(envelope([first, second, third]));
    expect(continued.status).toBe('partial');
    expect(continued.pagination.batch.completedPages).toBe(2);
    expect(continued.channels.map((item) => item.id)).toEqual(['C3', 'C1']);
  });

  test('zero channels with DM or utility rows is valid but zero raw sidebar rows is not', () => {
    const entries = [
      { id: 'Vall_threads' },
      section('DMs', [channel('D1', 'Sam', { kind: 'dm' })]),
    ];
    const first = frame({ entries }),
      second = frame({ previous: first, entries });
    const result = collectChannelPages(envelope([first, second]));
    expect(result.status).toBe('ok');
    expect(result.channels).toEqual([]);
    expect(result.pagination.returnedCount).toBe(0);
    expect(result.coverage.complete).toBe(false);
    expect(() =>
      collectChannelPages(envelope([frame({ entries: [] })], {}, { stopReason: 'no-next-page' }))
    ).toThrow('row identity');
  });

  test('rejects native channel IDs, row keys or scope that disagree with the raw AX capture', () => {
    for (const mutation of [
      'ids',
      'order',
      'rows',
      'scope',
      'missing-expanded',
      'missing-filter',
      'null-filter',
      'fallback-value',
    ]) {
      const first = frame();
      if (mutation === 'ids') first.receipt.channelPagination.channelIds = ['C9'];
      if (mutation === 'order') first.receipt.channelPagination.channelIds.reverse();
      if (mutation === 'rows') first.receipt.channelPagination.afterRowKeys = [];
      if (mutation === 'scope') first.receipt.channelPagination.scope.workspaceName = 'Elsewhere';
      if (mutation === 'missing-expanded') delete first.nodes[first.rows[0]].expanded;
      if (mutation === 'missing-filter') delete first.nodes[first.filter].stateValue;
      if (mutation === 'null-filter') first.nodes[first.filter].stateValue = null;
      if (mutation === 'fallback-value') first.nodes[first.filter].AXValue = 'different';
      expect(() => collectChannelPages(envelope([first]))).toThrow();
    }
  });

  test('requires unique scoped structures and rejects reopened Query overlays', () => {
    for (const mutation of [
      'sidebar',
      'wrapper',
      'outline',
      'filter',
      'parent',
      'home',
      'wrapper-parent',
      'query',
      'empty-row',
      'duplicate-row',
      'after',
    ]) {
      const first = frame();
      if (mutation === 'sidebar') first.add(first.home, 'AXGroup', ['p-channel_sidebar']);
      if (mutation === 'wrapper')
        first.add(first.root, 'AXGroup', ['p-client_workspace_wrapper'], 'Other');
      if (mutation === 'outline')
        first.add(
          first.hider,
          'AXOutline',
          ['c-virtual_list__scroll_container'],
          'Channels and direct messages'
        );
      if (mutation === 'filter')
        first.add(first.home, 'AXTextField', ['c-filter_input__input'], 'Channel or user name', {
          AXValue: '',
          stateValue: '',
        });
      if (mutation === 'parent') first.nodes[first.hider].parent = first.home;
      if (mutation === 'home') first.nodes[first.home].label = 'Other';
      if (mutation === 'wrapper-parent') first.nodes[first.home].parent = first.root;
      if (mutation === 'query') first.add(first.root, 'AXComboBox', [], 'Query');
      if (mutation === 'empty-row') first.nodes[first.rows[1]].id = '';
      if (mutation === 'duplicate-row')
        first.nodes[first.rows[2]].id = first.nodes[first.rows[1]].id;
      if (mutation === 'after') delete first.receipt.after;
      expect(() => collectChannelPages(envelope([first]))).toThrow();
    }
  });

  test('off-outline duplicate rows cannot taint channel metadata in the first or a later capture', () => {
    const taint = (fixture, id) => {
      const row = fixture.add(fixture.sidebar, 'AXRow', [], '', { id, expanded: null });
      const group = fixture.add(row, 'AXGroup', [
        'p-channel_sidebar__channel',
        'p-channel_sidebar__channel--selected',
        'p-channel_sidebar__channel--unread',
      ]);
      fixture.add(group, 'AXStaticText', [], id.toLowerCase());
    };
    const first = frame();
    expect(compactOutput(first.receipt, 'channels').channels[0].unread).toBeNull();
    taint(first, 'C3');
    // Establish that the pre-existing single-capture extractor would merge this
    // duplicate despite the native outline identities staying unchanged.
    expect(compactOutput(first.receipt, 'channels').channels[0]).toMatchObject({
      unread: true,
      selected: true,
    });
    expect(() => collectChannelPages(envelope([first]))).toThrow('outside the verified');

    const clean = frame();
    const second = frame({
      previous: clean,
      entries: [section('Channels', [channel('C1'), channel('C4')])],
    });
    taint(second, 'C1');
    const result = retainedPrefix(envelope([clean, second]));
    expect(result.channels.find((item) => item.id === 'C1')).toMatchObject({
      unread: null,
      selected: null,
    });
    expect(result.channels.some((item) => item.id === 'C4')).toBe(false);
  });

  test('supports observed enterprise workspace identity and retains prefix on scope or process drift', () => {
    for (const mutation of [
      'workspace',
      'context',
      'title',
      'view',
      'filter',
      'pid',
      'operation',
    ]) {
      const first = frame();
      const options = {
        previous: first,
        entries: [section('Channels', [channel('C1'), channel('C4')])],
      };
      if (mutation === 'workspace') options.workspace = 'Different Workspace';
      if (mutation === 'context') options.context = 'EOTHER';
      if (mutation === 'title') options.title = 'A different view - Test Workspace - Slack';
      if (mutation === 'view') options.view = 'COTHER';
      if (mutation === 'filter') options.filterValue = 'changed';
      const second = frame(options);
      if (mutation === 'pid') second.receipt.pid++;
      if (mutation === 'operation') second.receipt.operation = 'search';
      const result = retainedPrefix(envelope([first, second]));
      expect(result.workspace).toEqual({ name: 'Test Workspace', contextId: 'EDEMO', id: null });
    }
  });

  test('checks section labels and expansion across all earlier captures without conflating null and false', () => {
    for (const mutation of ['label', 'expanded']) {
      const first = frame();
      const sectionExtra = mutation === 'label' ? { label: 'Renamed' } : { expanded: false };
      const second = frame({
        previous: first,
        entries: [section('Channels', [channel('C1'), channel('C4')], sectionExtra)],
      });
      retainedPrefix(envelope([first, second]));
    }
    const first = frame({
      entries: [section('A', [channel('C1')], { expanded: null }), section('B', [channel('C2')])],
    });
    const second = frame({
      previous: first,
      entries: [section('B', [channel('C2'), channel('C3')])],
    });
    const third = frame({
      previous: second,
      entries: [section('B', [channel('C3')]), section('A', [channel('C4')], { expanded: false })],
    });
    const result = collectChannelPages(envelope([first, second, third]));
    expect(result.status).toBe('partial');
    expect(result.pagination.batch.completedPages).toBe(2);
    expect(result.error).toContain('expansion');
    expect(result.channels.map((item) => item.id)).toEqual(['C1', 'C2', 'C3']);
  });

  test('a conflicting channel name rejects the entire later capture before adding any of its records', () => {
    const first = frame();
    const second = frame({
      previous: first,
      entries: [
        section('Channels', [channel('C1')]),
        section('Later', [channel('C4'), channel('C3', 'renamed')]),
      ],
    });
    const result = retainedPrefix(envelope([first, second]));
    expect(result.error).toContain('conflicting names');
    expect(result.channels.some((item) => item.id === 'C4')).toBe(false);
  });

  test('native later failures retain the verified prefix and distinguish attempted from completed captures', () => {
    for (const stopReason of ['error', 'time-limit']) {
      const result = collectChannelPages(
        envelope(
          [frame()],
          { status: 'partial', error: 'Native guard stopped input' },
          { requestedPages: 5, attemptedPages: stopReason === 'error' ? 2 : 1, stopReason }
        )
      );
      expect(result.status).toBe('partial');
      expect(result.error).toBe('Native guard stopped input');
      expect(result.channels).toHaveLength(2);
      expect(result.pagination).toMatchObject({
        scrollAttempts: 0,
        capturedCount: 2,
        returnedCount: 2,
        hasMore: null,
        nextCursor: null,
        batch: { completedPages: 1, stopReason },
      });
      expect(result.coverage.warnings.at(-1)).toContain('verified capture prefix');
    }
  });

  test('rejects malformed bounds and marks dishonest terminal reasons partial', () => {
    for (const changes of [
      { requestedPages: 1 },
      { requestedPages: 11 },
      { attemptedPages: 0 },
      { attemptedPages: 3 },
      { completedPages: 0 },
      { direction: 'next' },
      { stopReason: 'complete' },
    ])
      expect(() => collectChannelPages(envelope([frame()], {}, changes))).toThrow(
        'budget or counts'
      );
    for (const stopReason of ['page-limit', 'no-progress', 'no-next-page', 'error', 'time-limit']) {
      const result = collectChannelPages(
        envelope([frame()], {}, { requestedPages: 3, stopReason })
      );
      expect(result.status).toBe('partial');
      expect(result.channels).toHaveLength(2);
      expect(result.pagination.nextCursor).toBeNull();
    }
  });
});

describe('bounded sidebar DM collection', () => {
  const dm = (id, name, extra = {}) => channel(id, name, { kind: 'dm', ...extra });
  const dmFrame = (options = {}) =>
    frame({
      operation: 'dms',
      entries: [section('Mixed', [dm('D1', 'Alex Example')])],
      ...options,
    });

  test('retains first whole DM records and recalculates name ambiguity across all captures and kinds', () => {
    const first = dmFrame({
      entries: [section('Mixed', [dm('D1', 'Alex Example'), dm('D2', 'Sam, Alex')])],
    });
    const second = dmFrame({
      previous: first,
      entries: [
        section('Mixed', [
          dm('D2', 'Sam, Alex', {
            modifiers: ['p-channel_sidebar__channel--selected'],
            url: 'https://example.com/later',
          }),
          dm('D3', 'Alex Example'),
        ]),
      ],
    });
    const third = dmFrame({
      previous: second,
      entries: [
        section('Mixed', [
          dm('D3', 'Alex Example'),
          dm('G1', 'Sam, Alex', { kind: 'group-dm', tokens: ['Sam', ', ', 'Alex'] }),
          dm('D4', 'Unique Example', { kind: 'self' }),
        ]),
      ],
    });
    const input = envelope([first, second, third]);
    const original = structuredClone(input);
    expect(compactOutput(first.receipt, 'dms').dms.every((dm) => dm.navigation)).toBe(true);
    const result = collectDMPages(input);
    expect(result.status).toBe('ok');
    expect(result.operation).toBe('dms');
    expect(result.channels).toBeUndefined();
    expect(result.dms.map((dm) => dm.id)).toEqual(['D1', 'D2', 'D3', 'G1', 'D4']);
    expect(result.dms.map((dm) => dm.navigation)).toEqual([
      null,
      null,
      null,
      { command: 'read-dm', args: ['group:G1'] },
      { command: 'read-dm', args: ['Unique Example'] },
    ]);
    expect(result.dms[1]).toMatchObject({ selected: null, url: null, sections: ['Mixed'] });
    expect(result.pagination).toMatchObject({
      capturedCount: 7,
      returnedCount: 5,
      scrollAttempts: 2,
      hasMore: null,
      nextCursor: null,
      batch: { completedPages: 3, deduplicatedCount: 2 },
    });
    expect(result.coverage).toMatchObject({ complete: false, observedCount: 5, capturedCount: 7 });
    expect(result.coverage.reason).toContain('unexposed DMs');
    expect(input).toEqual(original);
  });

  test('group hints retain distinct IDs across same-name groups and overlapping captures', () => {
    const group = (id) =>
      dm(id, 'Alex, Sam', {
        kind: 'group-dm',
        tokens: ['Alex', ', ', 'Sam'],
      });
    const first = dmFrame({ entries: [section('Mixed', [group('C1'), group('G2')])] });
    const second = dmFrame({
      previous: first,
      entries: [section('Mixed', [group('G2'), group('C3')])],
    });
    const result = collectDMPages(envelope([first, second]));
    expect(result.status).toBe('ok');
    expect(result.dms.map(({ id, navigation }) => ({ id, navigation }))).toEqual(
      ['C1', 'G2', 'C3'].map((id) => ({
        id,
        navigation: { command: 'read-dm', args: [`group:${id}`] },
      }))
    );
    expect(result.pagination).toMatchObject({
      capturedCount: 4,
      returnedCount: 3,
      batch: { completedPages: 2, deduplicatedCount: 1 },
    });
  });

  test('channel-only advancement can lead to more DMs and does not stop on DM novelty', () => {
    const first = dmFrame();
    const second = dmFrame({
      previous: first,
      entries: [section('Mixed', [dm('D1', 'Alex Example'), channel('C1')])],
    });
    const third = dmFrame({
      previous: second,
      entries: [section('Mixed', [channel('C1'), dm('D2', 'Sam Example')])],
    });
    const result = collectDMPages(envelope([first, second, third]));
    expect(result.status).toBe('ok');
    expect(result.dms.map((dm) => dm.id)).toEqual(['D1', 'D2']);
    expect(result.pagination.batch.completedPages).toBe(3);
  });

  test('repeated DM appearances deduplicate and no-progress keeps uncertainty explicit', () => {
    const entries = [
      section('Favorites', [dm('D1', 'Alex Example')]),
      section('DMs', [dm('D1', 'Alex Example')]),
    ];
    const first = dmFrame({ entries }),
      second = dmFrame({ previous: first, entries });
    const result = collectDMPages(envelope([first, second], {}, { requestedPages: 10 }));
    expect(result.status).toBe('ok');
    expect(result.dms).toHaveLength(1);
    expect(result.dms[0]).toMatchObject({
      sections: ['Favorites', 'DMs'],
      navigation: { command: 'read-dm', args: ['Alex Example'] },
    });
    expect(result.pagination).toMatchObject({
      capturedCount: 2,
      returnedCount: 1,
      hasMore: null,
      nextCursor: null,
      batch: { stopReason: 'no-progress', completedPages: 2, deduplicatedCount: 1 },
    });
  });

  test('empty DM collections require exposed sidebar rows and do not invent a directory boundary', () => {
    const entries = [{ id: 'Vall_threads' }, section('Channels', [channel('C1')])];
    const first = dmFrame({ entries }),
      second = dmFrame({ previous: first, entries });
    const result = collectDMPages(envelope([first, second]));
    expect(result.status).toBe('ok');
    expect(result.dms).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(result.pagination).toMatchObject({ returnedCount: 0, capturedCount: 0, hasMore: null });
    expect(() => collectDMPages(envelope([dmFrame({ entries: [] })]))).toThrow(
      'rows are not exposed'
    );
  });

  test('independently verifies native DM IDs and requires DM rather than channel pagination metadata', () => {
    const first = dmFrame();
    first.receipt.dmPagination.dmIds = ['DOTHER'];
    expect(() => collectDMPages(envelope([first]))).toThrow('semantic identities');
    const wrongKey = dmFrame();
    wrongKey.receipt.channelPagination = wrongKey.receipt.dmPagination;
    delete wrongKey.receipt.dmPagination;
    expect(() => collectDMPages(envelope([wrongKey]))).toThrow('semantic identities');
    const clean = dmFrame();
    const second = dmFrame({
      previous: clean,
      entries: [section('Mixed', [dm('D1', 'Alex Example'), dm('D2', 'Sam Example')])],
    });
    second.receipt.dmPagination.dmIds.reverse();
    const partial = collectDMPages(envelope([clean, second]));
    expect(partial.status).toBe('partial');
    expect(partial.dms.map((dm) => dm.id)).toEqual(['D1']);
    expect(partial.pagination.batch.completedPages).toBe(1);
  });

  test('changed DM names or kinds retain only the earlier verified capture', () => {
    for (const mutation of ['name', 'kind']) {
      const first = dmFrame();
      const changed = dm('D1', mutation === 'name' ? 'Changed Name' : 'Alex Example', {
        kind: mutation === 'kind' ? 'self' : 'dm',
      });
      const second = dmFrame({
        previous: first,
        entries: [section('Mixed', [changed, dm('D2', 'Sam Example')])],
      });
      const result = collectDMPages(envelope([first, second]));
      expect(result.status).toBe('partial');
      expect(result.dms).toHaveLength(1);
      expect(result.dms[0]).toMatchObject({ id: 'D1', name: 'Alex Example', kind: 'one-to-one' });
      expect(result.error).toContain('conflicting names or kinds');
      expect(result.pagination.batch.completedPages).toBe(1);
    }
  });

  test('off-outline D-row metadata cannot enter either an initial or later capture', () => {
    const taint = (f) => {
      const row = f.add(f.sidebar, 'AXRow', [], '', { id: 'D1', expanded: null });
      const group = f.add(row, 'AXGroup', [
        'p-channel_sidebar__channel',
        'p-channel_sidebar__channel--im',
        'p-channel_sidebar__channel--selected',
      ]);
      f.add(group, 'AXStaticText', [], 'Alex Example');
    };
    const first = dmFrame();
    taint(first);
    expect(() => collectDMPages(envelope([first]))).toThrow('outside the verified');
    const clean = dmFrame(),
      second = dmFrame({ previous: clean });
    taint(second);
    const result = collectDMPages(envelope([clean, second]));
    expect(result.status).toBe('partial');
    expect(result.dms[0].selected).toBeNull();
    expect(result.pagination.batch.completedPages).toBe(1);
  });

  test('DM collection shares row/scope guards and keeps native failure prefixes with no continuation', () => {
    for (const mutation of ['scope', 'edge', 'section', 'pid', 'operation']) {
      const first = dmFrame();
      const second = dmFrame({
        previous: first,
        entries: [section('Mixed', [dm('D1', 'Alex Example'), dm('D2', 'Sam Example')])],
      });
      if (mutation === 'scope') second.receipt.dmPagination.scope.filterValue = 'changed';
      if (mutation === 'edge') second.receipt.dmPagination.edgeKey = 'stale';
      if (mutation === 'section') second.nodes[second.rows[0]].expanded = false;
      if (mutation === 'pid') second.receipt.pid++;
      if (mutation === 'operation') second.receipt.operation = 'channels';
      const result = collectDMPages(envelope([first, second]));
      expect(result.status).toBe('partial');
      expect(result.dms).toHaveLength(1);
      expect(result.pagination.batch.completedPages).toBe(1);
    }
    const result = collectDMPages(
      envelope(
        [dmFrame()],
        { status: 'partial', error: 'Guard stopped input' },
        { requestedPages: 3, attemptedPages: 2, stopReason: 'error' }
      )
    );
    expect(result.status).toBe('partial');
    expect(result.next).toContain('Verified DMs');
    expect(result.pagination).toMatchObject({ nextCursor: null, hasMore: null, scrollAttempts: 0 });
    expect(result.dms).toHaveLength(1);
  });
});
