import { describe, expect, test } from 'bun:test';
import { collectDMSearchPages } from './slack-dm-search.mjs';
import { applyDMFilter } from './slack-output.mjs';
import { formatOutput } from './slack-format.mjs';
import { applyWorkspaceScope } from './slack-workspace-scope.mjs';

const person = (index, name = 'Alex Example', handle = 'alex.example') => ({
  key: `option:${index}`,
  kind: 'person',
  name,
  handle,
});
const group = (index, name = 'Project planning') => ({
  key: `option:${index}`,
  kind: 'group',
  name,
  handle: null,
});
const page = (matches, query = 'Alex') => ({
  scope: {
    source: 'dms-search-autocomplete',
    url: 'https://app.slack.com/client/TDEMO/dms',
    workspaceName: 'Demo',
    query,
    unreadOnly: true,
  },
  matches,
  empty: matches.length === 0,
});
function receipt(pages, options = {}) {
  return {
    operation: 'dms',
    status: options.error ? 'partial' : 'ok',
    pid: 42,
    dmSearch: { requested: pages[0]?.scope.query ?? 'Alex', verified: true },
    searchPages: pages,
    batch: {
      requestedPages: options.requestedPages ?? pages.length,
      collectedPages: pages.length,
      attemptedPages: options.attemptedPages ?? pages.length,
      stopReason: options.stopReason ?? (pages[0]?.empty ? 'empty-results' : 'requested-pages'),
    },
    ...(options.error ? { error: options.error } : {}),
    desktopSamples: [{ foregroundPid: 50, cursor: [10, 20] }],
  };
}

