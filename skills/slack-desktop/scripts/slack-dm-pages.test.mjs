import { describe, expect, test } from 'bun:test';
import {
  compactOutput,
  structuredOutput,
  hubObservation,
  applyDMFilter,
  dmSearchQuery,
} from './slack-output.mjs';
import { collectDMPages } from './slack-channel-pages.mjs';

function fixture(records, options = {}) {
  const nodes = [];
  const add = (role, label, classes, parent, extra = {}) => {
    const node = {
      index: nodes.length,
      parent: parent?.index ?? null,
      role,
      label,
      id: '',
      classes,
      AXValue: '',
      ...extra,
    };
    nodes.push(node);
    return node;
  };
  const root = add('AXWebArea', 'Example (DM) - Demo - Slack', [], null, {
    url: 'https://app.slack.com/client/TDEMO/dms',
  });
  const wrapper = add('AXGroup', 'Demo', ['p-client_workspace_wrapper'], root);
  const tab = add('AXRadioButton', 'DMs', ['p-tab_rail__button'], wrapper, {
    id: 'dms',
    stateValue: '1',
    selected: true,
  });
  const panel = add('AXGroup', 'DMs', ['p-client_workspace__tabpanel'], wrapper);
  const view = add(
    'AXGroup',
    options.viewLabel ?? 'Direct messages',
    ['p-view_contents', 'p-view_contents--sidebar'],
    panel
  );
  const filterContainer = add(
    'AXGroup',
    '',
    ['p-dms_page_header_search_bar__destination__multi_select_input'],
    view
  );
  const filterValue = options.filterValue ?? '\u00a0 \u00a0';
  const filter = add('AXComboBox', 'Search query', [], filterContainer, {
    id: 'dms_tab_page__destination',
    stateValue: filterValue,
    AXValue: filterValue,
  });
  const filterText = options.filterText ?? ['\u00a0'];
  for (const label of filterText) add('AXStaticText', label, [], filter);
  const unread = add(
    'AXCheckBox',
    'Filter by unread messages; 0 unread',
    ['p-unreads_toggle'],
    view,
    {
      stateValue: options.unreadOnly ? '1' : '0',
    }
  );
  const recent = add('AXGroup', '', ['p-recent_page'], view);
  const hider = options.directList ? recent : add('AXGroup', '', ['c-scrollbar__hider'], recent);
  const list = add(
    'AXList',
    options.listLabel ?? 'Recent conversations',
    ['c-virtual_list__scroll_container'],
    hider
  );
  const rows = [];
  for (const record of records) {
    const row = add('AXGroup', '', ['c-virtual_list__item'], list, { id: record.id });
    rows.push(row);
    const container = add('AXGroup', '', ['p-activity_ia4_page__item_container'], row);
    const body = add(
      'AXGroup',
      '',
      [
        'c-message_kit__message',
        'p-activity_ia4_page__item',
        ...(record.unsupported ? [] : ['p-activity_ia4_page__item--dms']),
        ...(record.unread ? ['p-activity_ia4_page__item--unread--dm'] : []),
        ...(record.selected ? ['p-activity_ia4_page__item--selected--dm'] : []),
      ],
      container
    );
    if (record.kind === 'group') add('AXGroup', '', ['c-base_icon_image_stacked'], body);
    else add('AXImage', '', ['sr-only'], body);
    add('AXStaticText', record.name, [], body);
    if (record.kind === 'self') {
      add('AXStaticText', '\u00a0', [], body);
      add('AXStaticText', '(you)', [], body);
    }
    for (const token of record.previewMembers ?? []) add('AXStaticText', token, [], body);
    const meta = add('AXGroup', '', ['p-dms_channel__meta'], body);
    add('AXStaticText', 'Yesterday', [], meta);
    const preview = add('AXGroup', '', [], body);
    add(
      'AXStaticText',
      'A private message preview must not become a name or listing body.',
      [],
      preview
    );
    add('AXLink', '@do-not-infer', ['c-member_slug'], preview, {
      url: 'https://demo.slack.com/team/UOTHER',
    });
  }
  const side = add('AXGroup', '', ['p-message_pane'], wrapper);
  add('AXStaticText', 'Adjacent conversation content must not enter the listing.', [], side);
  const scope = {
    source: 'dms-view',
    url: root.url,
    title: root.label,
    workspaceName: wrapper.label,
    viewLabel: view.label,
    listLabel: list.label,
    filterValue,
    filterText,
    ...(options.searchQuery !== undefined ? { searchQuery: options.searchQuery } : {}),
    unreadOnly: !!options.unreadOnly,
    tabSelected: true,
  };
  const keys = records.map((record) => record.id);
  const frame = {
    operation: 'dms',
    ...(options.dmSearch ? { dmSearch: options.dmSearch } : {}),
    pid: 42,
    before: { title: root.label, url: root.url },
    after: { title: root.label, url: root.url },
    content: { nodes, truncated: false, observedAt: '2026-11-09T12:00:00Z' },
    target: {},
    dmPagination: {
      status: options.previous ? (options.noProgress ? 'no-progress' : 'advanced') : 'initial',
      scrollAttempts: options.previous ? 1 : 0,
      edgeKey: options.previous?.at(-1) ?? null,
      beforeRowKeys: options.previous ?? keys,
      afterRowKeys: keys,
      dmIds: records.filter((record) => !record.unsupported).map((record) => record.id),
      scope,
    },
  };
  return {
    frame,
    nodes,
    add,
    root,
    wrapper,
    tab,
    view,
    list,
    filterContainer,
    filter,
    unread,
    rows,
    side,
  };
}

