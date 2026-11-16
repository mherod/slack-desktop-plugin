// Opt-in accessibility diagnostics. These references describe one capture;
// they are never selectors or authorization for an input operation.
const reasons = new Set([
  'result-limit',
  'depth-limit',
  'visited-limit',
  'deadline',
  'redacted-subtree',
  'capability-limit',
  'field-limit',
  'operation-limit',
  'root-selection-limit',
  'ax-read-error',
]);
const redactions = new Set([
  'secure-content',
  'editable-content',
  'composer-content',
  'unreadable-content',
]);
const selections = new Set([
  'unique-workspace',
  'no-workspace',
  'ambiguous-workspaces',
  'selection-incomplete',
]);
const nodeFields = new Set(['role', 'subrole', 'id', 'classes', 'label', 'value', 'url']);
const identityFields = new Set(['role', 'title', 'url', 'window.title']);
const axErrorNames = new Map([
  [-25200, 'failure'],
  [-25201, 'illegal-argument'],
  [-25202, 'invalid-ui-element'],
  [-25204, 'cannot-complete'],
  [-25205, 'attribute-unsupported'],
  [-25206, 'action-unsupported'],
  [-25208, 'not-implemented'],
  [-25211, 'api-disabled'],
  [-25212, 'no-value'],
]);

function requireUI(condition, message) {
  if (!condition) throw new Error(`Invalid UI inspection receipt: ${message}`);
}

function object(value, name) {
  requireUI(value !== null && typeof value === 'object' && !Array.isArray(value), name);
  return value;
}

function text(value, name, maximum = 1000, nullable = false) {
  if (nullable && value === null) return null;
  requireUI(typeof value === 'string' && value.length <= maximum * 2, name);
  const characters = Array.from(value);
  requireUI(
    characters.length <= maximum &&
      characters.every((character) => {
        const point = character.codePointAt(0);
        return point < 0xd800 || point > 0xdfff;
      }),
    name
  );
  return value;
}

function integer(value, name, minimum, maximum) {
  requireUI(Number.isSafeInteger(value) && value >= minimum && value <= maximum, name);
  return value;
}

function boolean(value, name, nullable = false) {
  requireUI(typeof value === 'boolean' || (nullable && value === null), name);
  return value;
}

function strings(value, name, maximum = 128, width = 128, nullable = false, unique = true) {
  if (nullable && value === null) return null;
  requireUI(Array.isArray(value) && value.length <= maximum, name);
  const result = value.map((entry) => text(entry, name, width));
  requireUI(!unique || new Set(result).size === result.length, `${name} contains duplicates`);
  return result;
}

function clipped(value, allowed, name) {
  if (value === undefined) return {};
  const fields = strings(value, name, allowed.size, 128);
  requireUI(fields.length > 0 && fields.every((field) => allowed.has(field)), name);
  return { truncatedFields: fields };
}

function timestamp(value, name) {
  text(value, name, 24);
  requireUI(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value), name);
  const parsed = Date.parse(value);
  requireUI(Number.isFinite(parsed), name);
  const canonical = new Date(parsed).toISOString();
  requireUI(value === canonical || value === canonical.replace('.000Z', 'Z'), name);
  return value;
}

function bounds(value, name) {
  if (value === null) return null;
  object(value, name);
  const result = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    requireUI(typeof value[key] === 'number' && Number.isFinite(value[key]), `${name}.${key}`);
    result[key] = value[key];
  }
  requireUI(result.width >= 0 && result.height >= 0, `${name} has negative size`);
  return result;
}

function identity(value) {
  object(value, 'root identity');
  let window = null;
  if (value.window !== null) {
    object(value.window, 'root window');
    window = {
      title: text(value.window.title, 'window title', 1000, true),
      bounds: bounds(value.window.bounds, 'window bounds'),
    };
  }
  return {
    role: text(value.role, 'root role', 128),
    title: text(value.title, 'root title', 1000, true),
    url: text(value.url, 'root URL', 1000, true),
    window,
    ...clipped(value.truncatedFields, identityFields, 'root truncated fields'),
  };
}

