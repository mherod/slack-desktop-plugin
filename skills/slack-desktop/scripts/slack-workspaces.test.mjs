import { describe, expect, test } from 'bun:test';
import { compactWorkspaces } from './slack-workspaces.mjs';

// Synthetic identities only. Raw selector observations remain separate from
// command action evidence so changed receipts cannot authorize a destination.
const rows = () => [
  { name: 'Example Enterprise', domain: 'example.enterprise.slack.com', current: true },
  { name: 'Example Team', domain: 'example-team.slack.com', current: false },
];
const observation = (extra = {}) => ({
  url: 'https://app.slack.com/client/EEXAMPLE/search',
  name: 'Example Enterprise',
  windowId: 123,
  entries: rows(),
  ...extra,
});
const receipt = (operation = 'workspaces', extra = {}) => ({
  operation,
  status: 'ok',
  before: observation(),
  after: observation(),
  switchAttempted: false,
  workspaceSwitchMayHaveBeenRequested: false,
  selector: { opened: true, reused: false, verificationOpened: false, closed: true },
  ...extra,
});
const current = () => {
  const result = receipt('current-workspace');
  delete result.before.entries;
  delete result.after.entries;
  result.selector = { opened: false, reused: false, verificationOpened: false, closed: false };
  return result;
};
const switchReceipt = (requested = 'workspace:example-team.slack.com') =>
  receipt('switch-workspace', {
    requested,
    after: observation({
      url: 'https://app.slack.com/client/TEXAMPLE/channel/CEXAMPLE',
      name: 'Example Team',
      entries: rows().map((row) => ({ ...row, current: !row.current })),
    }),
    selection: { name: 'Example Team', domain: 'example-team.slack.com' },
    switchAttempted: true,
    workspaceSwitchMayHaveBeenRequested: true,
    selector: { opened: true, reused: false, verificationOpened: true, closed: true },
  });
const noOp = (requested = 'EEXAMPLE') =>
  receipt('switch-workspace', {
    requested,
    selection: { name: 'Example Enterprise', domain: 'example.enterprise.slack.com' },
  });
const compact = (value) => compactWorkspaces(value, value.operation, value.requested);
const mutate = (factory, edit) => {
  const value = factory();
  edit(value);
  return value;
};

describe('workspace rail observations', () => {
  const railRows = (currentIndex = 0) =>
    ['Example Enterprise', 'Example Team', 'Example Team'].map((name, index) => ({
      name,
      domain: null,
      current: index === currentIndex,
    }));
  const rail = {
    opened: false,
    reused: true,
    verificationOpened: false,
    closed: false,
    layout: 'rail',
  };
  const railReceipt = (operation = 'workspaces', extra = {}) =>
    receipt(operation, {
      before: observation({ entries: railRows() }),
      after: observation({ entries: railRows() }),
      selector: { ...rail },
      ...extra,
    });

  test('lists names without domains and offers only unambiguous name targets', () => {
    const result = compact(railReceipt());
    expect(result.workspace).toMatchObject({ name: 'Example Enterprise', domain: null, ref: null });
    expect(
      result.workspaces.map(({ name, ref, navigation }) => ({ name, ref, navigation }))
    ).toEqual([
      {
        name: 'Example Enterprise',
        ref: null,
        navigation: { command: 'switch-workspace', args: ['Example Enterprise'] },
      },
      { name: 'Example Team', ref: null, navigation: undefined },
      { name: 'Example Team', ref: null, navigation: undefined },
    ]);
  });

  test('reserved-looking names are never offered as name targets', () => {
    for (const name of ['workspace:example.slack.com', 'TEXAMPLE']) {
      const entries = [
        { name: 'Example Enterprise', domain: null, current: true },
        { name, domain: null, current: false },
      ];
      const result = compact(
        railReceipt('workspaces', {
          before: observation({ entries }),
          after: observation({ entries }),
        })
      );
      expect(result.workspaces[1].navigation).toBeUndefined();
    }
  });

  test('a rail switch verifies by name and context without selector lifecycle input', () => {
    const entries = [
      { name: 'Example Enterprise', domain: null, current: true },
      { name: 'Example Team', domain: null, current: false },
    ];
    const switched = () =>
      railReceipt('switch-workspace', {
        requested: 'Example Team',
        before: observation({ entries }),
        after: observation({
          url: 'https://app.slack.com/client/TEXAMPLE/channel/CEXAMPLE',
          name: 'Example Team',
          entries: entries.map((row) => ({ ...row, current: !row.current })),
        }),
        selection: { name: 'Example Team', domain: null },
        switchAttempted: true,
        workspaceSwitchMayHaveBeenRequested: true,
      });
    const result = compact(switched());
    expect(result.switch).toMatchObject({ attempted: true, changed: true });
    expect(result.workspace).toMatchObject({
      name: 'Example Team',
      contextId: 'TEXAMPLE',
      ref: null,
    });
    expect(() =>
      compact(mutate(switched, (value) => (value.after.url = value.before.url)))
    ).toThrow();
    for (const key of ['opened', 'closed', 'verificationOpened'])
      expect(() => compact(mutate(switched, (value) => (value.selector[key] = true)))).toThrow();
    expect(() => compact(mutate(switched, (value) => (value.selector.reused = false)))).toThrow();
    expect(() => compact(mutate(switched, (value) => (value.selector.layout = 'other')))).toThrow();
  });

  test('ambiguous rail names stop and mixed domain inventories are refused', () => {
    const ambiguous = railReceipt('switch-workspace', {
      requested: 'Example Team',
      status: 'ambiguous',
    });
    expect(compact(ambiguous)).toMatchObject({ status: 'ambiguous', exactMatchCount: 2 });
    const mixed = railReceipt();
    mixed.before.entries[1].domain = 'example-team.slack.com';
    mixed.after.entries[1].domain = 'example-team.slack.com';
    expect(() => compact(mixed)).toThrow('mixes entries');
    const reference = railReceipt('switch-workspace', {
      requested: 'workspace:example-team.slack.com',
      status: 'not-found',
    });
    expect(compact(reference)).toMatchObject({ status: 'not-found', exactMatchCount: 0 });
  });
});