const person = (id, name = id) => ({ id, name, kind: 'one-to-one' });
const group = (id, name = id) => ({ id, name, kind: 'group' });
const read = (f) => compactOutput(f.frame, 'dms');
function batch(frames, options = {}) {
  return {
    operation: 'dms',
    ...(frames[0].frame.dmSearch ? { dmSearch: structuredClone(frames[0].frame.dmSearch) } : {}),
    pid: 42,
    status: options.error ? 'partial' : 'ok',
    ...(options.error ? { error: options.error } : {}),
    pages: frames.map((f) => f.frame),
    batch: {
      direction: 'down',
      requestedPages: options.requestedPages ?? Math.max(2, frames.length),
      attemptedPages: options.attemptedPages ?? frames.length,
      completedPages: frames.length,
      stopReason: options.stopReason ?? 'page-limit',
    },
  };
}

// Provisional contract fixtures only: native search completion is not live-proven.
// Echoed text or sentinel adornment alone cannot establish applied Slack search.
const searched = (records, query, options = {}) =>
  fixture(records, {
    ...options,
    filterValue: `${query}\u00a0 \u00a0`,
    filterText: [`${query}\u00a0`, '\u00a0'],
    searchQuery: query,
    dmSearch: { requested: query, verified: true },
  });
const readSearch = (f, dmSearch) => compactOutput(f.frame, 'dms', null, { dmSearch });

// The observed header now wraps the field in a class-hashed destination group.
// Keep the legacy fixture unchanged so both independently observed layouts run.
function withHeaderFilter(f) {
  const searchHeader = f.add(
    'AXGroup',
    'Search DMs',
    ['p-dms_page_header', 'p-dms_page_header__search-bar'],
    f.view
  );
  const searchBar = f.add('AXGroup', '', ['p-dms_page_header_search_bar'], searchHeader);
  f.filterContainer.classes = ['multiSelectInput__example', 'c-form--small'];
  f.filterContainer.parent = searchBar.index;
  return { ...f, searchHeader, searchBar };
}

describe('DMs recent list ancestry', () => {
  test('accepts the list under a scrollbar hider or directly under the recent page', () => {
    for (const directList of [false, true]) {
      const f = withHeaderFilter(fixture([person('DA', 'Alex')], { directList }));
      expect(read(f).dms.map((dm) => dm.id)).toEqual(['DA']);
    }
  });
});