function node(value, maximumDepth, visitedCount) {
  object(value, 'node');
  const result = {
    index: integer(value.index, 'node index', 0, visitedCount - 1),
    parent:
      value.parent === null ? null : integer(value.parent, 'node parent', 0, visitedCount - 1),
    depth: integer(value.depth, 'node depth', 0, maximumDepth),
    matched: boolean(value.matched, 'node matched'),
    role: text(value.role, 'node role', 128),
    subrole: text(value.subrole, 'node subrole', 128),
    id: text(value.id, 'node id'),
    classes: strings(value.classes, 'node classes', 128, 256, false, false),
    label: text(value.label, 'node label', 1000, true),
    value: text(value.value, 'node value', 1000, true),
    url: text(value.url, 'node URL', 1000, true),
    actions: strings(value.actions, 'node actions', 128, 128, true),
    attributeNames: strings(value.attributeNames, 'node attributes', 128, 128, true),
    settableAttributeNames: strings(
      value.settableAttributeNames,
      'settable attributes',
      128,
      128,
      true
    ),
    unknownSettableAttributeNames: strings(
      value.unknownSettableAttributeNames,
      'unknown settable attributes',
      128,
      128,
      true
    ),
    enabled: boolean(value.enabled, 'node enabled', true),
    focused: boolean(value.focused, 'node focused', true),
    selected: boolean(value.selected, 'node selected', true),
    expanded: boolean(value.expanded, 'node expanded', true),
    bounds: bounds(value.bounds, 'node bounds'),
    redacted: value.redacted,
    contentOmitted: value.contentOmitted ?? null,
    ...clipped(value.truncatedFields, nodeFields, 'node truncated fields'),
  };
  requireUI(result.redacted === null || redactions.has(result.redacted), 'node redaction');
  requireUI(
    result.contentOmitted === null ||
      ['aggregate-content', 'aggregate-value'].includes(result.contentOmitted),
    'node aggregate content omission'
  );
  requireUI(
    result.redacted === null ||
      (result.label === null && result.value === null && result.url === null),
    'redacted node exposes content'
  );
  requireUI(
    result.contentOmitted === null ||
      (result.value === null &&
        result.url === null &&
        (result.contentOmitted !== 'aggregate-content' || result.label === null)),
    'aggregate content was not omitted'
  );
  const attributes = result.attributeNames;
  if (attributes === null) {
    requireUI(
      result.settableAttributeNames === null && result.unknownSettableAttributeNames === null,
      'settable evidence requires observed attribute names'
    );
  } else {
    requireUI(
      result.settableAttributeNames !== null && result.unknownSettableAttributeNames !== null,
      'attribute capability evidence is incomplete'
    );
    requireUI(
      [...result.settableAttributeNames, ...result.unknownSettableAttributeNames].every((name) =>
        attributes.includes(name)
      ) &&
        result.settableAttributeNames.every(
          (name) => !result.unknownSettableAttributeNames.includes(name)
        ),
      'attribute capability lists conflict'
    );
  }
  return result;
}

function requestedOptions(value) {
  object(value, 'requested UI options');
  const filter = text(value.filter, 'requested filter', 200);
  requireUI(!/[\x00-\x1f\x7f-\x9f]/.test(filter), 'requested filter contains controls');
  return {
    filter,
    limit: integer(value.limit, 'requested limit', 1, 500),
    depth: integer(value.depth, 'requested depth', 0, 40),
    prepare: boolean(value.prepare, 'requested preparation'),
  };
}