describe('workspace observations', () => {
  test('listing retains unknown inactive IDs and domain-bound navigation', () => {
    const result = compact(receipt());
    expect(result.workspace).toEqual({
      name: 'Example Enterprise',
      contextId: 'EEXAMPLE',
      id: null,
      domain: 'example.enterprise.slack.com',
      ref: 'workspace:example.enterprise.slack.com',
    });
    expect(result.workspaces).toEqual([
      {
        ...rows()[0],
        ref: 'workspace:example.enterprise.slack.com',
        contextId: 'EEXAMPLE',
        id: null,
        navigation: {
          command: 'switch-workspace',
          args: ['workspace:example.enterprise.slack.com'],
        },
      },
      {
        ...rows()[1],
        ref: 'workspace:example-team.slack.com',
        contextId: null,
        id: null,
        navigation: { command: 'switch-workspace', args: ['workspace:example-team.slack.com'] },
      },
    ]);
    expect(result.coverage).toEqual({ scope: 'exposed-workspace-switcher', complete: false });
    expect(result.before).toBeUndefined();
    expect(result.selector).toBeUndefined();
  });

  test('current inspection uses stable root identity without opening a selector', () => {
    const value = current();
    const result = compact(value);
    expect(result.workspace).toEqual({
      name: 'Example Enterprise',
      contextId: 'EEXAMPLE',
      id: null,
      domain: null,
      ref: null,
    });
    expect(result.workspaces).toBeUndefined();
    expect(result.coverage).toBeUndefined();
    value.before.url = value.after.url = 'https://app.slack.com/client/TEXAMPLE/search?q=exact';
    expect(compact(value).workspace.id).toBe('TEXAMPLE');
  });

  test('listing can preserve an already-open selector without new input', () => {
    const value = receipt();
    value.selector = { opened: false, reused: true, verificationOpened: false, closed: false };
    expect(compact(value).status).toBe('ok');
  });

  test('the complete 64-row native inventory bound is accepted', () => {
    const value = receipt();
    for (const frame of [value.before, value.after]) {
      frame.name = 'Team 0';
      frame.entries = Array.from({ length: 64 }, (_, i) => ({
        name: `Team ${i}`,
        domain: `team-${i}.slack.com`,
        current: i === 0,
      }));
    }
    expect(compact(value).workspaces).toHaveLength(64);
  });

  test.each(['\n', '\r', '\u2028', '\u2029'])(
    'a final line separator cannot escape the domain identity anchor',
    (suffix) => {
      const value = receipt();
      for (const frame of [value.before, value.after]) frame.entries[1].domain += suffix;
      expect(() => compact(value)).toThrow('selector identity');
    }
  );

  test.each([
    ['wrong scheme', 'http://app.slack.com/client/EEXAMPLE/search'],
    ['foreign host', 'https://app.slack.com.evil.example/client/EEXAMPLE/search'],
    ['credentials', 'https://name@app.slack.com/client/EEXAMPLE/search'],
    ['explicit default port', 'https://app.slack.com:443/client/EEXAMPLE/search'],
    ['port', 'https://app.slack.com:8443/client/EEXAMPLE/search'],
    ['encoded context', 'https://app.slack.com/client/%45EXAMPLE/search'],
    ['encoded route', 'https://app.slack.com/client/EEXAMPLE/search%2Fother'],
    ['invalid route escape', 'https://app.slack.com/client/EEXAMPLE/search%zz'],
    ['lowercase context', 'https://app.slack.com/client/Eexample/search'],
    ['unknown context kind', 'https://app.slack.com/client/CEXAMPLE/search'],
    ['empty context', 'https://app.slack.com/client//search'],
    ['extra slash', 'https://app.slack.com//client/EEXAMPLE/search'],
    ['dot context', 'https://app.slack.com/client/../EEXAMPLE/search'],
    ['fragment', 'https://app.slack.com/client/EEXAMPLE/search#other'],
    ['empty fragment', 'https://app.slack.com/client/EEXAMPLE/search#'],
    ['leading whitespace', ' https://app.slack.com/client/EEXAMPLE/search'],
  ])('rejects %s in workspace URL', (_, url) => {
    const value = receipt();
    value.before.url = value.after.url = url;
    expect(() => compact(value)).toThrow();
  });

  test.each([
    ['missing observation', (r) => delete r.before],
    ['changed context', (r) => (r.after.url = r.after.url.replace('EEXAMPLE', 'EOTHER'))],
    ['changed route', (r) => (r.after.url += '/other')],
    ['changed window', (r) => (r.after.windowId = 456)],
    ['zero window', (r) => (r.before.windowId = 0)],
    ['fractional window', (r) => (r.before.windowId = 1.5)],
    ['unknown name', (r) => (r.before.name = null)],
    ['leading name whitespace', (r) => (r.before.name = ' Example Enterprise')],
    ['name control', (r) => (r.before.name = 'Example\nEnterprise')],
    ['name overflow', (r) => (r.before.name = 'x'.repeat(201))],
    ['empty selector', (r) => (r.before.entries = [])],
    [
      'selector overflow',
      (r) => {
        for (const frame of [r.before, r.after]) {
          frame.name = 'Team 0';
          frame.entries = Array.from({ length: 65 }, (_, i) => ({
            name: `Team ${i}`,
            domain: `team-${i}.slack.com`,
            current: i === 0,
          }));
        }
      },
    ],
    ['missing selector', (r) => delete r.after.entries],
    ['duplicate domains', (r) => r.before.entries.push({ ...r.before.entries[0] })],
    ['multiple checked', (r) => (r.before.entries[1].current = true)],
    ['none checked', (r) => (r.before.entries[0].current = false)],
    ['unknown checked', (r) => (r.before.entries[0].current = null)],
    ['string checked', (r) => (r.before.entries[0].current = 'true')],
    ['wrong checked name', (r) => (r.before.entries[0].name = 'Other')],
    ['changed row name', (r) => (r.after.entries[1].name = 'Other')],
    ['changed order', (r) => r.after.entries.reverse()],
    ['unsupported domain', (r) => (r.before.entries[1].domain = 'evil.example')],
    ['uppercase domain', (r) => (r.before.entries[1].domain = 'EXAMPLE.slack.com')],
    ['extra domain label', (r) => (r.before.entries[1].domain = 'a.b.slack.com')],
    ['domain slash', (r) => (r.before.entries[1].domain = 'example.slack.com/')],
    ['domain URL', (r) => (r.before.entries[1].domain = 'https://example.slack.com')],
    ['attempted switch', (r) => (r.switchAttempted = true)],
    ['uncertain switch', (r) => (r.workspaceSwitchMayHaveBeenRequested = true)],
    ['missing switch evidence', (r) => delete r.switchAttempted],
    ['missing uncertainty', (r) => delete r.workspaceSwitchMayHaveBeenRequested],
    ['unclosed owned selector', (r) => (r.selector.closed = false)],
    ['both opened and reused', (r) => (r.selector.reused = true)],
    ['selector never established', (r) => (r.selector.opened = false)],
    ['extra verification open', (r) => (r.selector.verificationOpened = true)],
    ['unexpected selection', (r) => (r.selection = r.before.entries[0])],
  ])('refuses %s rather than emitting a verified listing', (_, edit) => {
    expect(() => compact(mutate(receipt, edit))).toThrow();
  });

  test.each([
    (r) => (r.selector.opened = true),
    (r) => (r.selector.reused = true),
    (r) => (r.selector.closed = true),
    (r) => (r.before.entries = rows()),
    (r) => (r.after.entries = rows()),
  ])('current inspection rejects selector activity or attached listings', (edit) => {
    expect(() => compact(mutate(current, edit))).toThrow();
  });
});