describe('DMs header destination wrapper', () => {
  test('accepts the observed direct header wrapper without relying on hashed classes', () => {
    for (const viewLabel of ['Direct messages', 'Direct Messages']) {
      for (const classes of [
        [],
        ['unrelated-rendered-class'],
        ['p-dms_page_header_search_bar__destination__multi_select_input'],
      ]) {
        const f = withHeaderFilter(fixture([person('DA', 'Alex')], { viewLabel }));
        f.filterContainer.classes = classes;
        expect(read(f).dms.map((dm) => dm.id)).toEqual(['DA']);
        expect(read(f).coverage.filters).toEqual({ query: '', unreadOnly: false });
      }
    }
  });

  test('preserves exact native search proof, query text and unread scope in the new wrapper', () => {
    for (const query of ['', 'Alex', ' Alex ', '🙂']) {
      const f = withHeaderFilter(searched([person('DA', 'Alex')], query, { unreadOnly: true }));
      const original = structuredClone(f.frame);
      expect(readSearch(f, query).coverage).toMatchObject({
        filters: { query, unreadOnly: true },
        search: { source: 'slack-dms-view', requestedQuery: query, verified: true },
      });
      expect(hubObservation(f.frame).scope).toMatchObject({
        searchQuery: query,
        filterValue: `${query}\u00a0 \u00a0`,
        filterText: [`${query}\u00a0`, '\u00a0'],
      });
      expect(f.frame).toEqual(original);
    }
  });

  test.each([
    ...['filterContainer', 'searchBar', 'searchHeader', 'view'].map((key) => [
      `${key} role`,
      (f) => {
        f[key].role = 'AXToolbar';
      },
    ]),
    ...['filterContainer', 'searchBar', 'searchHeader', 'view'].flatMap((key) => [
      [
        `${key} ID`,
        (f) => {
          f[key].id = 'unexpected';
        },
      ],
      [
        `${key} missing ID`,
        (f) => {
          delete f[key].id;
        },
      ],
      [
        `${key} label`,
        (f) => {
          f[key].label += ' ';
        },
      ],
    ]),
    ...['p-dms_page_header', 'p-dms_page_header__search-bar'].map((name) => [
      `missing exact ${name} class`,
      (f) => {
        f.searchHeader.classes = f.searchHeader.classes.filter((item) => item !== name);
      },
    ]),
    [
      'search bar class prefix only',
      (f) => {
        f.searchBar.classes = ['p-dms_page_header_search_bar--unrecognized'];
      },
    ],
    [
      'indirect header parent',
      (f) => {
        f.searchHeader.parent = f.add('AXGroup', '', [], f.view).index;
      },
    ],
    [
      'indirect search bar parent',
      (f) => {
        f.searchBar.parent = f.add('AXGroup', '', [], f.searchHeader).index;
      },
    ],
    [
      'indirect destination parent',
      (f) => {
        f.filterContainer.parent = f.add('AXGroup', '', [], f.searchBar).index;
      },
    ],
    [
      'indirect field parent',
      (f) => {
        f.filter.parent = f.add('AXGroup', '', [], f.filterContainer).index;
      },
    ],
    [
      'header outside the verified view',
      (f) => {
        f.searchHeader.parent = f.side.index;
      },
    ],
    [
      'field outside the destination',
      (f) => {
        f.filter.parent = f.searchBar.index;
      },
    ],
    [
      'field role',
      (f) => {
        f.filter.role = 'AXTextField';
      },
    ],
    [
      'field ID',
      (f) => {
        f.filter.id += '-other';
      },
    ],
    [
      'field label',
      (f) => {
        f.filter.label = 'Search DMs';
      },
    ],
    [
      'field value contradiction',
      (f) => {
        f.filter.AXValue = 'Other';
      },
    ],
    [
      'another destination candidate without a field',
      (f) => {
        f.add('AXGroup', '', ['unknown-destination-class'], f.searchBar);
      },
    ],
    [
      'another header with an empty destination candidate',
      (f) => {
        const header = f.add('AXGroup', 'Search DMs', f.searchHeader.classes, f.view);
        const bar = f.add('AXGroup', '', f.searchBar.classes, header);
        f.add('AXGroup', '', [], bar);
      },
    ],
    [
      'legacy destination candidate with an invalid role',
      (f) => {
        f.add(
          'AXButton',
          'Unknown',
          ['p-dms_page_header_search_bar__destination__multi_select_input'],
          f.view
        );
      },
    ],
    [
      'duplicate canonical field ID with another role',
      (f) => {
        f.add('AXGroup', '', [], f.searchBar, { id: f.filter.id });
      },
    ],
    [
      'recipient chip beside field',
      (f) => {
        f.add('AXButton', 'Selected person', [], f.filterContainer);
      },
    ],
    [
      'unknown text sibling beside field',
      (f) => {
        f.add('AXStaticText', '', [], f.filterContainer);
      },
    ],
    [
      'recipient chip inside field',
      (f) => {
        f.add('AXButton', 'Selected person', [], f.filter);
      },
    ],
    [
      'uncorroborated recipient text inside field',
      (f) => {
        f.add('AXStaticText', 'Selected person', [], f.filter);
        f.frame.dmPagination.scope.filterText.push('Selected person');
      },
    ],
    [
      'forged native query scope',
      (f) => {
        f.frame.dmPagination.scope.filterValue = 'Other';
      },
    ],
    [
      'duplicate view',
      (f) => {
        f.add('AXGroup', f.view.label, f.view.classes, f.wrapper);
      },
    ],
  ])('rejects %s in the new wrapper', (_name, mutate) => {
    const f = withHeaderFilter(fixture([person('DA')]));
    mutate(f);
    expect(() => read(f)).toThrow();
  });

  test('collects new-wrapper pages with deduplication and read hints despite changed hash classes', () => {
    const a = withHeaderFilter(searched([person('DA', 'Alex')], 'Alex'));
    const b = withHeaderFilter(
      searched([person('DA', 'Alex'), group('CGROUP', 'Planning')], 'Alex', { previous: ['DA'] })
    );
    b.filterContainer.classes = ['new-rendered-class'];
    const result = collectDMPages(batch([a, b]), { dmSearch: 'Alex' });
    expect(result.status).toBe('ok');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DA', 'CGROUP']);
    expect(result.dms.map((dm) => dm.navigation.args)).toEqual([['Alex'], ['group:CGROUP']]);
    expect(result.pagination.batch).toMatchObject({ completedPages: 2, deduplicatedCount: 1 });
    expect(result.coverage.filters).toEqual({ query: 'Alex', unreadOnly: false });
  });

  test.each([
    [
      'query changed with matching native scope',
      (f) => {
        f.filter.stateValue = f.filter.AXValue = 'Other';
        f.nodes.find((node) => node.parent === f.filter.index).label = 'Other';
        f.frame.dmPagination.scope.filterValue = 'Other';
        f.frame.dmPagination.scope.filterText = ['Other'];
      },
    ],
    [
      'unread filter changed with matching native scope',
      (f) => {
        f.unread.stateValue = '1';
        f.frame.dmPagination.scope.unreadOnly = true;
      },
    ],
    [
      'corroborated text changed while the query stays blank',
      (f) => {
        f.add('AXStaticText', '', [], f.filter);
        f.frame.dmPagination.scope.filterText.push('');
      },
    ],
    [
      'destination became indirect',
      (f) => {
        f.filterContainer.parent = f.add('AXGroup', '', [], f.searchBar).index;
      },
    ],
    [
      'recipient chip appeared',
      (f) => {
        f.add('AXButton', 'Selected person', [], f.filterContainer);
      },
    ],
    [
      'unknown destination sibling appeared',
      (f) => {
        f.add('AXGroup', '', [], f.searchBar);
      },
    ],
  ])('keeps only the verified page prefix when %s', (_name, mutate) => {
    const a = withHeaderFilter(fixture([person('DA')]));
    const b = withHeaderFilter(fixture([person('DA'), person('DB')], { previous: ['DA'] }));
    mutate(b);
    const result = collectDMPages(batch([a, b]));
    expect(result.status).toBe('partial');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DA']);
    expect(result.pagination.batch.completedPages).toBe(1);
    expect(result.error).toBeTruthy();
  });
});

