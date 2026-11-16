import { describe, expect, test } from 'bun:test';
import { formatOutput } from './slack-format.mjs';
import {
  compactUIObservation,
  compactUIOutput,
  formatUIObservation,
  formatUIOutput,
} from './slack-ui.mjs';

const defaults = { filter: '', limit: 80, depth: 20, prepare: false };
const copy = (value) => structuredClone(value);

function row(index, parent, depth, overrides = {}) {
  return {
    index,
    parent,
    depth,
    matched: true,
    role: 'AXGroup',
    subrole: '',
    id: '',
    classes: [],
    label: null,
    value: null,
    url: null,
    actions: [],
    attributeNames: [],
    settableAttributeNames: [],
    unknownSettableAttributeNames: [],
    enabled: null,
    focused: null,
    selected: null,
    expanded: null,
    bounds: null,
    redacted: null,
    contentOmitted: null,
    ...overrides,
  };
}

function fixture(options = defaults) {
  const identity = {
    role: 'AXWebArea',
    title: 'Direct messages — Example',
    url: 'https://app.slack.com/client/TEXAMPLE/dms',
    window: { title: 'Example — Slack', bounds: { x: -120, y: 30, width: 1000, height: 700 } },
  };
  return {
    operation: 'inspect',
    mode: 'ui',
    pid: 1234,
    desktop: { private: 'raw sample' },
    ui: {
      captureId: '1bbf1a62-36ce-4f28-8568-45acbf7a2446',
      captureStartedAt: '2026-11-09T13:00:00Z',
      observedAt: '2026-11-09T13:00:01Z',
      root: {
        kind: 'workspace',
        selection: 'unique-workspace',
        before: identity,
        after: copy(identity),
        viewIdentityMatched: true,
      },
      preparation: {
        requested: options.prepare,
        steps: options.prepare ? ['AXManualAccessibility requested once'] : [],
      },
      nodes: [
        row(0, null, 0, { role: 'AXWebArea', contentOmitted: 'aggregate-content' }),
        row(1, 0, 1, {
          classes: ['p-view_contents'],
          label: 'Direct messages',
          contentOmitted: 'aggregate-value',
        }),
        row(2, 1, 2, {
          role: 'AXButton',
          id: 'search',
          label: 'Search',
          enabled: false,
          actions: ['AXPress'],
          bounds: { x: 12, y: 15, width: 100, height: 30 },
        }),
        row(3, 1, 2, {
          role: 'AXComboBox',
          id: 'query',
          label: 'Query',
          value: 'parker',
          focused: true,
          attributeNames: ['AXValue', 'AXEnabled'],
          settableAttributeNames: ['AXValue'],
          unknownSettableAttributeNames: ['AXEnabled'],
        }),
      ],
      coverage: {
        complete: false,
        scanComplete: true,
        selectionMode: 'substring',
        visitedCount: 4,
        matchedCount: 4,
        returnedCount: 4,
        redactedCount: 0,
        readCalls: 50,
        failedReadCalls: 0,
        maxReadCalls: 12000,
        budgetMs: 8000,
        limit: options.limit,
        maxDepth: options.depth,
        filter: options.filter,
        truncated: false,
        reasons: [],
      },
    },
  };
}

function filtered() {
  const options = { ...defaults, filter: 'Query' },
    receipt = fixture(options);
  receipt.ui.nodes = receipt.ui.nodes.filter((node) => node.index !== 2);
  receipt.ui.nodes[0].matched = receipt.ui.nodes[1].matched = false;
  receipt.ui.coverage.matchedCount = 1;
  receipt.ui.coverage.returnedCount = 3;
  return { receipt, options };
}

function observation() {
  const receipt = fixture({ filter: '', limit: 60, depth: 30, prepare: false });
  receipt.ui.coverage.selectionMode = 'diagnostic-controls';
  receipt.ui.coverage.budgetMs = 2000;
  return {
    phase: 'after-error',
    readOnly: true,
    expectedScope: { operation: 'dms', workspaceContext: '/client/TEXAMPLE' },
    ui: receipt.ui,
  };
}