function projectUI(value, requested, diagnostic = false) {
  object(value, 'ui');
  requireUI(
    typeof value.captureId === 'string' &&
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value.captureId),
    'capture id'
  );
  const captureStartedAt = timestamp(value.captureStartedAt, 'capture start');
  const observedAt = timestamp(value.observedAt, 'capture end');
  requireUI(Date.parse(observedAt) >= Date.parse(captureStartedAt), 'capture timestamps reversed');
  const options = requestedOptions(requested);
  const root = object(value.root, 'root');
  requireUI(selections.has(root.selection), 'root selection');
  requireUI(
    root.kind === (root.selection === 'unique-workspace' ? 'workspace' : 'application'),
    'root kind and selection disagree'
  );
  const projectedRoot = {
    kind: root.kind,
    selection: root.selection,
    before: identity(root.before),
    after: identity(root.after),
    viewIdentityMatched: boolean(root.viewIdentityMatched, 'view identity comparison', true),
  };
  if (projectedRoot.viewIdentityMatched !== null)
    requireUI(
      root.kind === 'workspace' &&
        !projectedRoot.before.truncatedFields &&
        !projectedRoot.after.truncatedFields,
      'view comparison lacks complete workspace identity'
    );
  if (projectedRoot.viewIdentityMatched === true)
    requireUI(
      JSON.stringify(projectedRoot.before) === JSON.stringify(projectedRoot.after),
      'matched view identities differ'
    );
  const preparation = object(value.preparation, 'preparation');
  requireUI(preparation.requested === options.prepare, 'preparation differs from request');
  const steps = strings(preparation.steps, 'preparation steps', 20, 1000, false, false);
  requireUI(preparation.requested || steps.length === 0, 'unrequested preparation steps');
  const rawCoverage = object(value.coverage, 'coverage');
  requireUI(
    rawCoverage.complete === false &&
      rawCoverage.selectionMode === (diagnostic ? 'diagnostic-controls' : 'substring') &&
      rawCoverage.limit === options.limit &&
      rawCoverage.maxDepth === options.depth &&
      rawCoverage.filter === options.filter,
    'coverage differs from the requested bounded capture'
  );
  const coverage = {
    complete: false,
    scanComplete: boolean(rawCoverage.scanComplete, 'scan completeness'),
    selectionMode: rawCoverage.selectionMode,
    visitedCount: integer(rawCoverage.visitedCount, 'visited count', 0, 5000),
    matchedCount: integer(rawCoverage.matchedCount, 'matched count', 0, 5000),
    returnedCount: integer(rawCoverage.returnedCount, 'returned count', 0, options.limit),
    redactedCount: integer(rawCoverage.redactedCount, 'redacted count', 0, 5000),
    readCalls: integer(rawCoverage.readCalls, 'AX read count', 0, 12000),
    failedReadCalls: integer(rawCoverage.failedReadCalls, 'failed AX read count', 0, 12000),
    maxReadCalls: integer(rawCoverage.maxReadCalls, 'AX read limit', 12000, 12000),
    budgetMs: integer(
      rawCoverage.budgetMs,
      'capture budget',
      diagnostic ? 2000 : 8000,
      diagnostic ? 2000 : 8000
    ),
    limit: options.limit,
    maxDepth: options.depth,
    filter: options.filter,
    truncated: boolean(rawCoverage.truncated, 'capture truncation'),
    reasons: strings(rawCoverage.reasons, 'coverage reasons', reasons.size, 32),
  };
  for (const field of ['repeatedReferences', 'rootRepeatedReferences']) {
    if (rawCoverage[field] !== undefined)
      coverage[field] = integer(rawCoverage[field], field, 0, Number.MAX_SAFE_INTEGER);
  }
  if (rawCoverage.axErrors !== undefined) {
    requireUI(
      Array.isArray(rawCoverage.axErrors) && rawCoverage.axErrors.length <= 16,
      'AX errors'
    );
    coverage.axErrors = rawCoverage.axErrors.map((entry) => {
      object(entry, 'AX error');
      const code = integer(entry.code, 'AX error code', -2147483648, -1);
      requireUI(
        entry.name === (axErrorNames.get(code) ?? 'unknown'),
        'AX error name disagrees with code'
      );
      return { code, name: entry.name, count: integer(entry.count, 'AX error count', 1, 12000) };
    });
    requireUI(
      coverage.axErrors.every(
        (entry, index, values) => index === 0 || entry.code > values[index - 1].code
      ) &&
        coverage.axErrors.reduce((sum, entry) => sum + entry.count, 0) <= coverage.failedReadCalls,
      'AX error counts or order disagree with failed reads'
    );
  }
  requireUI(
    coverage.reasons.every((reason) => reasons.has(reason)),
    'unknown coverage reason'
  );
  requireUI(
    coverage.truncated === coverage.reasons.length > 0 &&
      coverage.scanComplete ===
        !coverage.reasons.some((reason) => !['capability-limit', 'field-limit'].includes(reason)),
    'coverage completeness disagrees with limits'
  );
  requireUI(
    coverage.matchedCount <= coverage.visitedCount &&
      coverage.redactedCount <= coverage.visitedCount &&
      coverage.failedReadCalls <= coverage.readCalls,
    'observed counts exceed visited nodes'
  );
  requireUI(
    coverage.failedReadCalls === 0 || coverage.reasons.includes('ax-read-error'),
    'AX read failures omitted from coverage'
  );
  requireUI(
    Array.isArray(value.nodes) && value.nodes.length === coverage.returnedCount,
    'returned node count'
  );
  const nodes = value.nodes.map((entry) => node(entry, options.depth, coverage.visitedCount));
  const byIndex = new Map(),
    stack = [],
    neededContext = new Set();
  let previous = -1;
  for (const entry of nodes) {
    requireUI(entry.index > previous, 'node indices are not in capture order');
    previous = entry.index;
    if (entry.parent === null)
      requireUI(byIndex.size === 0 && entry.index === 0 && entry.depth === 0, 'unrooted hierarchy');
    else {
      const parent = byIndex.get(entry.parent);
      requireUI(parent && entry.depth === parent.depth + 1, 'missing or inconsistent parent');
      requireUI(parent.redacted === null, 'sensitive subtree was traversed');
      while (stack.length && stack.at(-1) !== entry.parent) stack.pop();
      requireUI(stack.length > 0, 'hierarchy is not in depth-first order');
    }
    stack.push(entry.index);
    byIndex.set(entry.index, entry);
    if (entry.matched) {
      let ancestor = entry.parent;
      while (ancestor !== null) {
        neededContext.add(ancestor);
        ancestor = byIndex.get(ancestor).parent;
      }
    }
  }
  requireUI(
    nodes.filter((entry) => entry.matched).length <= coverage.matchedCount &&
      nodes.filter((entry) => entry.redacted !== null).length <= coverage.redactedCount &&
      nodes.every((entry) => entry.matched || neededContext.has(entry.index)),
    'retained matches or context disagree with coverage'
  );
  if (!diagnostic && options.filter === '')
    requireUI(
      nodes.every((entry) => entry.matched) && coverage.matchedCount === coverage.visitedCount,
      'empty filter must match every visited node'
    );
  requireUI(
    coverage.redactedCount === 0 || coverage.reasons.includes('redacted-subtree'),
    'redaction omitted from coverage'
  );
  requireUI(
    (!nodes.some((entry) => entry.truncatedFields) &&
      !projectedRoot.before.truncatedFields &&
      !projectedRoot.after.truncatedFields) ||
      coverage.reasons.includes('field-limit'),
    'field clipping omitted from coverage'
  );
  return {
    captureId: value.captureId,
    captureStartedAt,
    observedAt,
    root: projectedRoot,
    preparation: { requested: preparation.requested, steps },
    nodes,
    coverage,
  };
}