describe('native DMs search verification', () => {
  test('explicit internal search requests cannot be ignored on unrelated operations', () => {
    const f = searched([person('DA')], 'Alex');
    for (const operation of ['channels', 'inspect', 'read-dm', 'read-channel', 'search']) {
      expect(() => compactOutput(f.frame, operation, null, { dmSearch: 'Alex' })).toThrow(
        'requires the dms operation'
      );
      expect(() => structuredOutput(f.frame, operation, null, { dmSearch: '' })).toThrow(
        'requires the dms operation'
      );
    }
  });

  test('removes only the exact corroborated field adornment and preserves literal whitespace', () => {
    for (const query of ['', 'Alex', ' Alex ', '🙂', 'Alex\u00a0 \u00a0']) {
      const raw = `${query}\u00a0 \u00a0`;
      expect(dmSearchQuery(raw, [`${query}\u00a0`, '\u00a0'])).toBe(query);
      expect(dmSearchQuery(raw, ['\u00a0'])).toBe(raw);
      expect(dmSearchQuery(raw, ['\u00a0', `${query}\u00a0`])).toBe(query === '' ? '' : raw);
      expect(dmSearchQuery(query, [])).toBe(query);
    }
    expect(() => dmSearchQuery('Alex', [null])).toThrow('observations');
  });

  test('binds exact caller text to native proof and independently observed query', () => {
    for (const query of ['', 'Alex', ' Alex ', '🙂']) {
      const f = searched([person('DA', 'Unrelated title')], query, { unreadOnly: true });
      const result = readSearch(f, query);
      expect(result.requested).toBeNull();
      expect(result.dms).toHaveLength(1);
      expect(result.coverage.filters).toEqual({ query, unreadOnly: true });
      expect(result.coverage.search).toEqual({
        source: 'slack-dms-view',
        requestedQuery: query,
        verified: true,
      });
      expect(hubObservation(f.frame).scope).toMatchObject({
        searchQuery: query,
        filterValue: `${query}\u00a0 \u00a0`,
        filterText: [`${query}\u00a0`, '\u00a0'],
      });
      expect(read(f).coverage.search).toBeUndefined();
    }
    expect(read(fixture([person('DA')])).coverage.search).toBeUndefined();
  });

  test('rejects missing or mismatched request proof without accepting old or unrelated rows', () => {
    for (const alter of [
      (f) => {
        delete f.frame.dmSearch;
      },
      (f) => {
        f.frame.dmSearch.verified = false;
      },
      (f) => {
        f.frame.dmSearch.requested = 'Other';
      },
      (f) => {
        f.frame.operation = 'inspect';
      },
      (f) => {
        delete f.frame.dmPagination.scope.searchQuery;
      },
      (f) => {
        f.frame.dmPagination.scope.searchQuery = 'Other';
      },
      (f) => {
        f.filter.AXValue = f.filter.stateValue = 'Old query';
        f.frame.dmPagination.scope.filterValue = 'Old query';
      },
      (f) => {
        const text = f.nodes.find((node) => node.parent === f.filter.index);
        text.label = 'Other';
        f.frame.dmPagination.scope.filterText[0] = 'Other';
      },
    ]) {
      const f = searched([person('DA')], 'Alex');
      alter(f);
      expect(() => readSearch(f, 'Alex')).toThrow();
    }
    const f = searched([person('DA')], ' Alex ');
    expect(() => readSearch(f, 'Alex')).toThrow('verification');
    expect(() => readSearch(f, 'alex')).toThrow('verification');
    expect(() => readSearch(f, null)).toThrow('request is invalid');
  });

  test('native failures retain their error instead of requiring successful search proof', () => {
    expect(
      compactOutput(
        { operation: 'dms', status: 'stopped', error: 'Search was not applied' },
        'dms',
        null,
        { dmSearch: 'Alex' }
      )
    ).toMatchObject({ status: 'stopped', error: 'Search was not applied' });
  });

  test('verifies search before collecting pages and applies local matching afterward', () => {
    const a = searched([person('DA', 'Alex')], 'Native participant');
    const b = searched([person('DA', 'Alex'), person('DB', 'Casey')], 'Native participant', {
      previous: ['DA'],
    });
    const receipt = batch([a, b]);
    const collected = collectDMPages(receipt, { dmSearch: 'Native participant' });
    const result = applyDMFilter(collected, 'casey');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DB']);
    expect(result.coverage.search.requestedQuery).toBe('Native participant');
    expect(result.coverage.filters.query).toBe('Native participant');
    expect(result.coverage.match).toMatchObject({
      query: 'casey',
      observedCount: 2,
      matchedCount: 1,
    });
    expect(result.pagination).toMatchObject({ capturedCount: 3, returnedCount: 1 });
    expect(collected.pagination.batch.deduplicatedCount).toBe(1);
    delete receipt.dmSearch;
    expect(() => collectDMPages(receipt, { dmSearch: 'Native participant' })).toThrow(
      'verification'
    );
  });

  test('changed later query or missing proof retains only the verified prefix', () => {
    for (const alter of [
      (f) => {
        delete f.frame.dmSearch;
      },
      (f) => {
        f.frame.dmSearch.requested = 'Other';
      },
      (f) => {
        f.frame.dmPagination.scope.searchQuery = 'Other';
      },
      (f) => {
        f.unread.stateValue = '1';
        f.frame.dmPagination.scope.unreadOnly = true;
      },
      (f) => {
        f.filter.AXValue = f.filter.stateValue = 'Alex';
        f.frame.dmPagination.scope.filterValue = 'Alex';
      },
    ]) {
      const a = searched([person('DA')], 'Alex');
      const b = searched([person('DA'), person('DB')], 'Alex', { previous: ['DA'] });
      alter(b);
      const result = collectDMPages(batch([a, b]), { dmSearch: 'Alex' });
      expect(result.status).toBe('partial');
      expect(result.dms.map((dm) => dm.id)).toEqual(['DA']);
      expect(result.coverage.search.requestedQuery).toBe('Alex');
      expect(result.pagination.batch.completedPages).toBe(1);
    }
  });

  test('a changed initial query is allowed only after verified search, with no invented empty success', () => {
    const f = searched([person('DA')], 'Alex');
    f.frame.before = { ...f.frame.before, filterValue: 'Previous query' };
    expect(readSearch(f, 'Alex').dms).toHaveLength(1);
    const empty = searched([], 'Alex');
    expect(() => readSearch(empty, 'Alex')).toThrow();
    const unsupported = searched([{ ...person('DAPP'), unsupported: true }], 'Alex');
    expect(() => readSearch(unsupported, 'Alex')).toThrow('No supported DM rows');
    const mixed = batch([f]);
    delete mixed.pages[0].dmPagination.scope.source;
    expect(() => collectDMPages(mixed, { dmSearch: 'Alex' })).toThrow('DMs view');
  });
});

