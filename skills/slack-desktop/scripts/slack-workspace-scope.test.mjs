import { describe, expect, test } from 'bun:test';
import { applyWorkspaceScope, validateWorkspaceScope } from './slack-workspace-scope.mjs';

const target = 'workspace:target.slack.com';
const url = 'https://app.slack.com/client/TTARGET/channel/CCONTEXT';
const rows = [
  { name: 'Source', domain: 'source.enterprise.slack.com', current: true },
  { name: 'Target', domain: 'target.slack.com', current: false },
];
const selection = () => ({
  operation: 'switch-workspace',
  status: 'ok',
  requested: target,
  before: {
    url: 'https://app.slack.com/client/ESOURCE/search',
    name: 'Source',
    windowId: 42,
    entries: structuredClone(rows),
  },
  after: {
    url,
    name: 'Target',
    windowId: 42,
    entries: rows.map((row) => ({ ...row, current: !row.current })),
  },
  selection: { name: 'Target', domain: 'target.slack.com' },
  switchAttempted: true,
  workspaceSwitchMayHaveBeenRequested: true,
  selector: { opened: true, reused: false, verificationOpened: true, closed: true },
});
const content = () => ({
  nodes: [
    { index: 0, parent: null, role: 'AXWebArea', label: 'Context', url },
    {
      index: 1,
      parent: 0,
      role: 'AXLink',
      label: 'Foreign link',
      url: 'https://app.slack.com/client/TOTHER/channel/COTHER',
    },
  ],
});
const frame = () => ({
  before: { url, title: 'Context' },
  after: { url, title: 'Context' },
  content: content(),
});
const receipt = (operation = 'read-channel') => ({
  operation,
  requestedWorkspace: target,
  workspaceSelection: selection(),
  workspaceSwitchMayHaveBeenRequested: true,
  workspaceScope: { contextId: 'TTARGET', windowId: 42 },
  ...frame(),
});
const validate = (value, options) => validateWorkspaceScope(value, 'read-channel', target, options);
const mutated = (change, factory = receipt) => {
  const value = factory();
  change(value);
  return value;
};

