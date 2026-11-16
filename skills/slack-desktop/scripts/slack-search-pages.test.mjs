import { describe, expect, test } from 'bun:test';
import { collectSearchPages } from './slack-search-pages.mjs';
import { normalizeSearchQuery, validateSearchQueryTranslation } from './slack-search-query.mjs';

// Synthetic AX receipts only: no real workspace, query or message content.
const ts = (value) => `1700000000.${String(value).padStart(6, '0')}`;
const permalink = (value, channel = 'CDEMO', host = 'demo.slack.com') =>
  `https://${host}/archives/${channel}/p${ts(value).replace('.', '')}`;
const key = (value, channel = 'CDEMO', host = 'demo.slack.com') =>
  `${host}:${channel}:${ts(value)}`;

function frame({
  page = 1,
  pageCount = 3,
  ids = [3, 2, 1],
  query = 'example',
  empty = false,
  context = 'TDEMO',
  channel = 'CDEMO',
  host = 'demo.slack.com',
  directOwner = false,
} = {}) {
  const nodes = [];
  const add = (parent, role = 'AXGroup', classes = [], label = '', extra = {}) => {
    const index = nodes.length;
    nodes.push({ index, parent, role, classes, label, id: '', ...extra });
    return index;
  };
  const root = add(null, 'AXWebArea', [], 'Search - Test Workspace - Slack', {
    url: `https://app.slack.com/client/${context}/search`,
  });
  add(root, 'AXButton', [], `Search: ${query}`);
  const view = add(root, 'AXGroup', ['p-view_contents'], 'Search');
  const hider = directOwner ? view : add(view, 'AXGroup', ['c-scrollbar__hider']);
  const filters = add(hider, 'AXGroup', [], '', { id: 'filters-container' });
  const toolbar = add(filters, 'AXToolbar', [], 'Filter by');
  const sort = add(toolbar, 'AXPopUpButton', ['z-filter', 'a-filter'], 'Sort: Most relevant', {
    id: 'search-filter-sort-filter',
    stateValue: 'relevance',
    selected: null,
  });
  const scope = [
    {
      role: 'AXPopUpButton',
      id: nodes[sort].id,
      label: nodes[sort].label,
      value: nodes[sort].stateValue,
      selected: null,
      classes: ['a-filter', 'z-filter'],
    },
  ];
  let list = null;
  const timestamps = [],
    bodies = [];
  if (empty) {
    const container = add(hider, 'AXGroup', ['c-empty_state']);
    add(container, 'AXStaticText', [], 'Nothing turned up');
    add(
      container,
      'AXStaticText',
      [],
      'You may want to try using different keywords, checking for typos, or adjusting filters.'
    );
  } else {
    add(hider, 'AXStaticText', [], `${pageCount * 20} results`);
    list = add(hider, 'AXList', [], `Message results, page ${page} of ${pageCount}`);
    for (const [position, value] of ids.entries()) {
      const row = add(list, 'AXGroup', [], '', { id: `result-row-${position}` });
      const actions = add(row, 'AXGroup', ['c-message_kit__actions']);
      const header = add(actions, 'AXGroup', ['c-search_message__content_header']);
      add(header, 'AXButton', ['c-message__sender_button'], 'Sam Example');
      add(header, 'AXStaticText', [], 'project-help');
      timestamps.push(
        add(header, 'AXLink', ['c-timestamp'], 'Yesterday', {
          url: permalink(value, channel, host),
        })
      );
      const section = add(actions, 'AXGroup', ['p-rich_text_section']);
      bodies.push(add(section, 'AXStaticText', [], `Message ${value}`));
    }
  }
  const receipt = {
    operation: 'search',
    pid: 123,
    content: { nodes, observedAt: `2026-01-01T12:00:0${page}Z` },
    after: { nodes: [{ role: 'AXWebArea', label: nodes[root].label, url: nodes[root].url }] },
    searchPagination: {
      query,
      page: empty ? null : page,
      pageCount: empty ? null : pageCount,
      resultKeys: empty ? [] : ids.map((value) => key(value, channel, host)),
      nextPage: !empty && page < pageCount ? page + 1 : null,
      scope,
      pressAttempts: page === 1 ? 0 : 1,
      emptyResults: empty,
    },
  };
  return {
    receipt,
    nodes,
    root,
    view,
    hider,
    filters,
    toolbar,
    sort,
    list,
    timestamps,
    bodies,
    add,
  };
}

function envelope(frames, overrides = {}, batchOverrides = {}) {
  return {
    operation: 'search',
    pid: 123,
    status: 'ok',
    pages: frames.map((item) => item.receipt ?? item),
    batch: {
      requestedPages: Math.max(2, frames.length),
      attemptedPages: frames.length,
      completedPages: frames.length,
      direction: 'next',
      stopReason: 'page-limit',
      ...batchOverrides,
    },
    ...overrides,
  };
}