describe('local DM matching', () => {
  test('matches names and explicit participant header labels without reading previews', () => {
    const f = fixture(
      [
        person('DA', 'Alex Example'),
        group('CNAME', 'Leah, Alex'),
        { ...group('CPLAN', 'Planning'), previewMembers: ['Leah Example', ', 2 others'] },
        group('COTHER', 'Other'),
      ],
      { filterValue: 'Existing UI query', unreadOnly: true }
    );
    f.nodes
      .filter(
        (node) => node.label === 'A private message preview must not become a name or listing body.'
      )
      .forEach((node) => {
        node.label = 'Preview-only secret';
      });
    const captured = read(f),
      original = structuredClone(captured);
    const matched = applyDMFilter(captured, 'LEAH');
    expect(matched.dms.map((dm) => dm.id)).toEqual(['CNAME', 'CPLAN']);
    expect(matched.dms[1].participantLabels).toEqual(['Leah Example', ', 2 others']);
    expect(matched.dms[1].navigation.args).toEqual(['group:CPLAN']);
    expect(matched.coverage.match).toEqual({
      query: 'LEAH',
      fields: ['name', 'participantLabels'],
      observedCount: 4,
      matchedCount: 2,
      scope: 'captured DM names and observed participant header labels',
    });
    expect(matched.coverage.filters).toEqual({ query: 'Existing UI query', unreadOnly: true });
    expect(matched.requested).toBeNull();
    expect(matched.coverage.observedCount).toBe(4);
    expect(applyDMFilter(captured, 'Preview-only').dms).toEqual([]);
    expect(captured).toEqual(original);
  });

  test('literal case-insensitive matching preserves whitespace and valid zero matches', () => {
    const captured = read(
      fixture([person('DA', 'Élodie'), group('CDOT', 'A.B'), group('CSTAR', '[a]')])
    );
    expect(applyDMFilter(captured, 'ÉLO').dms.map((dm) => dm.id)).toEqual(['DA']);
    expect(applyDMFilter(captured, '.').dms.map((dm) => dm.id)).toEqual(['CDOT']);
    expect(applyDMFilter(captured, '[a]').dms.map((dm) => dm.id)).toEqual(['CSTAR']);
    const none = applyDMFilter(captured, ' ÉLO ');
    expect(none.dms).toEqual([]);
    expect(none.coverage.match).toMatchObject({ observedCount: 3, matchedCount: 0 });
    expect(none.coverage.complete).toBe(false);
    expect(none.pagination.hasMore).toBeNull();
    expect(applyDMFilter(captured)).toBe(captured);
    expect(applyDMFilter(captured, '').dms).toEqual(captured.dms);
    expect(applyDMFilter(captured, '').coverage.match.query).toBe('');
    expect(() => read(fixture([]))).toThrow();
  });

  test('collects unmatched pages before deduplication and all-name navigation guards', () => {
    const a = fixture([person('DA', 'Other')]);
    const b = fixture([person('DA', 'Other'), person('DB', 'Alex')], { previous: ['DA'] });
    const c = fixture(
      [
        person('DB', 'Alex'),
        person('DC', 'Alex'),
        { ...group('CPLAN', 'Planning'), previewMembers: ['Alex'] },
      ],
      { previous: ['DA', 'DB'] }
    );
    const collected = collectDMPages(batch([a, b, c]));
    const result = applyDMFilter(collected, 'alex');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DB', 'DC', 'CPLAN']);
    expect(result.dms.slice(0, 2).every((dm) => dm.navigation === null)).toBe(true);
    expect(result.coverage.observedCount).toBe(4);
    expect(result.coverage.match).toMatchObject({ observedCount: 4, matchedCount: 3 });
    expect(result.pagination).toMatchObject({
      returnedCount: 3,
      capturedCount: 6,
      batch: { completedPages: 3, deduplicatedCount: 2 },
    });
    expect(applyDMFilter(collected, 'not-present').pagination.returnedCount).toBe(0);
  });

  test('later invalid frames cannot provide local matches or erase a verified prefix', () => {
    const a = fixture([person('DA', 'First')]);
    const b = fixture([person('DA', 'First'), group('CB', 'Leah')], { previous: ['DA'] });
    b.frame.dmPagination.scope.filterValue = 'changed';
    const result = applyDMFilter(collectDMPages(batch([a, b])), 'Leah');
    expect(result.status).toBe('partial');
    expect(result.dms).toEqual([]);
    expect(result.coverage.match).toMatchObject({ observedCount: 1, matchedCount: 0 });
    expect(result.pagination.batch.completedPages).toBe(1);
    expect(result.error).toBeTruthy();
  });

  test('participant-header drift keeps the first whole record and stops before later matches', () => {
    const a = fixture([{ ...group('CA', 'Planning'), previewMembers: ['Alex'] }]);
    const b = fixture([{ ...group('CA', 'Planning'), previewMembers: ['Leah'] }, person('DB')], {
      previous: ['CA'],
    });
    const collected = collectDMPages(batch([a, b]));
    expect(collected.status).toBe('partial');
    expect(collected.dms[0].participantLabels).toEqual(['Alex']);
    expect(applyDMFilter(collected, 'Leah').dms).toEqual([]);
  });
});