describe('native workspace scope', () => {
  test('unscoped behavior is unchanged', () => {
    expect(validateWorkspaceScope({}, 'inspect')).toBeNull();
    const compact = { operation: 'channels' };
    expect(applyWorkspaceScope(compact, null)).toBe(compact);
  });
  test('verified switch binds the selected context and window', () => {
    const result = validate(receipt());
    expect(result.status).toBe('ok');
    expect(result.workspace.contextId).toBe('TTARGET');
    expect(result.workspaceSwitchMayHaveBeenRequested).toBe(true);
    expect(result.switch.changed).toBe(true);
  });
  test('a current-workspace no-op does not invent switch input', () => {
    const value = receipt();
    const native = value.workspaceSelection;
    native.before = structuredClone(native.after);
    native.switchAttempted = native.workspaceSwitchMayHaveBeenRequested = false;
    native.selector.verificationOpened = false;
    value.workspaceSwitchMayHaveBeenRequested = false;
    const result = validate(value);
    expect(result.switch.changed).toBe(false);
    expect(result.workspaceSwitchMayHaveBeenRequested).toBe(false);
  });
  test('enterprise contexts stay distinct from team IDs', () => {
    const value = receipt();
    const replace = (text) => text.replaceAll('TTARGET', 'ETARGET');
    const enterprise = JSON.parse(replace(JSON.stringify(value)));
    expect(validate(enterprise).workspace.id).toBeNull();
    expect(validate(enterprise).workspace.contextId).toBe('ETARGET');
  });
  test.each([
    [
      'missing selection',
      (v) => {
        delete v.workspaceSelection;
      },
    ],
    [
      'missing requested target',
      (v) => {
        delete v.requestedWorkspace;
      },
    ],
    [
      'different requested target',
      (v) => {
        v.requestedWorkspace = 'Other';
      },
    ],
    [
      'different operation',
      (v) => {
        v.operation = 'read-dm';
      },
    ],
    [
      'missing fresh scope',
      (v) => {
        delete v.workspaceScope;
      },
    ],
    [
      'wrong fresh context',
      (v) => {
        v.workspaceScope.contextId = 'TOTHER';
      },
    ],
    [
      'wrong fresh window',
      (v) => {
        v.workspaceScope.windowId = 43;
      },
    ],
    [
      'forged target',
      (v) => {
        v.workspaceSelection.after.entries[0].current = true;
      },
    ],
    [
      'false switch uncertainty',
      (v) => {
        v.workspaceSwitchMayHaveBeenRequested = false;
      },
    ],
    [
      'unknown switch uncertainty',
      (v) => {
        v.workspaceSwitchMayHaveBeenRequested = null;
      },
    ],
    [
      'missing switch uncertainty',
      (v) => {
        delete v.workspaceSwitchMayHaveBeenRequested;
      },
    ],
    [
      'wrong before source',
      (v) => {
        v.before.url = url.replace('TTARGET', 'TOTHER');
      },
    ],
    [
      'wrong after source',
      (v) => {
        v.after.url = url.replace('TTARGET', 'TOTHER');
      },
    ],
    [
      'wrong content source',
      (v) => {
        v.content.nodes[0].url = url.replace('TTARGET', 'TOTHER');
      },
    ],
    [
      'missing content root URL',
      (v) => {
        delete v.content.nodes[0].url;
      },
    ],
    [
      'wrong root role',
      (v) => {
        v.content.nodes[0].role = 'AXGroup';
      },
    ],
    [
      'duplicate content root',
      (v) => {
        v.content.nodes.push({ ...v.content.nodes[0], index: 2 });
      },
    ],
    [
      'wrong observed window',
      (v) => {
        v.after.windowId = 43;
      },
    ],
    [
      'wrong source window',
      (v) => {
        v.source = { windowId: 43 };
      },
    ],
    [
      'wrong target context',
      (v) => {
        v.target = { url: url.replace('TTARGET', 'TOTHER') };
      },
    ],
    [
      'wrong thread target context',
      (v) => {
        v.threadTarget = { url: url.replace('TTARGET', 'TOTHER') };
      },
    ],
    [
      'wrong view context',
      (v) => {
        v.view = { url: url.replace('TTARGET', 'TOTHER') };
      },
    ],
    [
      'wrong current snapshot',
      (v) => {
        v.current = { nodes: [{ role: 'AXWebArea', url: url.replace('TTARGET', 'TOTHER') }] };
      },
    ],
  ])('rejects %s', (_label, change) => {
    expect(() => validate(mutated(change))).toThrow();
  });
  test.each([
    'http://app.slack.com/client/TTARGET/channel/CONE',
    'https://name@app.slack.com/client/TTARGET/channel/CONE',
    'https://app.slack.com:443/client/TTARGET/channel/CONE',
    'https://app.slack.com/client/TTARGET#',
    'https://app.slack.com/client/%54TARGET',
    'https://app.slack.com/client/TTARGET/%2Fother',
    'https://app.slack.com.evil.example/client/TTARGET',
    'https://app.slack.com/client/TTARGET\n',
  ])('rejects noncanonical source URL %s', (badURL) => {
    expect(() =>
      validate(
        mutated((v) => {
          v.after.url = badURL;
        })
      )
    ).toThrow();
  });
  test.each(['pages', 'observations', 'searchPages', 'transcriptPages'])(
    'checks every exposed source in %s',
    (key) => {
      const value = receipt();
      value[key] = [frame(), frame()];
      expect(validate(value).status).toBe('ok');
      value[key][1].after.url = url.replace('TTARGET', 'TOTHER');
      expect(() => validate(value)).toThrow('source context');
    }
  );
  test('pins every direct DMs search frame scope', () => {
    const value = receipt('dms');
    value.searchPages = [
      { scope: { url }, matches: [] },
      { scope: { url }, matches: [] },
    ];
    expect(validateWorkspaceScope(value, 'dms', target).status).toBe('ok');
    value.searchPages[1].scope.url = url.replace('TTARGET', 'TOTHER');
    expect(() => validateWorkspaceScope(value, 'dms', target)).toThrow('source context');
  });
  test('rejects empty, malformed and oversized source collections', () => {
    for (const pages of [[], {}, Array.from({ length: 11 }, frame)])
      expect(() =>
        validate(
          mutated((v) => {
            v.pages = pages;
          })
        )
      ).toThrow();
  });
  test('checks app-level search snapshots without mistaking links for roots', () => {
    const value = receipt('search');
    value.after = { nodes: content().nodes.map(({ role, url }) => ({ role, url })) };
    expect(validateWorkspaceScope(value, 'search', target).status).toBe('ok');
    value.after.nodes[0].url = url.replace('TTARGET', 'TOTHER');
    expect(() => validateWorkspaceScope(value, 'search', target)).toThrow('source context');
  });
});

