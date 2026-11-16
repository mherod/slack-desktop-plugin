// Pure validation of bounded native workspace observations. No UI or persistence.
import { isDeepStrictEqual } from 'node:util';

const operations = new Set(['workspaces', 'current-workspace', 'switch-workspace']);
const domainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.enterprise)?\.slack\.com$/;
const contextPattern = /^[TE][A-Z0-9]{1,63}$/;
const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeName = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  [...value].length <= 200 &&
  value.trim() === value &&
  !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
const ref = (domain) => `workspace:${domain}`;
const coverage = { scope: 'exposed-workspace-switcher', complete: false };

function observation(raw, entriesRequired) {
  requireState(object(raw), 'Workspace observation is unavailable');
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    /* The exact observation is checked below. */
  }
  const contextId = url?.pathname.match(/^\/client\/([TE][A-Z0-9]{1,63})(?:\/|$)/)?.[1];
  requireState(
    typeof raw.url === 'string' &&
      url?.href === raw.url &&
      url.origin === 'https://app.slack.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      !raw.url.includes('#') &&
      !url.pathname.includes('%') &&
      contextId &&
      safeName(raw.name) &&
      Number.isSafeInteger(raw.windowId) &&
      raw.windowId > 0,
    'Workspace URL, name or window identity is invalid'
  );
  let entries;
  if (entriesRequired || raw.entries !== undefined) {
    requireState(
      Array.isArray(raw.entries) && raw.entries.length > 0 && raw.entries.length <= 64,
      'Workspace selector entries are missing or exceed the bound'
    );
    entries = raw.entries.map((entry) => {
      requireState(
        object(entry) &&
          safeName(entry.name) &&
          // The pop-up selector exposes domains; the workspace rail exposes none.
          (entry.domain === null ||
            (typeof entry.domain === 'string' &&
              domainPattern.exec(entry.domain)?.[0] === entry.domain)) &&
          typeof entry.current === 'boolean',
        'Workspace selector identity or current marker is invalid'
      );
      return { name: entry.name, domain: entry.domain, current: entry.current };
    });
    const domains = entries.flatMap((entry) => (entry.domain === null ? [] : [entry.domain]));
    requireState(
      domains.length === 0 || domains.length === entries.length,
      'Workspace selector mixes entries with and without domains'
    );
    requireState(
      new Set(domains).size === domains.length,
      'Workspace selector domains are duplicated'
    );
    const current = entries.filter((entry) => entry.current);
    requireState(
      current.length === 1 && current[0].name === raw.name,
      'Workspace selector current identity disagrees with the loaded workspace'
    );
  }
  return { url: raw.url, name: raw.name, windowId: raw.windowId, contextId, entries };
}

function identity(observed) {
  const domain = observed.entries?.find((entry) => entry.current)?.domain ?? null;
  return {
    name: observed.name,
    contextId: observed.contextId,
    id: observed.contextId.startsWith('T') ? observed.contextId : null,
    domain,
    ref: domain ? ref(domain) : null,
  };
}

function listed(observed, entries = observed.entries) {
  // Without a domain, only a name that is unique in the observed inventory and
  // cannot be mistaken for a reference or context ID is offered as a target.
  const target = (entry) => {
    if (entry.domain !== null) return ref(entry.domain);
    const unique = observed.entries.filter((other) => other.name === entry.name).length === 1;
    return unique && !entry.name.startsWith('workspace:') && !contextPattern.test(entry.name)
      ? entry.name
      : null;
  };
  return entries.map((entry) => ({
    ...entry,
    ref: entry.domain === null ? null : ref(entry.domain),
    contextId: entry.current ? observed.contextId : null,
    id: entry.current && observed.contextId.startsWith('T') ? observed.contextId : null,
    ...(target(entry) === null
      ? {}
      : { navigation: { command: 'switch-workspace', args: [target(entry)] } }),
  }));
}