describe('verified workspace switching', () => {
  test.each(['workspace:example-team.slack.com', 'Example Team'])(
    'requires the exact observed destination for %s',
    (requested) => {
      const result = compact(switchReceipt(requested));
      expect(result.status).toBe('ok');
      expect(result.workspace.id).toBe('TEXAMPLE');
      expect(result.workspace.domain).toBe('example-team.slack.com');
      expect(result.switch.attempted).toBe(true);
      expect(result.switch.changed).toBe(true);
      expect(result.switch.from.contextId).toBe('EEXAMPLE');
      expect(result.switch.to).toEqual(result.workspace);
    }
  );

  test.each(['EEXAMPLE', 'Example Enterprise', 'workspace:example.enterprise.slack.com'])(
    'already-current %s is verified without a switch attempt',
    (requested) => {
      const value = noOp(requested);
      value.selector = { opened: false, reused: true, verificationOpened: false, closed: false };
      const result = compact(value);
      expect(result.switch.attempted).toBe(false);
      expect(result.switch.changed).toBe(false);
      expect(result.switch.from).toEqual(result.switch.to);
    }
  );

  test.each([
    ['wrong target', (r) => (r.requested = 'Other')],
    ['fuzzy name', (r) => (r.requested = 'Example')],
    ['case-folded name', (r) => (r.requested = 'example team')],
    ['unknown inactive ID', (r) => (r.requested = 'TEXAMPLE')],
    ['wrong selected name', (r) => (r.selection.name = 'Other')],
    ['wrong selected domain', (r) => (r.selection.domain = 'other.slack.com')],
    ['missing selection', (r) => delete r.selection],
    ['changed destination name', (r) => (r.after.name = 'Other')],
    ['unmatched current target', (r) => (r.after.entries = rows())],
    ['changed window', (r) => (r.after.windowId = 456)],
    ['unchanged context', (r) => (r.after.url = r.before.url)],
    ['changed domain inventory', (r) => (r.after.entries[1].domain = 'other.slack.com')],
    ['no switch attempt', (r) => (r.switchAttempted = false)],
    ['no switch uncertainty', (r) => (r.workspaceSwitchMayHaveBeenRequested = false)],
    ['no verification selector', (r) => (r.selector.verificationOpened = false)],
    ['verification selector left open', (r) => (r.selector.closed = false)],
    [
      'ambiguous exact names',
      (r) => {
        r.requested = 'Example Team';
        r.before.entries.push({
          name: 'Example Team',
          domain: 'duplicate.slack.com',
          current: false,
        });
        r.after.entries.push({
          name: 'Example Team',
          domain: 'duplicate.slack.com',
          current: false,
        });
      },
    ],
  ])('refuses %s in successful switch evidence', (_, edit) => {
    expect(() => compact(mutate(switchReceipt, edit))).toThrow();
  });

  test('already-current success cannot hide input or a changed root route', () => {
    expect(() => compact(mutate(noOp, (r) => (r.switchAttempted = true)))).toThrow();
    expect(() => compact(mutate(noOp, (r) => (r.after.url += '/other')))).toThrow();
    expect(() => compact(mutate(noOp, (r) => (r.selector.verificationOpened = true)))).toThrow();
  });

  test('a changed nonselected row invalidates switching despite a correct target', () => {
    const value = switchReceipt();
    for (const frame of [value.before, value.after])
      frame.entries.push({ name: 'Third Team', domain: 'third-team.slack.com', current: false });
    value.after.entries[2].domain = 'substituted-team.slack.com';
    expect(() => compact(value)).toThrow('inventory changed');
  });

  test('the call target and operation cannot be replaced by receipt metadata', () => {
    const value = switchReceipt();
    expect(() => compactWorkspaces(value, 'switch-workspace', 'Other')).toThrow();
    expect(() => compactWorkspaces(value, 'workspaces')).toThrow();
    expect(() => compactWorkspaces(receipt(), 'workspaces', 'ignored')).toThrow();
    expect(() => compactWorkspaces(receipt(), 'channels')).toThrow();
  });
});