describe('selection and downstream failures', () => {
  test.each([true, false, null, undefined])('preserves pre-selection uncertainty %s', (state) => {
    const value = {
      status: 'stopped',
      error: 'Original native error',
      workspaceSwitchMayHaveBeenRequested: state,
    };
    const result = validate(value, { code: 1 });
    expect(result.status).toBe('stopped');
    expect(result.error).toBe('Original native error');
    expect(result.workspaceSwitchMayHaveBeenRequested).toBe(state ?? null);
    expect(result.workspace).toBeUndefined();
  });
  test('a failed exit with no native JSON cannot claim selected workspace', () => {
    expect(validate({}, { code: 3 }).status).toBe('stopped');
    expect(() => validate({}, { code: 0 })).toThrow('no workspace selection');
  });
  test('choice refusal returns candidates without permitting read output', () => {
    const value = receipt();
    value.workspaceSelection = {
      ...selection(),
      requested: 'Missing',
      status: 'not-found',
      after: selection().before,
      switchAttempted: false,
      workspaceSwitchMayHaveBeenRequested: false,
      selector: { opened: true, reused: false, verificationOpened: false, closed: true },
    };
    delete value.workspaceSelection.selection;
    value.requestedWorkspace = 'Missing';
    value.workspaceSwitchMayHaveBeenRequested = false;
    const result = validateWorkspaceScope(value, 'read-channel', 'Missing', { code: 1 });
    expect(result.status).toBe('not-found');
    expect(result.candidates).toHaveLength(2);
    expect(() => applyWorkspaceScope({ messages: [] }, result)).toThrow();
  });
  test('a failed read retains completed selection when the current pin was lost', () => {
    const value = receipt();
    delete value.workspaceScope;
    value.status = 'stopped';
    value.error = 'Workspace moved after selection';
    value.workspaceScopeError = 'Fresh pin unavailable';
    expect(validate(value, { code: 1 }).status).toBe('ok');
    expect(validate(value, { code: 1 }).workspaceSwitchMayHaveBeenRequested).toBe(true);
  });
  test('partial content still needs a fresh pin even with failure exit code', () => {
    const value = receipt();
    value.status = 'partial';
    delete value.workspaceScope;
    expect(() => validate(value, { code: 1 })).toThrow('fresh selected workspace');
  });
  test('failure content cannot smuggle a mismatched source', () => {
    const value = receipt();
    value.status = 'stopped';
    value.after.url = url.replace('TTARGET', 'TOTHER');
    expect(() => validate(value, { code: 1 })).toThrow('source context');
  });
});

describe('transcript phases', () => {
  const preflight = () => {
    const value = receipt('read-transcript');
    delete value.before;
    delete value.after;
    delete value.content;
    value.phase = 'select';
    value.observations = [frame(), frame()];
    return value;
  };
  const result = () => {
    const value = receipt('read-transcript');
    delete value.before;
    delete value.after;
    delete value.content;
    value.phase = 'result';
    value.preflight = preflight();
    value.transcript = { content: { nodes: [{ role: 'AXGroup', parent: null }] } };
    return value;
  };
  const verify = (value, code = 0) =>
    validateWorkspaceScope(value, 'read-transcript', target, { code });
  test('verifies the preflight before token selection and a panel-only result', () => {
    expect(verify(preflight()).status).toBe('ok');
    expect(verify(result()).status).toBe('ok');
  });
  test('paginated transcript panels remain bound by the final fresh workspace stamp', () => {
    const value = result();
    value.transcriptPages = Array.from({ length: 3 }, () => ({
      transcript: structuredClone(value.transcript),
      verification: { sourceMatched: true, panelOpened: true, playbackUnchanged: true },
    }));
    delete value.transcript;
    expect(verify(value).status).toBe('ok');
    value.workspaceScope.contextId = 'TOTHER';
    expect(() => verify(value)).toThrow('fresh selected workspace');
  });
  test('preflight and result need independent fresh pins', () => {
    for (const edit of [
      (v) => {
        delete v.workspaceScope;
      },
      (v) => {
        delete v.preflight.workspaceScope;
      },
      (v) => {
        v.preflight.observations[1].before.url = url.replace('TTARGET', 'TOTHER');
      },
      (v) => {
        v.preflight.workspaceSelection.after.windowId = 999;
      },
    ])
      expect(() => verify(mutated(edit, result))).toThrow();
  });
  test('synthetic runner errors retain preflight switch uncertainty', () => {
    const value = {
      operation: 'read-transcript',
      status: 'stopped',
      error: 'Timeout',
      preflight: preflight(),
    };
    expect(verify(value, 1).workspaceSwitchMayHaveBeenRequested).toBe(true);
    value.nativeResult = result();
    expect(verify(value, 1).workspace.contextId).toBe('TTARGET');
    value.nativeResult.workspaceScope.windowId = 99;
    expect(() => verify(value, 1)).toThrow();
  });
});