function sameRoot(before, after) {
  requireState(
    before.url === after.url && before.name === after.name && before.windowId === after.windowId,
    'Workspace or window changed during observation'
  );
}

function sameInventory(before, after, includeCurrent) {
  const rows = (observed) =>
    observed.entries.map(({ name, domain, current }) =>
      includeCurrent ? { name, domain, current } : { name, domain }
    );
  requireState(
    isDeepStrictEqual(rows(before), rows(after)),
    'Workspace selector inventory changed during the command'
  );
}

function selectorState(receipt) {
  const selector = receipt.selector;
  requireState(
    object(selector) &&
      ['opened', 'reused', 'verificationOpened', 'closed'].every(
        (key) => typeof selector[key] === 'boolean'
      ) &&
      !(selector.opened && selector.reused) &&
      (selector.layout === undefined || selector.layout === 'rail'),
    'Workspace selector action evidence is invalid'
  );
  // The persistent rail is observed in place: never opened, closed or reopened.
  if (selector.layout === 'rail')
    requireState(
      selector.reused && !selector.opened && !selector.closed && !selector.verificationOpened,
      'Workspace rail evidence claims selector input'
    );
  return selector;
}

function verifiedSelectorLifecycle(selector) {
  requireState(
    (selector.opened || selector.reused) &&
      (selector.closed || (selector.reused && !selector.opened && !selector.verificationOpened)),
    'Workspace selector was not verified or an owned selector remains open'
  );
}

function exactMatches(before, requested) {
  if (requested.startsWith('workspace:'))
    return before.entries.filter(
      (entry) => entry.domain !== null && ref(entry.domain) === requested
    );
  if (contextPattern.test(requested))
    return before.contextId === requested ? before.entries.filter((entry) => entry.current) : [];
  return before.entries.filter((entry) => entry.name === requested);
}

function uncertainty(receipt) {
  const value = receipt.workspaceSwitchMayHaveBeenRequested;
  requireState(
    value === undefined || value === null || typeof value === 'boolean',
    'Workspace switch uncertainty is invalid'
  );
  if (receipt.switchAttempted !== undefined)
    requireState(
      typeof receipt.switchAttempted === 'boolean',
      'Workspace switch attempt is invalid'
    );
  requireState(
    receipt.switchAttempted !== true || value === true,
    'Attempted workspace switch cannot lose its uncertainty'
  );
  return value ?? null;
}