describe('DMs view listing', () => {
  test('reads one-to-one, self and named/unnamed groups without sidebar or preview leakage', () => {
    const f = fixture([
      { ...person('DA', 'Alex'), unread: true, selected: true },
      { ...person('DSELF', 'Taylor'), kind: 'self' },
      group('CGROUP', 'Alex, Casey'),
      {
        ...group('GNAMED', 'Project planning'),
        previewMembers: ['Alex', ', ', 'Casey', ', 2 others'],
      },
    ]);
    const result = read(f);
    expect(result.dms.map((dm) => [dm.name, dm.kind])).toEqual([
      ['Alex', 'one-to-one'],
      ['Taylor', 'self'],
      ['Alex, Casey', 'group'],
      ['Project planning', 'group'],
    ]);
    expect(result.dms.map((dm) => dm.navigation.args[0])).toEqual([
      'Alex',
      'Taylor',
      'group:CGROUP',
      'group:GNAMED',
    ]);
    expect(result.dms[0]).toMatchObject({
      unread: true,
      selected: true,
      sections: [],
      url: null,
      handle: null,
    });
    expect(result.dms[1]).toMatchObject({ unread: null, selected: null });
    expect(result.coverage).toMatchObject({
      source: 'dms-view',
      complete: false,
      observedCount: 4,
      filters: { query: '', unreadOnly: false },
    });
    expect(result.messages).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private message preview');
    expect(JSON.stringify(result)).not.toContain('@do-not-infer');
  });

  test('supports both observed view/list labels and preserves active filter scope', () => {
    const f = fixture([person('DA', 'Alex')], {
      viewLabel: 'Direct Messages',
      listLabel: 'Direct messages',
      filterValue: ' Alex ',
      unreadOnly: true,
    });
    expect(read(f).coverage.filters).toEqual({ query: 'Alex', unreadOnly: true });
    expect(hubObservation(f.frame).scope.filterValue).toBe(' Alex ');
    f.add('AXStaticText', 'Alex', [], f.filter);
    f.frame.dmPagination.scope.filterText.push('Alex');
    expect(read(f).coverage.filters).toEqual({ query: 'Alex', unreadOnly: true });
  });

  test('retains unknown rows for progress while omitting unsupported metadata', () => {
    const f = fixture([person('DA'), { ...person('DUNKNOWN'), unsupported: true }, group('CB')]);
    const observation = hubObservation(f.frame);
    expect(observation.rowKeys).toEqual(['DA', 'DUNKNOWN', 'CB']);
    expect(read(f).dms.map((dm) => dm.id)).toEqual(['DA', 'CB']);
    expect(read(f).coverage.warnings.some((warning) => warning.includes('1 DMs view rows'))).toBe(
      true
    );
  });

  test('keeps an unsupported AGENT badge as an omission without a guessed hint', () => {
    const f = fixture([
      person('DA', 'Alex'),
      { ...person('DAPP', 'Helper'), previewMembers: ['AGENT'] },
    ]);
    f.frame.dmPagination.dmIds = ['DA'];
    const result = read(f);
    expect(hubObservation(f.frame).rowKeys).toEqual(['DA', 'DAPP']);
    expect(result.dms.map((dm) => dm.id)).toEqual(['DA']);
    expect(result.coverage.warnings.some((warning) => warning.includes('1 DMs view rows'))).toBe(
      true
    );
  });

  test('suppresses ambiguous/unsafe individual hints and retains distinct group references', () => {
    const f = fixture([
      person('DA', 'Same'),
      person('DB', 'Same'),
      person('DC', '@looks.like.handle'),
      person('DD', 'group:reserved'),
      group('CA', 'Same'),
      group('CB', 'Same'),
    ]);
    const dms = read(f).dms;
    expect(dms.slice(0, 4).every((dm) => dm.navigation === null)).toBe(true);
    expect(dms.slice(4).map((dm) => dm.navigation.args[0])).toEqual(['group:CA', 'group:CB']);
  });

  test.each([
    [
      'source missing',
      (f) => {
        delete f.frame.dmPagination;
      },
    ],
    [
      'source changed',
      (f) => {
        f.frame.dmPagination.scope.source = 'sidebar';
      },
    ],
    [
      'URL changed',
      (f) => {
        f.root.url = 'https://app.slack.com/client/TOTHER/dms';
      },
    ],
    [
      'credentials',
      (f) => {
        f.root.url = f.frame.after.url = 'https://user@app.slack.com/client/TDEMO/dms';
      },
    ],
    [
      'wrong view URL',
      (f) => {
        f.root.url = f.frame.after.url = 'https://app.slack.com/client/TDEMO/CCHANNEL';
      },
    ],
    [
      'tab unselected',
      (f) => {
        f.tab.selected = false;
      },
    ],
    [
      'unknown list',
      (f) => {
        f.list.label = 'Other list';
      },
    ],
    [
      'missing filter',
      (f) => {
        f.filter.id = 'unknown';
      },
    ],
    [
      'filter mismatch',
      (f) => {
        f.filter.AXValue = 'Other';
      },
    ],
    [
      'unread state unknown',
      (f) => {
        f.unread.stateValue = null;
      },
    ],
    [
      'recipient chip',
      (f) => {
        f.add('AXButton', 'Selected person', [], f.filterContainer);
      },
    ],
    [
      'nested chip control',
      (f) => {
        f.add('AXButton', 'Selected person', [], f.filter);
      },
    ],
    [
      'uncorroborated recipient text',
      (f) => {
        f.add('AXStaticText', 'Selected recipient', [], f.filter);
        f.frame.dmPagination.scope.filterText.push('Selected recipient');
      },
    ],
    [
      'Query overlay',
      (f) => {
        f.add('AXComboBox', 'Query', [], f.root);
      },
    ],
    [
      'row outside list',
      (f) => {
        f.rows[0].parent = f.side.index;
      },
    ],
    [
      'duplicate row ID',
      (f) => {
        f.rows[1].id = f.rows[0].id;
      },
    ],
    [
      'row ID suffix',
      (f) => {
        f.rows[0].id += '\n';
      },
    ],
    [
      'native IDs drift',
      (f) => {
        f.frame.dmPagination.dmIds = ['DOTHER'];
      },
    ],
    [
      'native rows drift',
      (f) => {
        f.frame.dmPagination.afterRowKeys = ['DOTHER'];
      },
    ],
    [
      'native scope drift',
      (f) => {
        f.frame.dmPagination.scope.filterValue = 'Other';
      },
    ],
    [
      'truncated',
      (f) => {
        f.frame.content.truncated = true;
      },
    ],
  ])('rejects %s without returning a listing', (_name, mutate) => {
    const f = fixture([person('DA'), group('CB')]);
    mutate(f);
    expect(() => read(f)).toThrow();
  });

  test('missing, empty and unsupported lists are not empty-directory proof', () => {
    expect(() => read(fixture([]))).toThrow('row identities');
    expect(() => read(fixture([{ ...person('DA'), unsupported: true }]))).toThrow(
      'No supported DM rows'
    );
    expect(() => read(fixture([{ ...person('CA'), kind: 'one-to-one' }]))).toThrow(
      'No supported DM rows'
    );
    expect(() => read(fixture([{ ...group('DA'), kind: 'group' }]))).toThrow(
      'No supported DM rows'
    );
  });
});