describe('workspace choice and failure outputs', () => {
  const choice = (status = 'not-found', requested = 'Missing') =>
    receipt('switch-workspace', { status, requested, error: 'Native choice refusal' });

  test('not-found reports observed domain hints without guessing a destination', () => {
    const result = compact(choice());
    expect(result.status).toBe('not-found');
    expect(result.exactMatchCount).toBe(0);
    expect(result.candidateCount).toBe(2);
    expect(result.candidates[1].navigation.args).toEqual(['workspace:example-team.slack.com']);
    expect(result.workspaceSwitchMayHaveBeenRequested).toBe(false);
    expect(result.switch).toBeUndefined();
    expect(result.workspaces).toBeUndefined();
  });

  test('duplicate names retain distinct domains and exact ambiguity', () => {
    const value = choice('ambiguous', 'Example Team');
    for (const frame of [value.before, value.after])
      frame.entries.push({ name: 'Example Team', domain: 'another.slack.com', current: false });
    const result = compact(value);
    expect(result.status).toBe('ambiguous');
    expect(result.exactMatchCount).toBe(2);
    expect(result.candidates.map((entry) => entry.ref)).toEqual([
      'workspace:example-team.slack.com',
      'workspace:another.slack.com',
    ]);
    const resolved = switchReceipt('workspace:example-team.slack.com');
    for (const frame of [resolved.before, resolved.after])
      frame.entries.push({ name: 'Example Team', domain: 'another.slack.com', current: false });
    expect(compact(resolved).status).toBe('ok');
  });

  test('bounded candidates preserve their full observed count', () => {
    const value = choice();
    for (const frame of [value.before, value.after])
      for (let n = 0; n < 25; n++)
        frame.entries.push({
          name: `Synthetic ${n}`,
          domain: `synthetic-${n}.slack.com`,
          current: false,
        });
    const result = compact(value);
    expect(result.candidates).toHaveLength(20);
    expect(result.candidateCount).toBe(27);
    expect(result.candidatesTruncated).toBe(true);
  });

  test('choice without a final observation does not claim the workspace is still current', () => {
    const value = choice();
    delete value.after;
    expect(compact(value).workspace).toBeUndefined();
    expect(compact(value).candidates).toHaveLength(2);
  });

  test('choice refusal can preserve a pre-existing selector without closing it', () => {
    const value = choice();
    value.selector = { opened: false, reused: true, verificationOpened: false, closed: false };
    const result = compact(value);
    expect(result.status).toBe('not-found');
    expect(result.candidates).toHaveLength(2);
  });

  test.each([
    ['false missing', (r) => (r.requested = 'Example Team')],
    [
      'false ambiguity',
      (r) => {
        r.status = 'ambiguous';
        r.requested = 'Example Team';
      },
    ],
    [
      'attempted selection',
      (r) => {
        r.switchAttempted = true;
        r.workspaceSwitchMayHaveBeenRequested = true;
      },
    ],
    ['selection attached', (r) => (r.selection = r.before.entries[0])],
    ['changed later source', (r) => (r.after.url += '/other')],
    ['unclosed owned selector', (r) => (r.selector.closed = false)],
    ['selector never observed', (r) => (r.selector.opened = false)],
    [
      'uncertain verification menu',
      (r) => {
        r.selector = { opened: false, reused: true, verificationOpened: true, closed: false };
      },
    ],
  ])('rejects %s instead of misreporting a choice refusal', (_, edit) => {
    expect(() => compact(mutate(choice, edit))).toThrow();
  });

  test.each([true, false, null, undefined])('stopped switch preserves %s uncertainty', (value) => {
    const input = {
      operation: 'switch-workspace',
      requested: 'Example Team',
      status: 'stopped',
      error: 'Uncertain native result',
      workspaceSwitchMayHaveBeenRequested: value,
      before: observation(),
      after: observation(),
      interaction: { mode: 'foreground', ownershipLost: true },
    };
    const result = compact(input);
    expect(result.status).toBe('stopped');
    expect(result.error).toBe(input.error);
    expect(result.workspaceSwitchMayHaveBeenRequested).toBe(value ?? null);
    expect(result.workspace).toBeUndefined();
    expect(result.switch).toBeUndefined();
    expect(result.candidates).toBeUndefined();
    expect(result.interaction.ownershipLost).toBe(true);
  });

  test('generic stopped receipt remains available without a claimed identity', () => {
    const result = compactWorkspaces({ status: 'stopped', error: 'AX unavailable' }, 'workspaces');
    expect(result.error).toBe('AX unavailable');
    expect(result.workspaceSwitchMayHaveBeenRequested).toBeNull();
    expect(result.workspace).toBeUndefined();
  });

  test.each([false, null, undefined])('attempted switch cannot report %s uncertainty', (value) => {
    expect(() =>
      compactWorkspaces(
        { status: 'stopped', switchAttempted: true, workspaceSwitchMayHaveBeenRequested: value },
        'switch-workspace',
        'Example Team'
      )
    ).toThrow();
  });
});