export function compactWorkspaces(receipt, operation, requested) {
  requireState(operations.has(operation), 'Unsupported workspace operation');
  requireState(object(receipt), 'Workspace receipt is unavailable');
  requireState(
    ['ok', 'stopped', 'ambiguous', 'not-found'].includes(receipt.status),
    'Workspace receipt status is invalid'
  );
  requireState(
    receipt.operation === operation ||
      (receipt.status === 'stopped' && receipt.operation === undefined),
    'Workspace receipt operation differs from the requested command'
  );
  if (operation === 'switch-workspace') {
    requireState(safeName(requested), 'Workspace switch target is invalid');
    requireState(
      receipt.requested === requested ||
        (receipt.status === 'stopped' && receipt.requested === undefined),
      'Workspace switch target differs from the requested command'
    );
  } else {
    requireState(
      requested === undefined && receipt.requested === undefined,
      'Workspace inspection does not accept a target'
    );
  }
  const mayHaveBeenRequested = uncertainty(receipt);
  const base = {
    schemaVersion: 1,
    operation,
    status: receipt.status,
    ...(requested === undefined ? {} : { requested }),
    ...(receipt.observedAt ? { observedAt: receipt.observedAt } : {}),
    ...(receipt.interaction ? { interaction: receipt.interaction } : {}),
  };
  if (receipt.status === 'stopped') {
    return {
      ...base,
      error: typeof receipt.error === 'string' ? receipt.error : 'Workspace command stopped',
      next:
        typeof receipt.next === 'string'
          ? receipt.next
          : 'Inspect the current workspace before any retry; do not replay an uncertain switch.',
      workspaceSwitchMayHaveBeenRequested: mayHaveBeenRequested,
    };
  }
  const selector = selectorState(receipt);
  requireState(
    typeof receipt.switchAttempted === 'boolean' &&
      typeof receipt.workspaceSwitchMayHaveBeenRequested === 'boolean' &&
      receipt.switchAttempted === receipt.workspaceSwitchMayHaveBeenRequested,
    'Workspace switch action evidence is missing or inconsistent'
  );
  const before = observation(receipt.before, operation !== 'current-workspace');
  if (receipt.status !== 'ok') {
    verifiedSelectorLifecycle(selector);
    requireState(
      operation === 'switch-workspace' &&
        !receipt.switchAttempted &&
        !selector.verificationOpened &&
        receipt.selection === undefined,
      'Workspace choice refusal contains switch input'
    );
    const matches = exactMatches(before, requested);
    requireState(
      receipt.status === 'ambiguous' ? matches.length > 1 : matches.length === 0,
      'Workspace choice refusal disagrees with exact observed matches'
    );
    let workspace;
    if (receipt.after !== undefined) {
      const after = observation(receipt.after, true);
      sameRoot(before, after);
      sameInventory(before, after, true);
      workspace = identity(after);
    }
    const candidates = listed(before, matches.length ? matches : before.entries);
    return {
      ...base,
      ...(workspace ? { workspace } : {}),
      candidates: candidates.slice(0, 20),
      candidateCount: candidates.length,
      candidatesTruncated: candidates.length > 20,
      exactMatchCount: matches.length,
      coverage: { ...coverage },
      error:
        typeof receipt.error === 'string' ? receipt.error : 'Exact workspace target unavailable',
      next: 'Use an exact observed workspace reference; no workspace was selected.',
      workspaceSwitchMayHaveBeenRequested: false,
    };
  }
  const after = observation(receipt.after, operation !== 'current-workspace');
  if (operation === 'current-workspace') {
    requireState(
      !receipt.switchAttempted &&
        Object.values(selector).every((value) => value === false) &&
        receipt.selection === undefined &&
        before.entries === undefined &&
        after.entries === undefined,
      'Current workspace inspection contains selector or switching input'
    );
    sameRoot(before, after);
    return { ...base, workspace: identity(after) };
  }
  verifiedSelectorLifecycle(selector);
  if (operation === 'workspaces') {
    requireState(
      !receipt.switchAttempted && !selector.verificationOpened && receipt.selection === undefined,
      'Workspace listing contains switching input'
    );
    sameRoot(before, after);
    sameInventory(before, after, true);
    return {
      ...base,
      workspace: identity(after),
      workspaces: listed(after),
      coverage: { ...coverage },
    };
  }
  const matches = exactMatches(before, requested);
  requireState(matches.length === 1, 'Workspace target is missing or ambiguous');
  const selected = matches[0];
  requireState(
    object(receipt.selection) &&
      receipt.selection.name === selected.name &&
      receipt.selection.domain === selected.domain,
    'Workspace selection differs from the exact observed target'
  );
  sameInventory(before, after, false);
  const current = after.entries.find((entry) => entry.current);
  requireState(
    before.windowId === after.windowId &&
      current.name === selected.name &&
      current.domain === selected.domain,
    'Workspace destination or window does not match the selected target'
  );
  const changed = !selected.current;
  const rail = selector.layout === 'rail';
  requireState(
    receipt.switchAttempted === changed && selector.verificationOpened === (rail ? false : changed),
    'Workspace switch attempt does not match the observed transition'
  );
  if (changed) {
    requireState(
      before.contextId !== after.contextId && (rail || selector.closed),
      'Workspace switch did not establish a distinct verified destination'
    );
  } else sameRoot(before, after);
  return {
    ...base,
    workspace: identity(after),
    switch: {
      requested,
      attempted: receipt.switchAttempted,
      changed,
      from: identity(before),
      to: identity(after),
    },
  };
}