describe('bounded UI diagnostic output', () => {
  test('projects explicit diagnostics without unrelated native receipt data', () => {
    const receipt = fixture();
    receipt.ui.raw = 'private';
    receipt.ui.nodes[2].arbitrary = 'private';
    const result = compactUIOutput(receipt, defaults);
    expect(result.pid).toBe(1234);
    expect(result.desktop).toBeUndefined();
    expect(result.ui.raw).toBeUndefined();
    expect(result.ui.nodes[2].arbitrary).toBeUndefined();
    expect(result.ui.nodes[3].unknownSettableAttributeNames).toEqual(['AXEnabled']);
    expect(JSON.parse(formatUIOutput(result, 'json'))).toEqual(result);
    expect(result.ui.coverage.complete).toBe(false);
  });

  test('text shows hierarchy, capabilities, false state, bounds and capture limits', () => {
    const rendered = formatUIOutput(compactUIOutput(fixture(), defaults));
    expect(rendered).toContain('[2 parent=1] AXButton "Search"');
    expect(rendered).toContain('enabled=false');
    expect(rendered).not.toContain('selected=false');
    expect(rendered).toContain('actions=AXPress');
    expect(rendered).toContain('settable=AXValue');
    expect(rendered).toContain('bounds=12,15 100×30');
    expect(rendered).toContain('References apply only to this capture');
    expect(rendered).toContain('2026-11-09T13:00:00Z to 2026-11-09T13:00:01Z');
    expect(rendered).toContain('not an atomic snapshot');
    expect(rendered).not.toContain('Text abbreviates');
    expect(rendered).not.toContain('click ');
  });

  test('filtered captures retain nonconsecutive capture indices and ancestor context', () => {
    const { receipt, options } = filtered();
    const result = compactUIOutput(receipt, options);
    expect(result.ui.nodes.map((node) => node.index)).toEqual([0, 1, 3]);
    const rendered = formatUIOutput(result);
    expect(rendered).toContain('1 matches among 4 visited nodes');
    expect(rendered).toContain('filter "Query"');
    expect(rendered).toContain('context');
    expect(rendered).not.toContain('[2 ');
  });

  test('preserves unavailable capabilities separately from observed empty capabilities', () => {
    const receipt = fixture();
    for (const key of [
      'actions',
      'attributeNames',
      'settableAttributeNames',
      'unknownSettableAttributeNames',
    ])
      receipt.ui.nodes[2][key] = null;
    const result = compactUIOutput(receipt, defaults);
    expect(result.ui.nodes[2].actions).toBeNull();
    expect(result.ui.nodes[3].actions).toEqual([]);
    expect(formatUIOutput(result)).toContain('actions=unknown');
  });

  test('raw full JSON remains available independently of diagnostic validation', () => {
    const receipt = { status: 'stopped', error: 'native failure', ui: { malformed: true } };
    expect(JSON.parse(formatUIOutput(null, 'full-json', receipt))).toEqual(receipt);
    expect(() => formatUIOutput(null, 'full-json')).toThrow('unavailable');
  });

  test('ordinary inspect keeps its semantic text renderer', () => {
    const rendered = formatOutput({
      operation: 'inspect',
      view: { title: 'Example' },
      note: 'Limited view',
    });
    expect(rendered).toBe('Slack view: Example\n\nLimited view');
    expect(rendered).not.toContain('capture');
  });

  test('reports changed identity and unknown application fallback without freshness claims', () => {
    const changed = fixture();
    changed.ui.root.after.title = 'Different view';
    changed.ui.root.viewIdentityMatched = false;
    expect(formatUIOutput(compactUIOutput(changed, defaults))).toContain(
      'View identity changed during capture'
    );
    const fallback = fixture();
    Object.assign(fallback.ui.root, {
      kind: 'application',
      selection: 'ambiguous-workspaces',
      viewIdentityMatched: null,
    });
    for (const side of ['before', 'after'])
      Object.assign(fallback.ui.root[side], {
        role: 'AXApplication',
        title: null,
        url: null,
        window: null,
      });
    expect(formatUIOutput(compactUIOutput(fallback, defaults))).toContain(
      'comparison unavailable (ambiguous-workspaces)'
    );
  });

  test('records explicit preparation without inventing successful capability changes', () => {
    const options = { ...defaults, prepare: true };
    const rendered = formatUIOutput(compactUIOutput(fixture(options), options));
    expect(rendered).toContain('Accessibility preparation requested; 1 recorded steps');
    expect(rendered).not.toContain('enabled=true');
  });

  test('labels a retained starting title when the final title is unavailable', () => {
    const receipt = fixture();
    receipt.ui.root.after.title = null;
    receipt.ui.root.viewIdentityMatched = null;
    const rendered = formatUIOutput(compactUIOutput(receipt, defaults));
    expect(rendered).toContain('title at capture start');
    expect(rendered).toContain('View identity comparison unavailable');
  });

  test('sanitizes terminal and bidi controls while JSON retains captured labels', () => {
    const receipt = fixture();
    receipt.ui.nodes[2].label = '\u001b[31mSearch\u001b[0m\n\u202eInjected';
    const result = compactUIOutput(receipt, defaults),
      rendered = formatUIOutput(result);
    expect(rendered).toContain('"Search Injected"');
    expect(rendered).not.toMatch(/[\x1b\u202e]/);
    expect(JSON.parse(formatUIOutput(result, 'json')).ui.nodes[2].label).toBe(
      receipt.ui.nodes[2].label
    );
  });

  test('labels text shortening while retaining complete bounded JSON', () => {
    const receipt = fixture();
    receipt.ui.nodes[2].label = 'x'.repeat(200);
    receipt.ui.nodes[2].classes = ['first', 'second', 'third'];
    const result = compactUIOutput(receipt, defaults);
    expect(formatUIOutput(result)).toContain('Text abbreviates metadata');
    expect(result.ui.nodes[2].label).toHaveLength(200);
    expect(result.ui.nodes[2].classes).toHaveLength(3);
  });

  test('allows a zero-result bounded capture without claiming no controls exist', () => {
    const options = { ...defaults, filter: 'Query', limit: 1 };
    const receipt = fixture(options);
    receipt.ui.nodes = [];
    Object.assign(receipt.ui.coverage, {
      matchedCount: 1,
      returnedCount: 0,
      scanComplete: false,
      truncated: true,
      reasons: ['result-limit'],
    });
    const rendered = formatUIOutput(compactUIOutput(receipt, options));
    expect(rendered).toContain('No matching node and its complete ancestor chain fit this capture');
    expect(rendered).toContain('Limited: result-limit');
  });

  test('distinguishes finished traversal from field/capability clipping', () => {
    const receipt = fixture();
    receipt.ui.nodes[2].truncatedFields = ['label'];
    Object.assign(receipt.ui.coverage, {
      truncated: true,
      reasons: ['field-limit', 'capability-limit'],
    });
    expect(compactUIOutput(receipt, defaults).ui.coverage.scanComplete).toBe(true);
  });

  test('preserves optional repeated-reference counts without treating aliases as incomplete traversal', () => {
    const receipt = fixture();
    Object.assign(receipt.ui.coverage, { repeatedReferences: 8, rootRepeatedReferences: 3 });
    const result = compactUIOutput(receipt, defaults);
    expect(result.ui.coverage).toMatchObject({
      repeatedReferences: 8,
      rootRepeatedReferences: 3,
      scanComplete: true,
      truncated: false,
      reasons: [],
    });
    expect(JSON.parse(formatUIOutput(result, 'json')).ui.coverage).toEqual(result.ui.coverage);
    expect(JSON.parse(formatUIOutput(result, 'full-json', receipt))).toEqual(receipt);
    expect(formatUIOutput(result)).toContain(
      'Skipped repeated AX references: 8 during capture; 3 during root discovery.'
    );
    expect(formatUIOutput(result)).not.toContain('Limited:');
  });

  test('keeps measured zero distinct from absent repeat counters in older receipts', () => {
    const receipt = fixture();
    const old = compactUIOutput(receipt, defaults);
    expect(Object.hasOwn(old.ui.coverage, 'repeatedReferences')).toBe(false);
    expect(Object.hasOwn(old.ui.coverage, 'rootRepeatedReferences')).toBe(false);
    Object.assign(receipt.ui.coverage, { repeatedReferences: 0, rootRepeatedReferences: 0 });
    const result = compactUIOutput(receipt, defaults);
    expect(JSON.parse(formatUIOutput(result, 'json')).ui.coverage).toMatchObject({
      repeatedReferences: 0,
      rootRepeatedReferences: 0,
    });
    expect(formatUIOutput(result)).not.toContain('Skipped repeated AX references');
    expect(formatUIOutput(result)).toBe(formatUIOutput(old));
  });

  test.each(['repeatedReferences', 'rootRepeatedReferences'])(
    'validates independent optional %s counts as nonnegative safe integers',
    (field) => {
      for (const value of [-1, 0.5, null, '1', Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const receipt = fixture();
        receipt.ui.coverage[field] = value;
        expect(() => compactUIOutput(receipt, defaults)).toThrow(field);
      }
      const receipt = fixture();
      receipt.ui.coverage[field] = Number.MAX_SAFE_INTEGER;
      const result = compactUIOutput(receipt, defaults);
      expect(result.ui.coverage[field]).toBe(Number.MAX_SAFE_INTEGER);
      expect(result.ui.coverage.scanComplete).toBe(true);
    }
  );

  test('retains bounded incomplete root discovery and AX read failures', () => {
    const receipt = fixture();
    Object.assign(receipt.ui.root, {
      kind: 'application',
      selection: 'selection-incomplete',
      viewIdentityMatched: null,
    });
    Object.assign(receipt.ui.coverage, {
      failedReadCalls: 2,
      scanComplete: false,
      truncated: true,
      reasons: ['root-selection-limit', 'ax-read-error'],
    });
    const result = compactUIOutput(receipt, defaults);
    expect(result.ui.coverage.failedReadCalls).toBe(2);
    expect(formatUIOutput(result)).toContain('root-selection-limit, ax-read-error');
    receipt.ui.coverage.reasons.pop();
    expect(() => compactUIOutput(receipt, defaults)).toThrow('AX read failures omitted');
  });

  test('retains bounded AX error codes in diagnostic text and JSON', () => {
    const receipt = fixture();
    Object.assign(receipt.ui.coverage, {
      failedReadCalls: 3,
      scanComplete: false,
      truncated: true,
      reasons: ['ax-read-error'],
      axErrors: [
        { code: -25211, name: 'api-disabled', count: 2 },
        { code: -25204, name: 'cannot-complete', count: 1 },
      ],
    });
    const result = compactUIOutput(receipt, defaults);
    expect(result.ui.coverage.axErrors).toEqual(receipt.ui.coverage.axErrors);
    expect(JSON.parse(formatUIOutput(result, 'json')).ui.coverage.axErrors).toEqual(
      receipt.ui.coverage.axErrors
    );
    expect(formatUIOutput(result)).toContain('api-disabled (-25211) ×2');
    expect(formatUIOutput(result)).toContain('cannot-complete (-25204) ×1');
    expect(compactUIOutput(fixture(), defaults).ui.coverage.axErrors).toBeUndefined();
  });

  test('rejects inconsistent, repeated or unbounded AX error counts', () => {
    const valid = { code: -25211, name: 'api-disabled', count: 1 };
    for (const axErrors of [
      null,
      [valid, valid],
      [{ ...valid, code: 0 }],
      [{ ...valid, name: 'cannot-complete' }],
      [{ ...valid, count: 0 }],
      [{ ...valid, count: 2 }],
      [{ ...valid, count: 0.5 }],
      Array(17).fill(valid),
    ]) {
      const receipt = fixture();
      Object.assign(receipt.ui.coverage, {
        failedReadCalls: 1,
        scanComplete: false,
        truncated: true,
        reasons: ['ax-read-error'],
        axErrors,
      });
      expect(() => compactUIOutput(receipt, defaults)).toThrow();
    }
  });

  test('redacted subtrees contain only structure and never retain descendants', () => {
    const receipt = fixture();
    Object.assign(receipt.ui.nodes[3], {
      role: 'AXTextArea',
      label: null,
      value: null,
      redacted: 'editable-content',
    });
    Object.assign(receipt.ui.coverage, {
      redactedCount: 1,
      scanComplete: false,
      truncated: true,
      reasons: ['redacted-subtree'],
    });
    expect(formatUIOutput(compactUIOutput(receipt, defaults))).toContain(
      'redacted=editable-content'
    );
    receipt.ui.nodes[3].value = 'private draft';
    expect(() => compactUIOutput(receipt, defaults)).toThrow('redacted node exposes content');
  });

  test('unknown classification retains an unreadable stub without content or descendants', () => {
    const receipt = fixture();
    Object.assign(receipt.ui.nodes[3], {
      role: '',
      subrole: '',
      classes: [],
      label: null,
      value: null,
      url: null,
      redacted: 'unreadable-content',
    });
    Object.assign(receipt.ui.coverage, {
      redactedCount: 1,
      failedReadCalls: 1,
      scanComplete: false,
      truncated: true,
      reasons: ['ax-read-error', 'redacted-subtree'],
    });
    const projected = compactUIOutput(receipt, defaults);
    expect(projected.ui.nodes[3].redacted).toBe('unreadable-content');
    expect(formatUIOutput(projected)).toContain('redacted=unreadable-content');
    for (const field of ['label', 'value', 'url']) {
      const leaked = copy(receipt);
      leaked.ui.nodes[3][field] = 'unclassified private content';
      expect(() => compactUIOutput(leaked, defaults)).toThrow('redacted node exposes content');
    }
    receipt.ui.nodes.push(row(4, 3, 3));
    receipt.ui.coverage.visitedCount =
      receipt.ui.coverage.matchedCount =
      receipt.ui.coverage.returnedCount =
        5;
    expect(() => compactUIOutput(receipt, defaults)).toThrow('sensitive subtree was traversed');
  });

  test.each([
    [
      'wrong operation',
      (r) => {
        r.operation = 'search';
      },
    ],
    [
      'wrong mode',
      (r) => {
        r.mode = 'semantic';
      },
    ],
    [
      'native failure',
      (r) => {
        r.error = 'stopped';
      },
    ],
    [
      'bad UUID',
      (r) => {
        r.ui.captureId = 'not-a-capture-id';
      },
    ],
    [
      'reversed time',
      (r) => {
        r.ui.observedAt = '2026-11-09T12:00:00Z';
      },
    ],
    [
      'invalid date',
      (r) => {
        r.ui.observedAt = '2026-02-30T13:00:00Z';
      },
    ],
    [
      'wrong filter',
      (r) => {
        r.ui.coverage.filter = 'other';
      },
    ],
    [
      'wrong limit',
      (r) => {
        r.ui.coverage.limit = 100;
      },
    ],
    [
      'wrong depth',
      (r) => {
        r.ui.coverage.maxDepth = 30;
      },
    ],
    [
      'hidden preparation',
      (r) => {
        r.ui.preparation.steps = ['unexpected'];
      },
    ],
    [
      'wrong selection mode',
      (r) => {
        r.ui.coverage.selectionMode = 'diagnostic-controls';
      },
    ],
    [
      'incorrect total',
      (r) => {
        r.ui.coverage.returnedCount = 3;
      },
    ],
    [
      'impossible match count',
      (r) => {
        r.ui.coverage.matchedCount = 5;
      },
    ],
    [
      'visit overflow',
      (r) => {
        r.ui.coverage.visitedCount = 5001;
      },
    ],
    [
      'read overflow',
      (r) => {
        r.ui.coverage.readCalls = 12001;
      },
    ],
    [
      'unknown reason',
      (r) => {
        r.ui.coverage.reasons = ['all-results'];
      },
    ],
    [
      'false complete claim',
      (r) => {
        r.ui.coverage.complete = true;
      },
    ],
    [
      'hidden clipping',
      (r) => {
        r.ui.nodes[2].truncatedFields = ['label'];
      },
    ],
    [
      'duplicate index',
      (r) => {
        r.ui.nodes[3].index = 2;
      },
    ],
    [
      'dangling parent',
      (r) => {
        r.ui.nodes[2].parent = 3;
      },
    ],
    [
      'wrong depth',
      (r) => {
        r.ui.nodes[2].depth = 1;
      },
    ],
    [
      'second root',
      (r) => {
        r.ui.nodes[2].parent = null;
      },
    ],
    [
      'reopened subtree',
      (r) => {
        r.ui.nodes[3].parent = 0;
        r.ui.nodes[3].depth = 1;
        r.ui.nodes.push(row(4, 2, 3));
        r.ui.coverage.visitedCount = r.ui.coverage.matchedCount = r.ui.coverage.returnedCount = 5;
      },
    ],
    [
      'nonboolean state',
      (r) => {
        r.ui.nodes[2].enabled = 'true';
      },
    ],
    [
      'nonfinite bounds',
      (r) => {
        r.ui.nodes[2].bounds.x = Infinity;
      },
    ],
    [
      'negative size',
      (r) => {
        r.ui.nodes[2].bounds.width = -1;
      },
    ],
    [
      'oversize field',
      (r) => {
        r.ui.nodes[2].id = 'x'.repeat(1001);
      },
    ],
    [
      'unpaired Unicode',
      (r) => {
        r.ui.nodes[2].label = '\ud800';
      },
    ],
    [
      'conflicting capability',
      (r) => {
        r.ui.nodes[3].unknownSettableAttributeNames.push('AXValue');
      },
    ],
    [
      'unknown capability',
      (r) => {
        r.ui.nodes[3].settableAttributeNames.push('AXTitle');
      },
    ],
    [
      'aggregate leak',
      (r) => {
        r.ui.nodes[0].value = 'private aggregate';
      },
    ],
    [
      'identity contradiction',
      (r) => {
        r.ui.root.after.title = 'Different';
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const receipt = fixture();
    mutate(receipt);
    expect(() => compactUIOutput(receipt, defaults)).toThrow('Invalid UI inspection receipt');
  });

  test('rejects orphaned context and discarded sensitive subtree ancestry', () => {
    const { receipt, options } = filtered();
    receipt.ui.nodes[2].matched = false;
    expect(() => compactUIOutput(receipt, options)).toThrow('context');
    const sensitive = fixture();
    sensitive.ui.nodes[1].redacted = 'composer-content';
    sensitive.ui.nodes[1].label = null;
    sensitive.ui.coverage.redactedCount = 1;
    Object.assign(sensitive.ui.coverage, {
      truncated: true,
      scanComplete: false,
      reasons: ['redacted-subtree'],
    });
    expect(() => compactUIOutput(sensitive, defaults)).toThrow('sensitive subtree');
  });
});

describe('after-error UI observation', () => {
  test('retains repeated-reference evidence in nested error diagnostics', () => {
    const raw = observation();
    Object.assign(raw.ui.coverage, { repeatedReferences: 1, rootRepeatedReferences: 0 });
    const observed = compactUIObservation(raw);
    const result = JSON.parse(
      formatOutput(
        {
          operation: 'inspect',
          status: 'stopped',
          error: 'Original failure',
          observation: observed,
        },
        'json'
      )
    );
    expect(result.error).toBe('Original failure');
    expect(result.observation.ui.coverage).toMatchObject({
      repeatedReferences: 1,
      rootRepeatedReferences: 0,
      scanComplete: true,
    });
  });

  test('ordinary error JSON keeps validated nested diagnostic nodes through cleaning', () => {
    const observed = compactUIObservation(observation());
    const compact = {
      operation: 'dms',
      status: 'stopped',
      error: 'Original failure',
      observation: observed,
    };
    const json = JSON.parse(formatOutput(compact, 'json'));
    expect(json.error).toBe('Original failure');
    expect(json.observation).toEqual(observed);
    expect(json.observation.ui.nodes).toHaveLength(4);
    expect(formatOutput(compact)).toContain('Stopped: Original failure');
    expect(formatOutput(compact).match(/After-error observation/g)).toHaveLength(1);
  });

  test('malformed observations leave original errors and partial channel prefixes unchanged', () => {
    const invalid = observation();
    invalid.ui.nodes[3].parent = 999;
    const stopped = {
      operation: 'dms',
      status: 'stopped',
      error: 'Original failure',
      observation: invalid,
    };
    expect(formatOutput(stopped)).toBe('Stopped: Original failure');
    expect(JSON.parse(formatOutput(stopped, 'json')).observation).toBeUndefined();
    const partial = {
      operation: 'channels',
      status: 'partial',
      error: 'Later failure',
      observation: invalid,
      channels: [
        {
          id: 'CEXAMPLE',
          name: 'example',
          navigation: { command: 'read-channel', args: ['example'] },
        },
      ],
      coverage: { complete: false },
      pagination: {
        supported: true,
        batch: {
          requestedPages: 2,
          completedPages: 1,
          attemptedPages: 2,
          direction: 'down',
          stopReason: 'error',
          deduplicatedCount: 0,
        },
      },
    };
    const text = formatOutput(partial),
      json = JSON.parse(formatOutput(partial, 'json'));
    expect(text).toContain('#example');
    expect(text).toContain('Stopped: Later failure');
    expect(text).not.toContain('After-error observation');
    expect(json.status).toBe('partial');
    expect(json.channels).toHaveLength(1);
    expect(json.observation).toBeUndefined();
    partial.observation = compactUIObservation(observation());
    expect(formatOutput(partial).match(/After-error observation/g)).toHaveLength(1);
  });

  test('projection is idempotent and retains only explicit scope fields', () => {
    const raw = observation();
    raw.expectedScope.query = 'private query';
    raw.expectedScope.url = 'wrong expected view';
    raw.private = 'unrelated native data';
    const result = compactUIObservation(raw);
    expect(compactUIObservation(result)).toEqual(result);
    expect(result.expectedScope).toEqual({
      operation: 'dms',
      workspaceContext: '/client/TEXAMPLE',
    });
    expect(result.private).toBeUndefined();
  });

  test('summary is bounded, prioritizes focused controls and does not diagnose cause', () => {
    const raw = observation();
    for (let index = 4; index < 14; index++)
      raw.ui.nodes.push(row(index, 1, 2, { role: 'AXButton', label: `Button ${index}` }));
    raw.ui.coverage.visitedCount =
      raw.ui.coverage.matchedCount =
      raw.ui.coverage.returnedCount =
        14;
    const result = compactUIObservation(raw),
      rendered = formatUIObservation(result);
    expect(rendered).toContain('does not establish the cause');
    expect(rendered).toContain('Observed controls: AXComboBox "Query"');
    expect(rendered).toContain('Button 7');
    expect(rendered).not.toContain('Button 8');
    expect(rendered).not.toContain('parker');
    expect(rendered).toContain('Inspect: inspect --ui');
    expect(rendered.split('\n')).toHaveLength(5);
  });

  test('diagnostic selection cannot masquerade as a requested substring capture', () => {
    const raw = observation();
    raw.ui.coverage.selectionMode = 'substring';
    expect(() => compactUIObservation(raw)).toThrow('coverage');
  });

  test('rejects unbounded, prepared or input-producing error observations', () => {
    for (const mutate of [
      (r) => {
        r.readOnly = false;
      },
      (r) => {
        r.phase = 'before';
      },
      (r) => {
        r.ui.coverage.limit = 80;
      },
      (r) => {
        r.ui.coverage.budgetMs = 8000;
      },
      (r) => {
        r.ui.preparation.requested = true;
      },
      (r) => {
        r.expectedScope.workspaceContext = '/client/TEXAMPLE/dms';
      },
    ]) {
      const raw = observation();
      mutate(raw);
      expect(() => compactUIObservation(raw)).toThrow('Invalid UI inspection receipt');
    }
  });
});