export function compactUIOutput(receipt, requestedUI) {
  object(receipt, 'receipt');
  requireUI(
    receipt.operation === 'inspect' &&
      receipt.mode === 'ui' &&
      !receipt.error &&
      (receipt.status === undefined || receipt.status === 'ok'),
    'not a successful inspect --ui receipt'
  );
  return {
    schemaVersion: 1,
    operation: 'inspect',
    mode: 'ui',
    pid: integer(receipt.pid, 'Slack process id', 1, 2147483647),
    ui: projectUI(receipt.ui, requestedUI),
  };
}

export function compactUIObservation(observation) {
  object(observation, 'after-error observation');
  requireUI(
    observation.phase === 'after-error' && observation.readOnly === true,
    'observation is not read-only after-error evidence'
  );
  let expectedScope = null;
  if (observation.expectedScope !== null) {
    const scope = object(observation.expectedScope, 'expected scope');
    requireUI(
      [
        'inspect',
        'channels',
        'dms',
        'read-channel',
        'read-dm',
        'read-thread',
        'search',
        'channel',
      ].includes(scope.operation),
      'expected operation'
    );
    expectedScope = {
      operation: scope.operation,
    };
    if (scope.workspaceContext !== undefined) {
      const context = text(scope.workspaceContext, 'expected workspace context', 1000);
      requireUI(/^\/client\/[A-Z0-9]+$/.test(context), 'expected workspace context');
      expectedScope.workspaceContext = context;
    }
  }
  return {
    phase: 'after-error',
    readOnly: true,
    expectedScope,
    ui: projectUI(observation.ui, { filter: '', limit: 60, depth: 30, prepare: false }, true),
  };
}