describe('DMs autocomplete collection', () => {
  test.each(['TDEMO', 'EDEMO'])(
    'preserves the verified %s client identity for scoped results and follow-up hints',
    (contextId) => {
      const captured = page([person(0)]);
      captured.scope.url = `https://app.slack.com/client/${contextId}/dms`;
      const result = collectDMSearchPages(receipt([captured]), 'Alex');
      const workspace = {
        name: 'Demo',
        contextId,
        id: contextId.startsWith('T') ? contextId : null,
        domain: 'demo.slack.com',
        ref: 'workspace:demo.slack.com',
      };
      expect(result.workspace).toEqual({ name: 'Demo', contextId, id: workspace.id });
      const selected = {
        operation: 'switch-workspace',
        status: 'ok',
        requested: workspace.ref,
        workspace,
        switch: { to: workspace, changed: false },
        workspaceSwitchMayHaveBeenRequested: false,
      };
      const scoped = applyWorkspaceScope(result, selected);
      expect(scoped.workspace.contextId).toBe(contextId);
      expect(scoped.dms[0].navigation.args).toEqual([
        '@alex.example',
        '--workspace=workspace:demo.slack.com',
      ]);
      expect(() =>
        applyWorkspaceScope(result, {
          ...selected,
          workspace: { ...workspace, contextId: 'TOTHER', id: 'TOTHER' },
          switch: { to: { ...workspace, contextId: 'TOTHER', id: 'TOTHER' }, changed: false },
        })
      ).toThrow('differs from the selected workspace');
    }
  );

  test('rejects malformed client context IDs before creating scoped identity', () => {
    for (const context of [
      'DEMO',
      'ADEMO',
      '1234',
      'T',
      'E',
      'tdemo',
      'T%44EMO',
      `T${'A'.repeat(64)}`,
    ]) {
      const captured = page([person(0)]);
      captured.scope.url = `https://app.slack.com/client/${context}/dms`;
      expect(() => collectDMSearchPages(receipt([captured]), 'Alex')).toThrow('scope is invalid');
    }
  });

  test('keeps unknown conversation identity explicit and offers only verified lookup hints', () => {
    const input = receipt([page([person(0), group(1), person(2, 'Unknown handle', null)])]);
    const result = collectDMSearchPages(input, 'Alex');
    expect(result.requested).toBeNull();
    expect(result.coverage.source).toBe('dms-search-autocomplete');
    expect(result.coverage.filters).toEqual({ query: 'Alex' });
    expect(result.coverage.controls).toEqual({ unreadOnly: true, appliesToSearch: null });
    expect(result.dms.map((dm) => [dm.id, dm.kind, dm.existence])).toEqual([
      [null, 'person', 'unknown'],
      [null, 'group', 'unknown'],
      [null, 'person', 'unknown'],
    ]);
    expect(result.dms.map((dm) => dm.navigation)).toEqual([
      { command: 'read-dm', args: ['@alex.example'] },
      { command: 'read-dm', args: ['group-name:Project planning', '--allow-clipboard'] },
      null,
    ]);
    const text = formatOutput(result);
    expect(text).toContain('Slack DMs search matches');
    expect(text).toContain("read-dm --allow-clipboard 'group-name:Project planning'");
    expect(text).toContain('read-dm @alex.example');
    expect(text).toContain('its effect on suggestions is not verified');
    expect(text).not.toContain('Filters: unread only');
    expect(JSON.parse(formatOutput(result, 'json')).dms[0].id).toBeNull();
    expect(JSON.parse(formatOutput(result, 'full-json', input))).toEqual(input);
  });

  test('binds caller query, budgets and native completion without using local name matching', () => {
    const input = receipt([page([group(1, 'Title without requested text')], ' Alex ')]);
    expect(collectDMSearchPages(input, ' Alex ').dms).toHaveLength(1);
    expect(() => collectDMSearchPages(input, 'Alex')).toThrow('verification');
    expect(() => collectDMSearchPages(input, ' Alex ', 2)).toThrow('budget');
    for (const mutate of [
      (x) => {
        delete x.dmSearch;
      },
      (x) => {
        x.dmSearch.verified = false;
      },
      (x) => {
        x.operation = 'inspect';
      },
      (x) => {
        x.searchPages[0].scope.query = 'Other';
      },
      (x) => {
        x.searchPages[0].scope.url += '?query=Alex';
      },
      (x) => {
        x.searchPages[0].scope.url = 'https://app.slack.com:444/client/TDEMO/dms';
      },
      (x) => {
        x.searchPages[0].scope.source = 'dms-view';
      },
      (x) => {
        x.searchPages[0].scope.unreadOnly = null;
      },
    ]) {
      const altered = structuredClone(input);
      mutate(altered);
      expect(() => collectDMSearchPages(altered, ' Alex ')).toThrow();
    }
  });

  test('deduplicates only repeated option keys and computes ambiguity before local filtering', () => {
    const first = page([person(0), group(1, 'Same group')]);
    const second = page([
      group(1, 'Same group'),
      group(2, 'Same group'),
      person(3, 'Casey', 'casey'),
    ]);
    const result = collectDMSearchPages(receipt([first, second]), 'Alex', 2);
    expect(result.dms.map((dm) => dm.suggestionKey)).toEqual([
      'option:0',
      'option:1',
      'option:2',
      'option:3',
    ]);
    expect(
      result.dms.filter((dm) => dm.kind === 'group').every((dm) => dm.navigation === null)
    ).toBe(true);
    expect(result.pagination).toMatchObject({ capturedCount: 5, returnedCount: 4 });
    expect(result.pagination.batch.deduplicatedCount).toBe(1);
    const filtered = applyDMFilter(result, 'same');
    expect(filtered.dms).toHaveLength(2);
    expect(filtered.dms.every((dm) => dm.navigation === null)).toBe(true);
    expect(filtered.coverage.match.observedCount).toBe(4);
    expect(filtered.pagination.returnedCount).toBe(2);
  });

  test('duplicate person handles and unsafe group names do not receive executable hints', () => {
    const result = collectDMSearchPages(
      receipt([
        page([
          person(0),
          person(1, 'Other name'),
          group(2, 'x'.repeat(201)),
          person(3, 'Unsafe handle', 'has spaces'),
          group(4, 'Name\u202e'),
        ]),
      ]),
      'Alex'
    );
    expect(result.dms.every((dm) => dm.navigation === null)).toBe(true);
  });

  test('valid empty autocomplete is scoped proof rather than an empty DM-directory claim', () => {
    const input = receipt([page([])], { requestedPages: 5 });
    const result = collectDMSearchPages(input, 'Alex', 5);
    expect(result.status).toBe('ok');
    expect(result.dms).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(result.pagination.hasMore).toBeNull();
    expect(formatOutput(result)).toContain('No autocomplete matches were exposed for this query.');
    input.searchPages[0].empty = false;
    expect(() => collectDMSearchPages(input, 'Alex', 5)).toThrow('empty state');
  });

  test('no-progress keeps only the prior advanced captures and leaves availability unknown', () => {
    const input = receipt([page([person(0)])], {
      requestedPages: 3,
      attemptedPages: 2,
      stopReason: 'no-progress',
    });
    const result = collectDMSearchPages(input, 'Alex', 3);
    expect(result.status).toBe('ok');
    expect(result.pagination.batch).toMatchObject({
      completedPages: 1,
      attemptedPages: 2,
      stopReason: 'no-progress',
    });
    expect(result.pagination.hasMore).toBeNull();
    expect(formatOutput(result)).toContain('more matches may exist');
  });

  test('later identity, scope, ordering and empty-state failures preserve whole verified prefix', () => {
    for (const next of [
      page([group(2), group(3)]),
      page([group(2), group(1), group(3)]),
      page([person(0, 'Changed'), group(2)]),
      page([group(1), person(0), group(2)]),
      page([person(0), group(1)]),
      page([]),
      { ...page([group(1), group(2)]), scope: { ...page([]).scope, unreadOnly: false } },
      page([group(1), group(2), group(2)]),
    ]) {
      const result = collectDMSearchPages(receipt([page([person(0), group(1)]), next]), 'Alex', 2);
      expect(result.status).toBe('partial');
      expect(result.dms.map((dm) => dm.suggestionKey)).toEqual(['option:0', 'option:1']);
      expect(result.pagination.batch.completedPages).toBe(1);
      expect(applyDMFilter(result, 'unmatched').dms).toEqual([]);
    }
  });

  test('native guard failures and dishonest terminal claims stay partial without fabricated pages', () => {
    const failed = receipt([page([person(0)])], {
      requestedPages: 3,
      attemptedPages: 2,
      stopReason: 'guard-failed',
      error: 'Scope changed',
    });
    const result = collectDMSearchPages(failed, 'Alex', 3);
    expect(result.status).toBe('partial');
    expect(result.error).toBe('Scope changed');
    expect(formatOutput(result)).toContain('Stopped: Scope changed');
    const dishonest = receipt([page([person(0)])], { requestedPages: 3 });
    expect(collectDMSearchPages(dishonest, 'Alex', 3).status).toBe('partial');
    failed.searchPages = [];
    expect(() => collectDMSearchPages(failed, 'Alex', 3)).toThrow('budget');
  });

  test('rejects malformed initial matches and keys without inventing conversation identities', () => {
    for (const match of [
      { ...person(0), key: 'D012EXAMPLE' },
      { ...person(0), key: 'option:01' },
      { ...person(0), key: 'option:9007199254740992' },
      { ...person(0), kind: 'one-to-one' },
      { ...group(0), handle: 'invented' },
      { ...person(0), name: 'bad\nname' },
      { ...person(0), handle: undefined },
    ])
      expect(() => collectDMSearchPages(receipt([page([match])]), 'Alex')).toThrow('identity');
    expect(() => collectDMSearchPages(receipt([page([person(0), person(0)])]), 'Alex')).toThrow(
      'identity'
    );
  });

  test('text caps suggestions while JSON keeps captured matches and local literal matching remains bounded', () => {
    const input = receipt([
      page(
        Array.from({ length: 35 }, (_, index) =>
          person(index, `Person ${index}`, `person.${index}`)
        )
      ),
    ]);
    const result = collectDMSearchPages(input, 'Alex');
    expect(formatOutput(result)).toContain('Showing 30 of 35 matches');
    expect(JSON.parse(formatOutput(result, 'json')).dms).toHaveLength(35);
    expect(formatOutput(applyDMFilter(result, '.*'))).toContain(
      'No captured suggestions matched the local filter.'
    );
    expect(applyDMFilter(result, '').dms).toHaveLength(35);
  });
});