function addReset(f, focused = true) {
  const classes = [
    ...(focused ? ['c-button--focus-visible'] : []),
    'c-button-unstyled',
    'p-search_filter__reset_button',
  ];
  const index = f.add(f.toolbar, 'AXButton', classes, 'Reset', {
    stateValue: '',
    selected: false,
  });
  f.receipt.searchPagination.scope.unshift({
    role: 'AXButton',
    id: '',
    label: 'Reset',
    value: '',
    selected: false,
    classes: [...classes].sort(),
  });
  return index;
}

function addFeedback(f) {
  // Observed newer layout: toolbar, sort and feedback are direct siblings.
  f.nodes[f.sort].parent = f.filters;
  const index = f.add(f.filters, 'AXButton', ['c-link--button'], 'Give feedback', {
    stateValue: '',
    selected: false,
  });
  f.receipt.searchPagination.scope.unshift({
    role: 'AXButton',
    id: '',
    label: 'Give feedback',
    value: '',
    selected: false,
    classes: ['c-link--button'],
  });
  return index;
}

describe('search page collection', () => {
  test('accepts filters and results directly owned by the unique Search view', () => {
    for (const directOwner of [false, true]) {
      const first = frame({ directOwner });
      const second = frame({ directOwner, page: 2, ids: [6, 5, 4] });
      const result = collectSearchPages(envelope([first, second]), 'example');
      expect(result.messages.map((message) => message.text)).toEqual([
        'Message 3',
        'Message 2',
        'Message 1',
        'Message 6',
        'Message 5',
        'Message 4',
      ]);
      expect(result.coverage.complete).toBe(false);
      expect(result.pagination.batch.completedPages).toBe(2);
    }
  });

  test('direct Search ownership rejects split owners, duplicate views and lookalike containers', () => {
    const mutations = [
      (f) => {
        f.nodes[f.filters].parent = f.add(f.view, 'AXGroup', ['c-scrollbar__hider']);
      },
      (f) => {
        f.nodes[f.list].parent = f.add(f.view, 'AXGroup', ['c-scrollbar__hider']);
      },
      (f) => {
        f.add(f.root, 'AXGroup', ['p-view_contents'], 'Search');
      },
      (f) => {
        f.nodes[f.view].parent = f.add(f.root, 'AXGroup', ['p-view_contents'], 'Search');
      },
      (f) => {
        f.nodes[f.view].label = 'Conversation';
      },
      (f) => {
        f.nodes[f.view].classes = [];
      },
      (f) => {
        f.nodes[f.view].role = 'AXButton';
      },
      (f) => {
        const unverified = f.add(f.view, 'AXGroup', [], 'Search');
        f.nodes[f.filters].parent = unverified;
        f.nodes[f.list].parent = unverified;
      },
      (f) => {
        f.nodes[f.list].parent = f.root;
      },
    ];
    for (const mutate of mutations) {
      const f = frame({ directOwner: true });
      mutate(f);
      expect(() => collectSearchPages(envelope([f]), 'example')).toThrow();
    }
  });

  test('direct Search empty results remain bound to the verified owner', () => {
    const f = frame({ directOwner: true, empty: true });
    const input = envelope([f], {}, { stopReason: 'no-next-page' });
    expect(collectSearchPages(input, 'example').messages).toEqual([]);
    f.nodes.find((node) => node.classes.includes('c-empty_state')).parent = f.root;
    expect(() => collectSearchPages(input, 'example')).toThrow('Empty search state');
  });

  test('channel-pill spelling and passive feedback focus styling retain verified results', () => {
    const f = frame({ query: 'in:#general', pageCount: 1 });
    const feedback = addFeedback(f);
    f.nodes[feedback].classes.push('c-link--focus-visible');
    f.receipt.searchPagination.scope[0].classes.push('c-link--focus-visible');
    f.nodes.find((node) => node.label === 'Search: in:#general').label = 'Search: in:general';
    const input = envelope([f], {}, { stopReason: 'no-next-page' });
    expect(collectSearchPages(input, 'in:#general').status).toBe('ok');
    f.nodes.find((node) => node.label === 'Search: in:general').label = 'Search: in:other';
    expect(() => collectSearchPages(input, 'in:#general')).toThrow('query changed');
  });
  test('translated queries still require exact canonical source and page proof', () => {
    const requested = '😀',
      translation = normalizeSearchQuery(requested),
      query = translation.submittedQuery;
    const first = frame({ query, ids: [1, 2] }),
      second = frame({ query, page: 2, ids: [2, 3] });
    const input = envelope([first, second], { searchTranslation: translation });
    validateSearchQueryTranslation(input, requested);
    const collected = collectSearchPages(input, query);
    collected.searchTranslation = translation;
    expect(validateSearchQueryTranslation(collected, requested)).toBe(collected);
    expect(collected.search.query).toBe(query);
    expect(collected.pagination.batch.completedPages).toBe(2);
    expect(collected.messages.map((message) => message.permalink)).toEqual([
      permalink(1),
      permalink(2),
      permalink(3),
    ]);
    expect(() => collectSearchPages(input, requested)).toThrow();

    for (const field of ['source', 'native-page']) {
      const changed = structuredClone(input);
      if (field === 'source') changed.pages[1].content.nodes[1].label = `Search: ${requested}`;
      else changed.pages[1].searchPagination.query = requested;
      validateSearchQueryTranslation(changed, requested);
      const partial = collectSearchPages(changed, query);
      partial.searchTranslation = translation;
      expect(validateSearchQueryTranslation(partial, requested)).toBe(partial);
      expect(partial.status).toBe('partial');
      expect(partial.pagination.batch.completedPages).toBe(1);
      expect(partial.messages.map((message) => message.permalink)).toEqual([
        permalink(1),
        permalink(2),
      ]);
      expect(partial.error).toBeTruthy();
      const initialChanged = structuredClone(input);
      if (field === 'source')
        initialChanged.pages[0].content.nodes[1].label = `Search: ${requested}`;
      else initialChanged.pages[0].searchPagination.query = requested;
      expect(() => collectSearchPages(initialChanged, query)).toThrow();
    }
  });

  test('retains the observed passive Give feedback control across verified pages', () => {
    const first = frame(),
      second = frame({ page: 2, ids: [4] });
    addFeedback(first);
    addFeedback(second);
    const input = envelope([first, second]);
    const before = structuredClone(input);
    const result = collectSearchPages(input, 'example');
    expect(result.status).toBe('ok');
    expect(result.pagination.batch.completedPages).toBe(2);
    expect(input).toEqual(before);
    expect(input.pages[0].searchPagination.scope[0]).toEqual({
      role: 'AXButton',
      id: '',
      label: 'Give feedback',
      value: '',
      selected: false,
      classes: ['c-link--button'],
    });
  });

  test('distinct idless Reset and Give feedback controls coexist in deterministic label order', () => {
    const first = frame(),
      second = frame({ page: 2, ids: [4] });
    for (const f of [first, second]) {
      addReset(f);
      addFeedback(f);
    }
    const last = second.nodes.length - 1;
    [second.nodes[last - 1], second.nodes[last]] = [second.nodes[last], second.nodes[last - 1]];
    const input = envelope([first, second]);
    const before = structuredClone(input);
    expect(collectSearchPages(input, 'example').status).toBe('ok');
    expect(input).toEqual(before);
    expect(
      first.receipt.searchPagination.scope
        .filter((node) => node.id === '')
        .map((node) => node.label)
    ).toEqual(['Give feedback', 'Reset']);
    first.receipt.searchPagination.scope.reverse();
    expect(() => collectSearchPages(envelope([first]), 'example')).toThrow('semantic filter state');
  });

  test('the observed feedback scope also verifies a genuinely empty result view', () => {
    const f = frame({ empty: true });
    addFeedback(f);
    const result = collectSearchPages(envelope([f], {}, { stopReason: 'no-next-page' }), 'example');
    expect(result.status).toBe('ok');
    expect(result.messages).toEqual([]);
  });

  test('rejects malformed or ambiguous passive Give feedback controls', () => {
    const changes = [
      (f, index) => {
        f.nodes[index].role = 'AXCheckBox';
      },
      (f, index) => {
        f.nodes[index].label = 'Give feedback now';
      },
      (f, index) => {
        f.nodes[index].parent = f.toolbar;
      },
      (f, index) => {
        f.nodes[index].parent = f.add(f.filters);
      },
      (f) => {
        f.nodes[f.toolbar].parent = f.add(f.filters);
      },
      (f) => {
        f.nodes[f.sort].parent = f.toolbar;
      },
      (f) => {
        f.nodes[f.sort].role = 'AXButton';
      },
      (f) => {
        f.add(f.filters, 'AXToolbar', [], 'Filter by');
      },
      (f, index) => {
        f.add(index, 'AXStaticText', [], 'Give feedback');
      },
      (f, index) => {
        f.nodes[index].url = 'https://example.com/feedback';
      },
      (f, index) => {
        f.nodes[index].stateValue = null;
      },
      (f, index) => {
        f.nodes[index].stateValue = 'enabled';
      },
      (f, index) => {
        f.nodes[index].selected = true;
      },
      (f, index) => {
        f.nodes[index].selected = null;
      },
      (f, index) => {
        delete f.nodes[index].selected;
      },
      (f, index) => {
        f.nodes[index].classes = [];
      },
      (f, index) => {
        f.nodes[index].classes.push('unknown');
      },
      (f, index) => {
        f.nodes[index].classes.push('c-link--button');
      },
      (f) => {
        addFeedback(f);
      },
      (f) => {
        addReset(f);
        addReset(f);
      },
      (f) => {
        f.nodes[f.sort].id = '';
      },
      (f) => {
        f.add(f.filters, 'AXPopUpButton', [], 'Duplicate sort', {
          id: 'search-filter-sort-filter',
          stateValue: '',
          selected: false,
        });
      },
      (f) => {
        f.add(f.filters, 'AXGroup', [], 'Untyped duplicate sort', {
          id: 'search-filter-sort-filter',
        });
      },
      (f) => {
        f.add(f.filters, 'AXButton', [], 'Other', { stateValue: '', selected: false });
      },
      (f) => {
        for (const label of ['First filter', 'Second filter'])
          f.add(f.toolbar, 'AXButton', [], label, {
            id: 'duplicate-filter',
            stateValue: '',
            selected: false,
          });
      },
    ];
    for (const change of changes) {
      const f = frame();
      const index = addFeedback(f);
      change(f, index);
      expect(() => collectSearchPages(envelope([f]), 'example')).toThrow(/filter/);
    }
  });

  test('scope receipts cannot invent, omit or modify the passive control evidence', () => {
    for (const forge of [
      (scope) => {
        scope[0].id = 'invented-feedback-id';
      },
      (scope) => {
        scope[0].label = 'Feedback';
      },
      (scope) => {
        scope[0].value = null;
      },
      (scope) => {
        scope[0].selected = true;
      },
      (scope) => {
        scope[0].classes = ['other'];
      },
      (scope) => {
        scope.shift();
      },
    ]) {
      const f = frame();
      addFeedback(f);
      forge(f.receipt.searchPagination.scope);
      expect(() => collectSearchPages(envelope([f]), 'example')).toThrow('semantic filter state');
    }
    const withoutControl = frame();
    addFeedback(withoutControl);
    withoutControl.nodes.pop();
    expect(() => collectSearchPages(envelope([withoutControl]), 'example')).toThrow(
      'semantic filter state'
    );
  });

  test('feedback and ordinary filter changes preserve only the verified page prefix', () => {
    for (const change of [
      (f) => {
        f.nodes.pop();
        f.receipt.searchPagination.scope.shift();
      },
      (f) => {
        addReset(f);
        f.receipt.searchPagination.scope = [
          f.receipt.searchPagination.scope[1],
          f.receipt.searchPagination.scope[0],
          ...f.receipt.searchPagination.scope.slice(2),
        ];
      },
      (f) => {
        f.nodes[f.sort].stateValue = 'recent';
        f.receipt.searchPagination.scope[1].value = 'recent';
      },
      (f) => {
        f.nodes.at(-1).selected = true;
        f.receipt.searchPagination.scope[0].selected = true;
      },
    ]) {
      const first = frame(),
        second = frame({ page: 2, ids: [4] });
      addFeedback(first);
      addFeedback(second);
      change(second);
      const result = collectSearchPages(envelope([first, second]), 'example');
      expect(result.status).toBe('partial');
      expect(result.pagination.batch.completedPages).toBe(1);
      expect(result.messages.map((message) => message.text)).toEqual([
        'Message 3',
        'Message 2',
        'Message 1',
      ]);
      expect(result.pagination.nextPage).toBeNull();
    }
    const first = frame(),
      second = frame({ page: 2, ids: [4] });
    first.nodes[first.sort].parent = first.filters;
    addFeedback(second);
    const added = collectSearchPages(envelope([first, second]), 'example');
    expect(added.status).toBe('partial');
    expect(added.pagination.batch.completedPages).toBe(1);
    expect(added.messages.map((message) => message.text)).toEqual([
      'Message 3',
      'Message 2',
      'Message 1',
    ]);
    expect(added.error).toContain('filters');
  });

  test('retains the exact idless Reset control in the verified filter scope across pages', () => {
    const first = frame(),
      second = frame({ page: 2, ids: [4] });
    addReset(first);
    addReset(second);
    const input = envelope([first, second]);
    const before = structuredClone(input);
    const result = collectSearchPages(input, 'example');
    expect(result.status).toBe('ok');
    expect(result.pagination.batch.completedPages).toBe(2);
    expect(input).toEqual(before);
    expect(input.pages[0].searchPagination.scope[0].id).toBe('');
    first.receipt.searchPagination.scope[0].id = 'invented-reset-id';
    expect(() => collectSearchPages(envelope([first]), 'example')).toThrow('semantic filter state');
  });

  test.each([false, true])(
    'retains exact Reset classes across deduplicated result pages with focus-visible=%s',
    (focused) => {
      const first = frame(),
        second = frame({ page: 2, ids: [2, 4] });
      for (const f of [first, second]) {
        const index = addReset(f, focused);
        f.nodes[index].classes.reverse();
        addFeedback(f);
      }
      const input = envelope([first, second]);
      const before = structuredClone(input);
      const result = collectSearchPages(input, 'example');
      expect(result.status).toBe('ok');
      expect(result.messages).toHaveLength(4);
      expect(result.pagination.batch.completedPages).toBe(2);
      expect(input).toEqual(before);
      expect(
        input.pages[0].searchPagination.scope.find((node) => node.label === 'Reset').classes
      ).toEqual(
        focused
          ? ['c-button--focus-visible', 'c-button-unstyled', 'p-search_filter__reset_button']
          : ['c-button-unstyled', 'p-search_filter__reset_button']
      );
    }
  );

  test.each([false, true])(
    'verifies empty results with exact Reset and feedback controls with focus-visible=%s',
    (focused) => {
      const f = frame({ empty: true });
      addReset(f, focused);
      addFeedback(f);
      const result = collectSearchPages(
        envelope([f], {}, { stopReason: 'no-next-page' }),
        'example'
      );
      expect(result.status).toBe('ok');
      expect(result.messages).toEqual([]);
      expect(result.pagination.batch.completedPages).toBe(1);
    }
  );

  test.each([
    [false, true],
    [true, false],
  ])(
    'Reset focus-visible drift from %s to %s retains only the verified page prefix',
    (beforeFocus, afterFocus) => {
      const first = frame(),
        second = frame({ page: 2, ids: [4] });
      addReset(first, beforeFocus);
      addReset(second, afterFocus);
      const result = collectSearchPages(envelope([first, second]), 'example');
      expect(result.status).toBe('partial');
      expect(result.pagination.batch.completedPages).toBe(1);
      expect(result.messages).toHaveLength(3);
      expect(result.error).toContain('filters');
    }
  );

  test.each([false, true])(
    'Reset receipt must retain the actual focus-visible=%s class set',
    (focused) => {
      const f = frame();
      addReset(f, focused);
      f.receipt.searchPagination.scope[0].classes = focused
        ? ['c-button-unstyled', 'p-search_filter__reset_button']
        : ['c-button--focus-visible', 'c-button-unstyled', 'p-search_filter__reset_button'];
      expect(() => collectSearchPages(envelope([f]), 'example')).toThrow('semantic filter state');
    }
  );

  test('distinct Reset class variants do not disguise duplicate idless controls', () => {
    const f = frame();
    addReset(f, false);
    addReset(f, true);
    expect(() => collectSearchPages(envelope([f]), 'example')).toThrow(/filter/);
  });

  test('rejects malformed or ambiguous idless Reset controls', () => {
    const changes = [
      (f, index) => {
        f.nodes[index].role = 'AXCheckBox';
      },
      (f, index) => {
        f.nodes[index].label = 'Reset all';
      },
      (f, index) => {
        f.nodes[index].parent = f.filters;
      },
      (f, index) => {
        f.nodes[index].parent = f.add(f.toolbar);
      },
      (f) => {
        f.nodes[f.toolbar].parent = f.add(f.filters);
      },
      (f, index) => {
        f.add(index, 'AXStaticText', [], 'Reset');
      },
      (f, index) => {
        f.nodes[index].url = 'https://example.com/';
      },
      (f, index) => {
        f.nodes[index].stateValue = null;
      },
      (f, index) => {
        f.nodes[index].selected = true;
      },
      (f, index) => {
        f.nodes[index].selected = null;
      },
      (f, index) => {
        delete f.nodes[index].stateValue;
      },
      (f, index) => {
        delete f.nodes[index].selected;
      },
      (f, index) => {
        f.nodes[index].classes = ['c-button--focus-visible', 'p-search_filter__reset_button'];
      },
      (f, index) => {
        f.nodes[index].classes = ['c-button--focus-visible', 'c-button-unstyled'];
      },
      (f, index) => {
        f.nodes[index].classes.push('c-button--focus-visible', 'c-button--focus-visible');
      },
      (f, index) => {
        f.nodes[index].classes.pop();
      },
      (f, index) => {
        f.nodes[index].classes.push('unknown-class');
      },
      (f, index) => {
        f.nodes[index].classes[0] = f.nodes[index].classes[1];
      },
      (f) => {
        addReset(f);
      },
      (f) => {
        f.nodes[f.sort].id = '';
      },
    ];
    for (const focused of [false, true]) {
      for (const change of changes) {
        const f = frame();
        const index = addReset(f, focused);
        change(f, index);
        expect(() => collectSearchPages(envelope([f]), 'example')).toThrow(/filter/);
      }
    }
  });

  test('accepts native sorted dictionary keys without changing array or result order', () => {
    const sorted = (value) => {
      if (Array.isArray(value)) return value.map(sorted);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])])
        );
      return value;
    };
    const input = sorted(envelope([frame({ ids: [3, 1] }), frame({ page: 2, ids: [2] })]));
    expect(collectSearchPages(input, 'example').messages.map((message) => message.text)).toEqual([
      'Message 3',
      'Message 1',
      'Message 2',
    ]);
    input.pages[1].searchPagination.resultKeys = [key(7)];
    const changed = collectSearchPages(input, 'example');
    expect(changed.status).toBe('partial');
    expect(changed.pagination.batch.completedPages).toBe(1);
  });

  test('collects ranked matches with canonical cross-page dedup and first whole-record metadata', () => {
    const first = frame(),
      second = frame({ page: 2, ids: [2, 4, 1] }),
      third = frame({ page: 3, ids: [5, 4] });
    second.nodes[second.bodies[0]].label = 'Changed duplicate content';
    second.nodes[second.timestamps[0]].url += '?thread_ts=1700000000.000000&cid=CDEMO';
    const input = envelope([first, second, third], {}, { stopReason: 'no-next-page' });
    const snapshot = structuredClone(input);
    const result = collectSearchPages(input, 'example');
    expect(result.messages.map((message) => message.text)).toEqual([
      'Message 3',
      'Message 2',
      'Message 1',
      'Message 4',
      'Message 5',
    ]);
    expect(result.messages[1].permalink).toBe(permalink(2));
    expect(result.search).toMatchObject({
      query: 'example',
      firstPage: 1,
      lastPage: 3,
      page: 3,
      pageCount: 3,
    });
    expect(result.pagination).toMatchObject({
      supported: true,
      direction: 'next',
      hasMore: false,
      nextPage: null,
      capturedCount: 8,
      returnedCount: 5,
      pressAttempts: 2,
      batch: { completedPages: 3, stopReason: 'no-next-page', deduplicatedCount: 3 },
    });
    expect(result.coverage).toMatchObject({ complete: false, capturedCount: 8, observedCount: 5 });
    expect(
      result.messages.every((message) => message.snippet && message.textComplete === false)
    ).toBe(true);
    expect(input).toEqual(snapshot);
  });

  test('search collections retain media references and the first whole metadata observation', () => {
    const first = frame({ ids: [1, 2] }),
      second = frame({ page: 2, ids: [1, 3] });
    const addVideo = (f, index, label) => {
      const section = f.nodes[f.bodies[index]].parent;
      const actions = f.nodes[section].parent;
      const video = f.add(actions, 'AXGroup', ['p-video_message_file']);
      const overlay = f.add(video, 'AXGroup', ['p-video_controls_overlay'], label);
      f.add(
        overlay,
        'AXCheckBox',
        ['p-video_controls_overlay__controls__pill'],
        'Play, 25 seconds'
      );
      f.add(overlay, 'AXButton', [], 'View transcript');
    };
    addVideo(first, 0, 'First clip');
    addVideo(second, 0, 'Renamed clip in later capture');
    addVideo(second, 1, 'Another clip');
    const result = collectSearchPages(envelope([first, second]), 'example');
    expect(result.messages.map((m) => m.permalink)).toEqual([
      permalink(1),
      permalink(2),
      permalink(3),
    ]);
    expect(result.messages[0].attachments[0]).toMatchObject({
      label: 'First clip',
      kind: 'video',
      ref: `CDEMO:${ts(1)}/m1`,
      referenceScope: 'message-media',
      transcript: { state: 'available' },
      contentRead: false,
    });
    expect(result.messages[2].attachments[0].ref).toBe(`CDEMO:${ts(3)}/m1`);
    expect(result.messages[0].text).toBe('Message 1');
    expect(result.pagination.batch.deduplicatedCount).toBe(1);
  });

  test('deduplicates repeated rows within one page without collapsing different identities sharing text', () => {
    const first = frame({ ids: [3, 3, 2] }),
      second = frame({ page: 2, ids: [1] });
    for (const current of [first, second])
      for (const node of current.bodies) current.nodes[node].label = 'Same text';
    const result = collectSearchPages(envelope([first, second]), 'example');
    expect(result.messages.map((message) => message.permalink)).toEqual([
      permalink(3),
      permalink(2),
      permalink(1),
    ]);
    expect(result.pagination.batch.deduplicatedCount).toBe(1);
  });

  test('conversation and host participate in canonical match identity', () => {
    const result = collectSearchPages(
      envelope(
        [
          frame({ ids: [1] }),
          frame({ page: 2, ids: [1], channel: 'DOTHER' }),
          frame({ page: 3, ids: [1], host: 'other.slack.com' }),
        ],
        {},
        { stopReason: 'no-next-page' }
      ),
      'example'
    );
    expect(result.messages).toHaveLength(3);
    expect(result.pagination.batch.deduplicatedCount).toBe(0);
  });

  test('requires canonical observed permalinks rather than arbitrary DOM IDs', () => {
    for (const invalid of [
      null,
      'https://demo.slack.com/archives/CDEMO/p123',
      'https://evil.example/archives/CDEMO/p1700000000000003',
      `${permalink(3)}#`,
      `${permalink(3)}#part`,
      permalink(3).replace('https://', 'https://user@'),
      permalink(3).replace('slack.com/', 'slack.com:8443/'),
      `${permalink(3)}?cid=COTHER`,
      `${permalink(3)}?cid=CDEMO&cid=CDEMO`,
      `${permalink(3)}?thread_ts=bad`,
      `${permalink(3)}?thread_ts=${ts(0)}&thread_ts=${ts(0)}`,
    ]) {
      const first = frame();
      first.nodes[first.timestamps[0]].url = invalid;
      expect(() =>
        collectSearchPages(envelope([first], {}, { requestedPages: 2 }), 'example')
      ).toThrow();
    }
  });

  test('rejects native result-key disagreement, incomplete counts and oversized first pages', () => {
    const first = frame();
    first.receipt.searchPagination.resultKeys.reverse();
    expect(() => collectSearchPages(envelope([first]), 'example')).toThrow('identities differ');
    for (const [page, pageCount] of [
      [0, 3],
      [2, 3],
      [1, 0],
      [1, 1.5],
      [1, Number.MAX_SAFE_INTEGER + 1],
    ]) {
      const invalid = frame({ page, pageCount });
      invalid.receipt.searchPagination.pressAttempts = 0;
      expect(() => collectSearchPages(envelope([invalid]), 'example')).toThrow();
    }
    expect(() =>
      collectSearchPages(
        envelope([frame({ ids: Array.from({ length: 101 }, (_, i) => i + 1) })]),
        'example'
      )
    ).toThrow('bounded result count');
  });

  test('validates scope independently against raw filter nodes', () => {
    for (const mutation of ['value', 'selected', 'classes', 'label', 'missing']) {
      const first = frame();
      if (mutation === 'missing') delete first.nodes[first.sort].stateValue;
      else
        first.nodes[first.sort][mutation === 'value' ? 'stateValue' : mutation] =
          mutation === 'classes' ? ['changed'] : mutation === 'selected' ? true : 'changed';
      expect(() => collectSearchPages(envelope([first]), 'example')).toThrow(/filter state/);
    }
  });

  test('requires unique scoped filter controls in the same Search results container', () => {
    for (const mutation of [
      'missing-sort',
      'duplicate-id',
      'foreign-list',
      'wrong-view',
      'missing-toolbar',
    ]) {
      const first = frame();
      if (mutation === 'missing-sort') first.nodes[first.sort].id = 'another-control';
      if (mutation === 'duplicate-id')
        first.add(first.toolbar, 'AXButton', [], 'Duplicate', {
          id: 'search-filter-sort-filter',
          stateValue: null,
          selected: null,
        });
      if (mutation === 'foreign-list') first.nodes[first.list].parent = first.root;
      if (mutation === 'wrong-view') first.nodes[first.view].label = 'Conversation';
      if (mutation === 'missing-toolbar') first.nodes[first.toolbar].role = 'AXGroup';
      expect(() => collectSearchPages(envelope([first]), 'example')).toThrow();
    }
  });

  test('retains only a verified prefix for later query, workspace, filter, count, process or operation drift', () => {
    for (const mutation of ['query', 'workspace', 'filter', 'page-count', 'pid', 'operation']) {
      const first = frame(),
        second = frame({ page: 2, ids: [4] });
      if (mutation === 'query') second.nodes[1].label = 'Search: changed';
      if (mutation === 'workspace') {
        second.nodes[second.root].url = 'https://app.slack.com/client/TOTHER/search';
        second.receipt.after.nodes[0].url = second.nodes[second.root].url;
      }
      if (mutation === 'filter') {
        second.nodes[second.sort].stateValue = 'newest';
        second.receipt.searchPagination.scope[0].value = 'newest';
      }
      if (mutation === 'page-count') {
        second.nodes[second.list].label = 'Message results, page 2 of 4';
        second.receipt.searchPagination.pageCount = 4;
      }
      if (mutation === 'pid') second.receipt.pid++;
      if (mutation === 'operation') second.receipt.operation = 'read-channel';
      const result = collectSearchPages(envelope([first, second]), 'example');
      expect(result.status).toBe('partial');
      expect(result.messages).toHaveLength(3);
      expect(result.pagination).toMatchObject({
        nextPage: null,
        hasMore: null,
        batch: { completedPages: 1, stopReason: 'error' },
      });
      expect(result.error).toBeTruthy();
    }
  });

  test('rejects a skipped page, wrong action count, exhausted continuation or unchanged result body', () => {
    for (const mutation of ['skipped', 'press', 'ended', 'identical']) {
      const first = frame({ pageCount: mutation === 'ended' ? 1 : 3 });
      const second = frame({
        page: mutation === 'skipped' ? 3 : 2,
        ids: mutation === 'identical' ? [3, 2, 1] : [4],
      });
      if (mutation === 'press') second.receipt.searchPagination.pressAttempts = 0;
      const result = collectSearchPages(envelope([first, second]), 'example');
      expect(result.status).toBe('partial');
      expect(result.messages).toHaveLength(3);
      expect(result.pagination.batch.completedPages).toBe(1);
    }
  });

  test('a newly numbered all-seen page stops no-progress without repeating matches', () => {
    const first = frame(),
      second = frame({ page: 2, ids: [1, 2, 3] });
    const result = collectSearchPages(
      envelope([first, second], {}, { requestedPages: 5, stopReason: 'no-progress' }),
      'example'
    );
    expect(result.status).toBe('ok');
    expect(result.messages).toHaveLength(3);
    expect(result.pagination).toMatchObject({
      nextPage: null,
      hasMore: true,
      batch: { completedPages: 2, stopReason: 'no-progress', deduplicatedCount: 3 },
    });
    const continued = collectSearchPages(
      envelope([first, second, frame({ page: 3, ids: [4] })]),
      'example'
    );
    expect(continued.status).toBe('partial');
    expect(continued.pagination.batch.completedPages).toBe(2);
    expect(continued.messages).toHaveLength(3);
  });

  test('explicit empty search returns one verified empty frame and no-next-page', () => {
    const result = collectSearchPages(
      envelope([frame({ empty: true })], {}, { requestedPages: 5, stopReason: 'no-next-page' }),
      'example'
    );
    expect(result.status).toBe('ok');
    expect(result.messages).toEqual([]);
    expect(result.search).toMatchObject({
      totalResults: 0,
      page: null,
      pageCount: null,
      firstPage: null,
      lastPage: null,
    });
    expect(result.pagination).toMatchObject({
      hasMore: false,
      nextPage: null,
      capturedCount: 0,
      returnedCount: 0,
    });
    const missing = frame({ empty: true });
    missing.nodes.find((node) => node.label === 'Nothing turned up').label = 'Loading';
    expect(() => collectSearchPages(envelope([missing]), 'example')).toThrow('not exposed');
  });

  test('empty collections retain both exact observed guidance variants and scoped feedback', () => {
    for (const guidance of [
      'You may want to try using different keywords, checking for typos, or adjusting filters.',
      'You may want to try using different keywords, checking for typos or adjusting filters.',
    ]) {
      const f = frame({ empty: true });
      f.nodes.find((node) => node.label.startsWith('You may want')).label = guidance;
      addFeedback(f);
      const input = envelope([f], {}, { requestedPages: 5, stopReason: 'no-next-page' });
      const result = collectSearchPages(input, 'example');
      expect(result.status).toBe('ok');
      expect(result.messages).toEqual([]);
      expect(result.search.totalResults).toBe(0);
      expect(result.pagination).toMatchObject({
        nextPage: null,
        hasMore: false,
        returnedCount: 0,
        batch: { completedPages: 1, stopReason: 'no-next-page' },
      });
      f.add(f.hider, 'AXList', [], 'Message results, page 1 of 1');
      expect(() => collectSearchPages(input, 'example')).toThrow('Empty search');
    }
  });

  test('empty collections reject changed wording, container ownership and query', () => {
    for (const change of [
      (f) => {
        f.nodes.find((node) => node.label.startsWith('You may want')).label =
          'You may want to try using different keywords, checking for typos or adjusting filters!';
      },
      (f) => {
        f.nodes.find((node) => node.label.startsWith('You may want')).label =
          'You may want to try using different keywords, checking for errors or adjusting filters.';
      },
      (f) => {
        f.nodes.find((node) => node.classes.includes('c-empty_state')).parent = f.root;
      },
      (f) => {
        f.nodes.find((node) => node.label === 'Search: example').label = 'Search: other';
      },
    ]) {
      const f = frame({ empty: true });
      f.nodes.find((node) => node.label.startsWith('You may want')).label =
        'You may want to try using different keywords, checking for typos or adjusting filters.';
      change(f);
      expect(() =>
        collectSearchPages(envelope([f], {}, { stopReason: 'no-next-page' }), 'example')
      ).toThrow();
    }
  });

  test('native later failures retain matches with attempted and verified counts distinguished', () => {
    for (const stopReason of ['error', 'time-limit']) {
      const result = collectSearchPages(
        envelope(
          [frame()],
          { status: 'partial', error: 'Guard stopped input' },
          {
            requestedPages: 5,
            attemptedPages: stopReason === 'error' ? 2 : 1,
            stopReason,
          }
        ),
        'example'
      );
      expect(result.status).toBe('partial');
      expect(result.error).toBe('Guard stopped input');
      expect(result.messages).toHaveLength(3);
      expect(result.pagination).toMatchObject({
        nextPage: null,
        hasMore: null,
        batch: { completedPages: 1, stopReason },
      });
      expect(result.coverage.complete).toBe(false);
    }
  });

  test('malformed batch budgets fail before collecting and dishonest terminal reasons become partial', () => {
    for (const changes of [
      { requestedPages: 1 },
      { requestedPages: 11 },
      { attemptedPages: 0 },
      { attemptedPages: 3 },
      { completedPages: 0 },
      { direction: 'older' },
      { stopReason: 'complete' },
    ])
      expect(() => collectSearchPages(envelope([frame()], {}, changes), 'example')).toThrow(
        'budget or counts'
      );
    for (const stopReason of ['no-progress', 'no-next-page', 'page-limit', 'error', 'time-limit']) {
      const result = collectSearchPages(
        envelope([frame()], {}, { requestedPages: 3, stopReason }),
        'example'
      );
      expect(result.status).toBe('partial');
      expect(result.messages).toHaveLength(3);
      expect(result.pagination.nextPage).toBeNull();
    }
  });
});