describe('workspace navigation hints', () => {
  const selected = () => validate(receipt());
  const navigation = (command = 'read-thread', args = ['CCONTEXT:1700000000.000001']) => ({
    command,
    args,
  });
  const flag = `--workspace=${target}`;
  test('scopes known hints and preserves pagination and clipboard args', () => {
    const compact = {
      operation: 'read-channel',
      workspace: { contextId: 'TTARGET', id: 'TTARGET' },
      messages: [
        {
          thread: { navigation: navigation() },
          attachments: [
            {
              navigation: navigation('read-media', ['FTEST']),
              transcript: { navigation: navigation('read-transcript', ['FTEST']) },
            },
          ],
        },
      ],
      pagination: {
        older: {
          navigation: navigation('read-channel', [
            'general',
            '--before=CCONTEXT:1700000000.000001',
          ]),
        },
      },
      candidates: [
        { navigation: navigation('read-dm', ['group-name:Example, Person', '--allow-clipboard']) },
      ],
    };
    const value = applyWorkspaceScope(compact, selected());
    expect(value.messages[0].thread.navigation.args).toEqual(['CCONTEXT:1700000000.000001', flag]);
    expect(value.messages[0].attachments[0].transcript.navigation.args).toEqual(['FTEST', flag]);
    expect(value.pagination.older.navigation.args).toEqual([
      'general',
      '--before=CCONTEXT:1700000000.000001',
      flag,
    ]);
    expect(value.candidates[0].navigation.args).toEqual([
      'group-name:Example, Person',
      '--allow-clipboard',
      flag,
    ]);
    expect(value.requestedWorkspace).toBe(target);
    expect(value.workspaceSelection.workspace.contextId).toBe('TTARGET');
    expect(compact.messages[0].thread.navigation.args).toHaveLength(1);
  });
  test('does not rewrite raw text, arbitrary objects or unsupported commands', () => {
    const compact = {
      body: { navigation: navigation() },
      content: { navigation: navigation() },
      messages: [{ body: 'read-thread Example', bodyObject: { navigation: navigation() } }],
      navigation: [navigation('switch-workspace', [target]), navigation('inspect', [])],
      media: { saveNavigation: navigation('unsupported-save', ['FTEST']) },
    };
    const value = applyWorkspaceScope(compact, selected());
    expect(value.body).toEqual(compact.body);
    expect(value.content).toEqual(compact.content);
    expect(value.messages).toEqual(compact.messages);
    expect(value.navigation).toEqual(compact.navigation);
    expect(value.media).toEqual(compact.media);
  });
  test('scoping is idempotent and rejects conflicting scope args', () => {
    const compact = { navigation: navigation() };
    const first = applyWorkspaceScope(compact, selected());
    expect(applyWorkspaceScope(first, selected())).toEqual(first);
    compact.navigation.args.push('--workspace=workspace:other.slack.com');
    expect(() => applyWorkspaceScope(compact, selected())).toThrow('conflicting workspace');
  });
  test('never uses an unverified selection or mismatched compact context for hints', () => {
    expect(() => applyWorkspaceScope({}, { ...selected(), status: 'stopped' })).toThrow();
    expect(() => applyWorkspaceScope({ workspace: { contextId: 'TOTHER' } }, selected())).toThrow();
    const bad = selected();
    bad.workspace.domain += '\n';
    bad.workspace.ref += '\n';
    bad.switch.to = bad.workspace;
    expect(() => applyWorkspaceScope({}, bad)).toThrow();
  });
  test('failed reads can show completed selection without claiming read workspace', () => {
    const result = applyWorkspaceScope(
      { status: 'stopped', error: 'Source unavailable' },
      selected()
    );
    expect(result.status).toBe('stopped');
    expect(result.workspace).toBeUndefined();
    expect(result.workspaceSelection.workspace.contextId).toBe('TTARGET');
  });
  test('save hints keep required options while save outcomes stay unchanged', () => {
    const compact = {
      operation: 'save-media',
      status: 'stopped',
      error: 'Publication not verified',
      downloadMayHaveStarted: true,
      viewerMayHaveOpened: true,
      sourceMayHaveReopened: true,
      saved: { published: null, verified: false, path: '/tmp/example.bin' },
      media: {
        saveNavigation: { ...navigation('save-media', ['FTEST']), requiredOption: '--output=PATH' },
      },
    };
    const scoped = applyWorkspaceScope(compact, selected());
    expect(scoped.media.saveNavigation).toEqual({
      command: 'save-media',
      args: ['FTEST', flag],
      requiredOption: '--output=PATH',
    });
    for (const key of [
      'status',
      'error',
      'saved',
      'downloadMayHaveStarted',
      'viewerMayHaveOpened',
      'sourceMayHaveReopened',
    ])
      expect(scoped[key]).toEqual(compact[key]);
    expect(applyWorkspaceScope(scoped, selected())).toEqual(scoped);
    compact.media.saveNavigation.args.push('--workspace=workspace:other.slack.com');
    expect(() => applyWorkspaceScope(compact, selected())).toThrow('conflicting workspace');
  });
});