function plain(value) {
  return typeof value === 'string'
    ? value
        .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, '')
        .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[@-_]/g, '')
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
}

function short(value, maximum = 120) {
  const characters = Array.from(plain(value));
  return characters.length > maximum
    ? `${characters.slice(0, maximum - 1).join('')}…`
    : characters.join('');
}
const quoted = (value, maximum = 120) => JSON.stringify(short(value, maximum));
const numeric = (value) => String(Math.round(value * 10) / 10);

function identityLine(ui) {
  const after = short(ui.root.after.title),
    title = after || short(ui.root.before.title);
  return `Slack UI${title ? `: ${title}` : ''} (${title && !after ? 'title at capture start; ' : ''}${ui.root.kind} root).`;
}

function renderUI(compact) {
  const { ui } = compact,
    coverage = ui.coverage;
  const lines = [
    identityLine(ui),
    `Captured ${ui.captureStartedAt} to ${ui.observedAt}; capture ${ui.captureId}. References apply only to this capture.`,
    `${coverage.returnedCount} nodes returned; ${coverage.matchedCount} matches among ${coverage.visitedCount} visited nodes. Limit ${coverage.limit}, depth ${coverage.maxDepth}${coverage.filter ? `, filter ${quoted(coverage.filter, 200)}` : ''}.`,
    ui.root.viewIdentityMatched === true
      ? 'View identity matched at capture boundaries; this is not an atomic snapshot.'
      : ui.root.viewIdentityMatched === false
        ? 'View identity changed during capture; inspect again before relying on this snapshot.'
        : `View identity comparison unavailable (${ui.root.selection}).`,
  ];
  if (ui.preparation.requested)
    lines.push(
      `Accessibility preparation requested; ${ui.preparation.steps.length} recorded steps.`
    );
  const repeated = [
    coverage.repeatedReferences > 0 ? `${coverage.repeatedReferences} during capture` : '',
    coverage.rootRepeatedReferences > 0
      ? `${coverage.rootRepeatedReferences} during root discovery`
      : '',
  ].filter(Boolean);
  if (repeated.length) lines.push(`Skipped repeated AX references: ${repeated.join('; ')}.`);
  if (coverage.reasons.length) lines.push(`Limited: ${coverage.reasons.join(', ')}.`);
  if (coverage.axErrors?.length)
    lines.push(
      `AX read errors: ${coverage.axErrors.map(({ name, code, count }) => `${name} (${code}) ×${count}`).join('; ')}.`
    );
  lines.push(
    'Unexposed UI remains outside coverage; advertised capabilities are observations, not input commands.'
  );
  let shortened = false;
  for (const entry of ui.nodes) {
    const label = entry.label ? ` ${quoted(entry.label)}` : '';
    const details = [];
    if (entry.id) details.push(`id=${quoted(entry.id, 100)}`);
    if (entry.value !== null && entry.value !== entry.label)
      details.push(`value=${quoted(entry.value, 100)}`);
    for (const state of ['enabled', 'focused', 'selected', 'expanded'])
      if (entry[state] !== null) details.push(`${state}=${entry[state]}`);
    if (entry.actions === null) details.push('actions=unknown');
    else if (entry.actions.length)
      details.push(
        `actions=${entry.actions
          .slice(0, 4)
          .map((name) => short(name, 40))
          .join(',')}${entry.actions.length > 4 ? ',…' : ''}`
      );
    if (entry.settableAttributeNames?.length)
      details.push(
        `settable=${entry.settableAttributeNames
          .slice(0, 3)
          .map((name) => short(name, 40))
          .join(',')}${entry.settableAttributeNames.length > 3 ? ',…' : ''}`
      );
    if (entry.bounds) {
      const { x, y, width, height } = entry.bounds;
      details.push(`bounds=${numeric(x)},${numeric(y)} ${numeric(width)}×${numeric(height)}`);
    }
    if (entry.redacted) details.push(`redacted=${entry.redacted}`);
    if (entry.contentOmitted) details.push(`omitted=${entry.contentOmitted}`);
    if (!entry.matched) details.push('context');
    const prefix = `${'  '.repeat(Math.min(entry.depth, 8))}[${entry.index}${entry.parent === null ? '' : ` parent=${entry.parent}`}]`;
    lines.push(
      `${prefix} ${short(entry.role, 128) || 'role unknown'}${label}${details.length ? ` · ${details.join(' · ')}` : ''}`
    );
    if (entry.classes.length || entry.url) {
      const metadata = [
        entry.classes.length
          ? `classes=${entry.classes
              .slice(0, 2)
              .map((name) => short(name, 70))
              .join(' ')}${entry.classes.length > 2 ? ' …' : ''}`
          : '',
        entry.url ? `url=${quoted(entry.url, 140)}` : '',
      ].filter(Boolean);
      lines.push(`${'  '.repeat(Math.min(entry.depth, 8) + 1)}${metadata.join(' · ')}`);
    }
    shortened ||=
      [
        [entry.label, 120],
        [entry.id, 100],
        [entry.value, 100],
        [entry.url, 140],
        ...entry.classes.map((value) => [value, 70]),
        ...(entry.actions ?? []).map((value) => [value, 40]),
        ...(entry.settableAttributeNames ?? []).map((value) => [value, 40]),
      ].some(([value, limit]) => Array.from(plain(value)).length > limit) ||
      entry.classes.length > 2 ||
      (entry.actions?.length ?? 0) > 4 ||
      (entry.settableAttributeNames?.length ?? 0) > 3;
  }
  if (!ui.nodes.length)
    lines.push('No matching node and its complete ancestor chain fit this capture.');
  if (shortened)
    lines.push('Text abbreviates metadata; --format=json retains every returned field.');
  lines.push(
    'Refine with inspect --ui --filter=TEXT --limit=N --depth=N; use --format=json for capability details.'
  );
  return lines.join('\n');
}