describe('DMs view collections', () => {
  test('deduplicates whole records in encounter order and recalculates name hints', () => {
    const a = fixture([person('DA', 'Same'), group('CB', 'Planning')]);
    const b = fixture([group('CB', 'Planning'), person('DC', 'Same'), group('GD', 'Planning')], {
      previous: ['DA', 'CB'],
    });
    b.frame.content.nodes
      .find((node) => node.classes.includes('p-activity_ia4_page__item--dms'))
      .classes.push('p-activity_ia4_page__item--unread--dm');
    const original = structuredClone([a.frame, b.frame]);
    const result = collectDMPages(batch([a, b]));
    expect(result.status).toBe('ok');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DA', 'CB', 'DC', 'GD']);
    expect(result.dms[1].unread).toBeNull();
    expect(result.dms[0].navigation).toBeNull();
    expect(result.dms[2].navigation).toBeNull();
    expect(result.dms[1].navigation.args[0]).toBe('group:CB');
    expect(result.pagination).toMatchObject({
      hasMore: null,
      nextCursor: null,
      capturedCount: 5,
      returnedCount: 4,
      scrollAttempts: 1,
      batch: { completedPages: 2, deduplicatedCount: 1 },
    });
    expect(result.coverage.source).toBe('dms-view');
    expect([a.frame, b.frame]).toEqual(original);
  });

  test('new unsupported row identities can advance a nonempty supported capture', () => {
    const a = fixture([person('DA')]);
    const b = fixture([person('DA'), { ...person('DUNKNOWN'), unsupported: true }], {
      previous: ['DA'],
    });
    const result = collectDMPages(batch([a, b]));
    expect(result.status).toBe('ok');
    expect(result.dms.length).toBe(1);
    expect(result.pagination.batch.deduplicatedCount).toBe(1);
  });

  test('no progress remains unknown coverage and stops once', () => {
    const a = fixture([person('DA')]);
    const b = fixture([person('DA')], { previous: ['DA'], noProgress: true });
    const result = collectDMPages(batch([a, b], { requestedPages: 10, stopReason: 'no-progress' }));
    expect(result.status).toBe('ok');
    expect(result.pagination).toMatchObject({
      hasMore: null,
      status: 'no-progress',
      batch: { completedPages: 2, requestedPages: 10 },
    });
    expect(result.coverage.complete).toBe(false);
  });

  test('pins the observed filter text even when query and rows still look valid', () => {
    const a = fixture([person('DA')], { filterValue: ' Alex ' });
    const b = fixture([person('DA'), person('DB')], {
      filterValue: ' Alex ',
      previous: ['DA'],
    });
    b.add('AXStaticText', 'Alex', [], b.filter);
    b.frame.dmPagination.scope.filterText.push('Alex');
    expect(read(b).dms.length).toBe(2);
    const result = collectDMPages(batch([a, b]));
    expect(result.status).toBe('partial');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DA']);
    expect(result.error).toContain('filters changed');
  });

  test('retains the prefix when contradictory recipient text appears later', () => {
    const a = fixture([person('DA')]);
    const b = fixture([person('DA'), person('DB')], { previous: ['DA'] });
    b.add('AXStaticText', 'Selected recipient', [], b.filter);
    b.frame.dmPagination.scope.filterText.push('Selected recipient');
    const result = collectDMPages(batch([a, b]));
    expect(result.status).toBe('partial');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DA']);
    expect(result.error).toContain('filter state');
  });

  test.each([
    [
      'mixed source',
      (f) => {
        f.frame.dmPagination.scope.source = 'sidebar';
      },
    ],
    [
      'process changed',
      (f) => {
        f.frame.pid = 43;
      },
    ],
    [
      'filter changed',
      (f) => {
        f.filter.stateValue = f.filter.AXValue = f.frame.dmPagination.scope.filterValue = 'Alex';
      },
    ],
    [
      'unread filter changed',
      (f) => {
        f.unread.stateValue = '1';
        f.frame.dmPagination.scope.unreadOnly = true;
      },
    ],
    [
      'edge lost',
      (f) => {
        f.frame.dmPagination.edgeKey = 'DOTHER';
      },
    ],
    [
      'previous rows changed',
      (f) => {
        f.frame.dmPagination.beforeRowKeys = ['DOTHER'];
      },
    ],
    [
      'name changed',
      (f) => {
        f.nodes.find((node) => node.label === 'Planning').label = 'Different';
      },
    ],
    [
      'false progress',
      (f) => {
        f.frame.dmPagination.status = 'no-progress';
      },
    ],
    [
      'extra scroll',
      (f) => {
        f.frame.dmPagination.scrollAttempts = 2;
      },
    ],
  ])('retains only the verified prefix when %s', (_name, mutate) => {
    const a = fixture([person('DA'), group('CB', 'Planning')]);
    const b = fixture([group('CB', 'Planning'), person('DC')], { previous: ['DA', 'CB'] });
    mutate(b);
    const result = collectDMPages(batch([a, b]));
    expect(result.status).toBe('partial');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DA', 'CB']);
    expect(result.pagination.batch.completedPages).toBe(1);
    expect(result.pagination.batch.stopReason).toBe('error');
    expect(result.error).toBeTruthy();
  });

  test('rejects reordering and new rows above the verified edge', () => {
    for (const rows of [
      [person('DA'), group('CB')],
      [person('DC'), person('DA')],
    ]) {
      const a = fixture([group('CB'), person('DA')]);
      const b = fixture(rows, { previous: ['CB', 'DA'] });
      expect(collectDMPages(batch([a, b])).status).toBe('partial');
    }
  });

  test('retains a native failure prefix and its attempted-page count', () => {
    const a = fixture([person('DA')]);
    const result = collectDMPages(
      batch([a], {
        requestedPages: 3,
        attemptedPages: 2,
        error: 'Foreground changed',
        stopReason: 'error',
      })
    );
    expect(result.status).toBe('partial');
    expect(result.pagination.batch).toMatchObject({
      completedPages: 1,
      attemptedPages: 2,
      stopReason: 'error',
    });
    expect(result.next).toContain('DMs view');
  });

  test('rejects a later old-ID conflict before accepting any records from that capture', () => {
    const a = fixture([person('DA', 'Alex'), group('CB')]);
    const b = fixture([group('CB'), person('DC')], { previous: ['DA', 'CB'] });
    const c = fixture([person('DC'), person('DNEW'), person('DA', 'Different')], {
      previous: ['CB', 'DC'],
    });
    const result = collectDMPages(batch([a, b, c]));
    expect(result.status).toBe('partial');
    expect(result.dms.map((dm) => dm.id)).toEqual(['DA', 'CB', 'DC']);
    expect(result.pagination.batch.completedPages).toBe(2);
    expect(result.error).toContain('conflicting names, kinds or participant labels');
  });

  test('rejects repeated DM kind drift without inventing self attribution', () => {
    const a = fixture([person('DA', 'Alex')]);
    const b = fixture([{ ...person('DA', 'Alex'), kind: 'self' }, person('DB')], {
      previous: ['DA'],
    });
    const result = collectDMPages(batch([a, b]));
    expect(result.status).toBe('partial');
    expect(result.dms[0].kind).toBe('one-to-one');
    expect(result.dms.length).toBe(1);
  });

  test('rejects an invalid first capture or budget instead of fabricating partial content', () => {
    const a = fixture([person('DA')]);
    a.tab.selected = false;
    expect(() => collectDMPages(batch([a]))).toThrow();
    const b = fixture([person('DA')]);
    expect(() => collectDMPages(batch([b], { requestedPages: 11 }))).toThrow('budget');
  });
});