describe('save workspace phases', () => {
  const verify = (value, code = 0) => validateWorkspaceScope(value, 'save-media', target, { code });
  const phase = (name) => {
    const value = receipt('save-media');
    delete value.before;
    delete value.after;
    delete value.content;
    return { ...value, phase: name, ...(name === 'result' ? { status: 'ok' } : {}) };
  };
  const subtree = () => ({ nodes: [{ index: 0, parent: null, role: 'AXGroup' }] });
  const preflight = () => ({ ...phase('select'), observations: [frame(), frame()] });
  const reopened = () => ({
    ...phase('source-select'),
    observations: [frame(), frame()],
    sourceRequest: { workspace: 'TTARGET', messageRef: 'CCONTEXT:1700000000.000001' },
  });
  const viewer = () => ({
    ...phase('viewer-select'),
    observations: [0, 1].map(() => ({
      before: { url },
      after: { url },
      content: subtree(),
      source: { content: subtree() },
    })),
    detailsMenu: {
      observations: [0, 1].map(() => ({ content: subtree(), source: { content: subtree() } })),
    },
  });
  const result = () => ({
    ...phase('result'),
    preflight: preflight(),
    sourcePreflight: reopened(),
    viewerPreflight: viewer(),
    started: phase('started'),
    publicationPreflight: phase('publish'),
    downloadMayHaveStarted: true,
  });

  test('validates direct, reopened, viewer, started, publication and result phases', () => {
    for (const value of [
      preflight(),
      reopened(),
      viewer(),
      phase('started'),
      phase('publish'),
      result(),
    ]) {
      const before = structuredClone(value);
      expect(verify(value).workspace.contextId).toBe('TTARGET');
      expect(value).toEqual(before);
    }
    const stopped = {
      operation: 'save-media',
      status: 'stopped',
      error: 'Download pending',
      preflight: preflight(),
      started: phase('started'),
      downloadMayHaveStarted: true,
    };
    expect(verify(stopped, 1).workspace.contextId).toBe('TTARGET');
    expect(stopped.status).toBe('stopped');
    expect(stopped.downloadMayHaveStarted).toBe(true);
    expect(stopped.saved).toBeUndefined();
  });

  test.each([
    'preflight',
    'sourcePreflight',
    'viewerPreflight',
    'started',
    'publicationPreflight',
    'nativeResult',
  ])('checks selection and fresh pins in the %s envelope', (key) => {
    for (const change of [
      (value) => {
        delete value.workspaceScope;
      },
      (value) => {
        value.workspaceScope.windowId = 43;
      },
      (value) => {
        value.workspaceScope.contextId = 'TOTHER';
      },
      (value) => {
        value.workspaceSelection.after.windowId = 43;
        value.workspaceSelection.before.windowId = 43;
      },
      (value) => {
        value.requestedWorkspace = 'Other';
      },
    ]) {
      const value = result();
      value.nativeResult = phase('result');
      change(value[key]);
      expect(() => verify(value)).toThrow();
    }
  });

  test.each(['select', 'source-select', 'viewer-select', 'started', 'publish'])(
    'a stopped %s action phase cannot authorize a token without a fresh pin',
    (name) => {
      const value = { ...phase(name), status: 'stopped' };
      delete value.workspaceScope;
      expect(() => verify(value, 1)).toThrow('fresh selected workspace');
    }
  );

  test('viewer subtrees require explicit viewer phase and matching client captures', () => {
    for (const change of [
      (v) => {
        v.phase = 'select';
      },
      (v) => {
        delete v.observations[0].before;
      },
      (v) => {
        delete v.observations[1].after.url;
      },
      (v) => {
        v.observations[1].after.url = url.replace('TTARGET', 'TOTHER');
      },
      (v) => {
        v.observations[0].before.windowId = 43;
      },
      (v) => {
        delete v.observations[1].source;
      },
      (v) => {
        v.observations[0].content.nodes.push({ index: 1, parent: null, role: 'AXGroup' });
      },
      (v) => {
        v.observations[1].source.content.nodes[0].url = url.replace('TTARGET', 'TOTHER');
      },
      (v) => {
        v.detailsMenu.observations[1].source.windowId = 43;
      },
      (v) => {
        v.detailsMenu.observations[1].content.nodes[0].url = url.replace('TTARGET', 'TOTHER');
      },
      (v) => {
        v.detailsMenu.observations[0].source.content.nodes.push({
          index: 1,
          parent: 0,
          role: 'AXWebArea',
          url: url.replace('TTARGET', 'TOTHER'),
        });
      },
    ])
      expect(() => verify(mutated(change, viewer))).toThrow();
    const otherOperation = viewer();
    otherOperation.operation = 'read-media';
    expect(() => validateWorkspaceScope(otherOperation, 'read-media', target)).toThrow(
      'client root'
    );
    const ordinary = preflight();
    ordinary.observations[0].content = subtree();
    expect(() => verify(ordinary)).toThrow('client root');
  });

  test('reopened source and any explicit save source context must stay in the selected workspace', () => {
    for (const workspace of [null, 'TOTHER', 'TTARGET\n']) {
      const value = result();
      value.sourcePreflight.sourceRequest.workspace = workspace;
      expect(() => verify(value)).toThrow('source reopening');
    }
    const value = result();
    value.source = { context: 'TTARGET' };
    expect(verify(value).status).toBe('ok');
    value.source.context = 'TOTHER';
    expect(() => verify(value)).toThrow('save source context');
  });

  test.each(['rejectedSourcePreflight', 'rejectedViewerPreflight', 'rejectedPublicationPreflight'])(
    '%s is diagnostic evidence and never an authorizing selection',
    (key) => {
      const value = {
        operation: 'save-media',
        status: 'stopped',
        error: 'Unexpected phase',
        [key]: phase('publish'),
      };
      const selected = verify(value, 1);
      expect(selected.status).toBe('stopped');
      expect(selected.workspace).toBeUndefined();
      expect(selected.workspaceSwitchMayHaveBeenRequested).toBe(true);
      expect(() => verify({ ...value, status: 'ok' })).toThrow('no workspace selection');
      value.preflight = preflight();
      expect(verify(value, 1).workspace.contextId).toBe('TTARGET');
      value[key].workspaceScope.contextId = 'TOTHER';
      expect(() => verify(value, 1)).toThrow('source context');
    }
  );

  test('rejects drift or malformed data retained in a rejected phase', () => {
    const value = {
      operation: 'save-media',
      status: 'stopped',
      preflight: preflight(),
      rejectedSourcePreflight: reopened(),
    };
    value.rejectedSourcePreflight.workspaceSelection.after.windowId = 43;
    value.rejectedSourcePreflight.workspaceSelection.before.windowId = 43;
    expect(() => verify(value, 1)).toThrow('rejected protocol phase');
    value.rejectedSourcePreflight = [];
    expect(() => verify(value, 1)).toThrow('Rejected workspace protocol envelope');
  });
});