export function formatUIOutput(compact, format = 'text', receipt = undefined) {
  if (format === 'full-json') {
    if (receipt === undefined) throw new Error('Full JSON receipt is unavailable');
    return JSON.stringify(receipt, null, 2);
  }
  requireUI(compact?.mode === 'ui' && compact.operation === 'inspect', 'UI output unavailable');
  if (format === 'json') return JSON.stringify(compact, null, 2);
  if (format === 'text') return renderUI(compact);
  throw new Error(`Unknown output format ${JSON.stringify(format)}`);
}

export function formatUIObservation(observation) {
  const ui = observation.ui;
  const roles = [
    'AXDialog',
    'AXSheet',
    'AXMenu',
    'AXComboBox',
    'AXTextField',
    'AXCheckBox',
    'AXRadioButton',
    'AXList',
    'AXButton',
    'AXPopUpButton',
    'AXMenuItem',
  ];
  const priority = (entry) => (entry.focused === true ? -1 : roles.indexOf(entry.role));
  const useful = ui.nodes
    .filter(
      (entry) =>
        entry.matched &&
        entry.redacted === null &&
        roles.includes(entry.role) &&
        (entry.label || entry.id)
    )
    .sort((left, right) => priority(left) - priority(right) || left.index - right.index);
  const controls = useful
    .slice(0, 6)
    .map((entry) => `${short(entry.role, 40)} ${quoted(entry.label || entry.id, 90)}`);
  return [
    'After-error observation; this does not establish the cause of the failure.',
    identityLine(ui),
    controls.length
      ? `Observed controls: ${controls.join('; ')}${useful.length > 6 ? '; …' : ''}.`
      : 'No named controls were retained within the diagnostic limits.',
    `Captured ${ui.captureStartedAt} to ${ui.observedAt}; coverage remains partial${ui.coverage.reasons.length ? ` (${ui.coverage.reasons.join(', ')})` : ''}${ui.root.viewIdentityMatched === false ? '; view identity changed' : ui.root.viewIdentityMatched === null ? '; view identity comparison unavailable' : ''}.`,
    'Inspect: inspect --ui; add --filter=TEXT or --format=json for detail.',
  ].join('\n');
}
