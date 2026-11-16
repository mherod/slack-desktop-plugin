// Bind an opt-in workspace transition to exposed read/save sources. No UI/input.
import { isDeepStrictEqual } from 'node:util';
import { compactWorkspaces } from './slack-workspaces.mjs';

const commands = new Set([
  'channels',
  'dms',
  'search',
  'channel',
  'read-channel',
  'read-dm',
  'read-thread',
  'read-media',
  'read-transcript',
  'save-media',
  'members',
  'browse-channels',
  'browse-people',
  'send',
  'edit',
  'delete',
]);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireState = (condition, message) => {
  if (!condition) throw new Error(message);
};
const failed = (receipt, code) =>
  code !== 0 ||
  ['stopped', 'ambiguous', 'not-found', 'permission-required', 'unavailable'].includes(
    receipt.status
  );

// The transcript runner may retain a native preflight/result inside a synthetic
// failure. Never search arbitrary UI data for evidence or execution metadata.
function envelopes(receipt, operation) {
  const result = [receipt];
  const rejected = [];
  const keys = ['preflight', 'nativeResult'];
  if (operation === 'save-media')
    keys.push('sourcePreflight', 'viewerPreflight', 'started', 'publicationPreflight');
  for (const key of keys) {
    if (receipt[key] !== undefined) {
      requireState(object(receipt[key]), 'Workspace protocol envelope is invalid');
      result.push(receipt[key]);
    }
  }
  if (operation === 'save-media')
    for (const key of [
      'rejectedSourcePreflight',
      'rejectedViewerPreflight',
      'rejectedPublicationPreflight',
    ]) {
      if (receipt[key] !== undefined) {
        requireState(object(receipt[key]), 'Rejected workspace protocol envelope is invalid');
        rejected.push(receipt[key]);
      }
    }
  return { values: result, rejected };
}

function switchUncertainty(values) {
  const states = values.map((value) => {
    const state = value.workspaceSwitchMayHaveBeenRequested;
    requireState(
      state === undefined || state === null || typeof state === 'boolean',
      'Workspace switch uncertainty is invalid'
    );
    return value.switchAttempted === true ? true : state;
  });
  if (states.includes(true)) return true;
  if (states.some((state) => state === null)) return null;
  return states.includes(false) ? false : null;
}

function contextFromURL(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    /* Validate below. */
  }
  const context = url?.pathname.match(/^\/client\/([TE][A-Z0-9]{1,63})(?:\/|$)/)?.[1];
  requireState(
    typeof raw === 'string' &&
      url?.href === raw &&
      url.origin === 'https://app.slack.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !raw.includes('#') &&
      !url.pathname.includes('%') &&
      context,
    'Workspace source URL is not a canonical Slack client context'
  );
  return context;
}

function verifySources(receipt, expected, operation) {
  let count = 0;
  const save = operation === 'save-media';
  const viewer = save && receipt.phase === 'viewer-select';
  const identity = (value) => {
    requireState(object(value), 'Workspace source identity is invalid');
    if (Object.hasOwn(value, 'url'))
      requireState(
        contextFromURL(value.url) === expected.contextId,
        'Workspace source context differs from the selected workspace'
      );
    if (Object.hasOwn(value, 'contextId'))
      requireState(
        value.contextId === expected.contextId,
        'Workspace source context differs from the selected workspace'
      );
    if (Object.hasOwn(value, 'windowId'))
      requireState(
        value.windowId === expected.windowId,
        'Workspace source window differs from the selected window'
      );
  };
  const snapshot = (value, content = false) => {
    requireState(object(value) || Array.isArray(value), 'Workspace snapshot is invalid');
    if (object(value)) identity(value);
    const nodes = Array.isArray(value) ? value : value.nodes;
    if (nodes === undefined) return;
    requireState(
      Array.isArray(nodes) && nodes.length <= 20000,
      'Workspace snapshot nodes are invalid or exceed the bound'
    );
    if (content) {
      const roots = nodes.filter((node) => object(node) && node.parent === null);
      requireState(
        roots.length === 1 &&
          (content === 'subtree'
            ? roots[0].role === 'AXGroup'
            : roots[0].role === 'AXWebArea' && typeof roots[0].url === 'string'),
        content === 'subtree'
          ? 'Workspace viewer capture has no unique panel root'
          : 'Workspace source capture has no unique client root'
      );
      identity(roots[0]);
    }
    for (const node of nodes) {
      if (
        node?.role === 'AXWebArea' &&
        (content ||
          (typeof node.url === 'string' && node.url.startsWith('https://app.slack.com/client/')))
      )
        identity(node);
    }
  };
  const visit = (frame, depth = 0, subtree = false, viewerObservation = false) => {
    requireState(
      object(frame) && depth <= 3 && ++count <= 64,
      'Workspace source frames are invalid or exceed the bound'
    );
    identity(frame);
    if (viewerObservation) {
      for (const key of ['before', 'after'])
        requireState(
          object(frame[key]) && contextFromURL(frame[key].url) === expected.contextId,
          'Workspace viewer capture has no selected client identity'
        );
      requireState(
        object(frame.source) && frame.source.content !== undefined,
        'Workspace viewer capture has no source subtree'
      );
    }
    if (frame.workspaceScope !== undefined) identity(frame.workspaceScope);
    for (const key of ['before', 'after', 'current', 'view'])
      if (frame[key] !== undefined) snapshot(frame[key]);
    for (const key of ['source', 'scope', 'target', 'threadTarget'])
      if (object(frame[key])) identity(frame[key]);
    if (save && frame.sourceRequest !== undefined)
      requireState(
        object(frame.sourceRequest) && frame.sourceRequest.workspace === expected.contextId,
        'Workspace source reopening differs from the selected workspace'
      );
    if (save && object(frame.source) && Object.hasOwn(frame.source, 'context'))
      requireState(
        frame.source.context === expected.contextId,
        'Workspace save source context differs from the selected workspace'
      );
    if (frame.content !== undefined) snapshot(frame.content, subtree ? 'subtree' : true);
    if (subtree && object(frame.source) && frame.source.content !== undefined)
      snapshot(frame.source.content, 'subtree');
    for (const key of ['pages', 'observations', 'searchPages', 'transcriptPages']) {
      if (frame[key] === undefined) continue;
      requireState(
        Array.isArray(frame[key]) && frame[key].length > 0 && frame[key].length <= 10,
        'Workspace source page collection is invalid'
      );
      for (const child of frame[key]) {
        const primaryViewer = viewer && depth === 0 && key === 'observations';
        visit(child, depth + 1, subtree || primaryViewer, primaryViewer);
      }
    }
    if (viewer && depth === 0 && frame.detailsMenu !== undefined)
      visit(frame.detailsMenu, depth + 1, true);
  };
  visit(receipt);
}

export function validateWorkspaceScope(receipt, operation, target, { code = 0 } = {}) {
  if (target === undefined) return null;
  requireState(commands.has(operation) && object(receipt), 'Unsupported scoped workspace receipt');
  requireState(
    typeof target === 'string' &&
      target.length > 0 &&
      [...target].length <= 200 &&
      target.trim() === target &&
      !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(target),
    'Requested workspace target is invalid'
  );
  const { values, rejected } = envelopes(receipt, operation);
  const allValues = [...values, ...rejected];
  for (const value of allValues)
    if (value.requestedWorkspace !== undefined)
      requireState(
        value.requestedWorkspace === target,
        'Workspace request changed during execution'
      );
  const selected = values.filter((value) => value.workspaceSelection !== undefined);
  if (!selected.length) {
    requireState(failed(receipt, code), 'Successful scoped command has no workspace selection');
    return {
      schemaVersion: 1,
      operation: 'switch-workspace',
      status: 'stopped',
      requested: target,
      error:
        typeof receipt.error === 'string' ? receipt.error : 'Workspace selection did not complete',
      next: 'Inspect the current workspace before retrying; no scoped read was verified.',
      workspaceSwitchMayHaveBeenRequested: switchUncertainty([
        ...allValues,
        ...rejected
          .filter((value) => object(value.workspaceSelection))
          .map((value) => value.workspaceSelection),
      ]),
    };
  }
  const selections = selected.map((value) =>
    compactWorkspaces(value.workspaceSelection, 'switch-workspace', target)
  );
  const selection = selections[0];
  requireState(
    selections.every((item) => isDeepStrictEqual(item, selection)),
    'Workspace selection changed between protocol phases'
  );
  const mayHaveBeenRequested = switchUncertainty([
    ...allValues,
    ...selected.map((value) => value.workspaceSelection),
    ...rejected
      .filter((value) => object(value.workspaceSelection))
      .map((value) => value.workspaceSelection),
  ]);
  for (const value of selected) {
    const actual = value.workspaceSelection.workspaceSwitchMayHaveBeenRequested ?? null;
    requireState(
      value.workspaceSwitchMayHaveBeenRequested === actual,
      'Workspace action uncertainty differs from its selection receipt'
    );
  }
  if (selection.status !== 'ok')
    return { ...selection, workspaceSwitchMayHaveBeenRequested: mayHaveBeenRequested };
  const expected = {
    contextId: selection.workspace.contextId,
    windowId: selected[0].workspaceSelection.after.windowId,
  };
  requireState(
    selected.every((value) => value.workspaceSelection.after.windowId === expected.windowId),
    'Workspace selection window changed between protocol phases'
  );
  // Rejected protocol phases are evidence only. They may increase uncertainty
  // or reveal drift, but cannot supply the selection that authorizes a save.
  for (const value of rejected) {
    if (value.workspaceSelection !== undefined)
      requireState(
        isDeepStrictEqual(
          compactWorkspaces(value.workspaceSelection, 'switch-workspace', target),
          selection
        ) && value.workspaceSelection.after?.windowId === expected.windowId,
        'Workspace selection changed in a rejected protocol phase'
      );
    verifySources(value, expected, operation);
  }
  for (const value of values) {
    if (value.operation !== undefined)
      requireState(value.operation === operation, 'Scoped receipt operation changed');
    // Error envelopes may have no current pin after a user/layout change. They
    // retain the completed selection, but cannot claim successful read content.
    const requiresScope =
      value.phase === 'select' ||
      (operation === 'save-media' &&
        ['source-select', 'viewer-select', 'started', 'publish'].includes(value.phase)) ||
      !failed(value, 0);
    if (requiresScope) {
      requireState(
        value.requestedWorkspace === target &&
          object(value.workspaceScope) &&
          value.workspaceScope.contextId === expected.contextId &&
          value.workspaceScope.windowId === expected.windowId,
        'Scoped read has no fresh selected workspace/window verification'
      );
    }
    verifySources(value, expected, operation);
  }
  return { ...selection, workspaceSwitchMayHaveBeenRequested: mayHaveBeenRequested };
}

// Only semantic containers may hold navigation hints. Raw AX nodes, arbitrary
// message body objects, quoted commands and switch-workspace actions stay intact.
const hintContainers = new Set([
  'channels',
  'dms',
  'messages',
  'candidates',
  'thread',
  'root',
  'replies',
  'attachments',
  'media',
  'transcript',
  'sources',
  'search',
  'pagination',
  'older',
  'newer',
  'next',
]);

export function applyWorkspaceScope(compact, selection) {
  if (!selection) return compact;
  requireState(
    object(compact) &&
      selection.status === 'ok' &&
      selection.operation === 'switch-workspace' &&
      object(selection.workspace) &&
      // A rail selection has no domain or reference; a selector one has both.
      ((selection.workspace.domain === null && selection.workspace.ref === null) ||
        (typeof selection.workspace.domain === 'string' &&
          selection.workspace.domain.match(
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.enterprise)?\.slack\.com$/
          )?.[0] === selection.workspace.domain &&
          selection.workspace.ref === `workspace:${selection.workspace.domain}`)) &&
      typeof selection.workspace.contextId === 'string' &&
      selection.workspace.contextId.match(/^[TE][A-Z0-9]{1,63}$/)?.[0] ===
        selection.workspace.contextId &&
      isDeepStrictEqual(selection.workspace, selection.switch?.to),
    'Navigation scope requires a verified workspace selection'
  );
  const context = selection.workspace.contextId;
  // Without a domain reference no scoped follow-up flag can be offered.
  if (selection.workspace.ref === null) {
    if (compact.workspace !== undefined)
      requireState(
        object(compact.workspace) &&
          (compact.workspace.contextId ?? compact.workspace.id) === context &&
          (compact.workspace.id == null || compact.workspace.id === context),
        'Compact output differs from the selected workspace'
      );
    return {
      ...compact,
      requestedWorkspace: selection.requested,
      workspaceSelection: selection,
      workspaceSwitchMayHaveBeenRequested: selection.workspaceSwitchMayHaveBeenRequested,
    };
  }
  if (compact.workspace !== undefined)
    requireState(
      object(compact.workspace) &&
        (compact.workspace.contextId ?? compact.workspace.id) === context &&
        (compact.workspace.id == null || compact.workspace.id === context),
      'Compact output differs from the selected workspace'
    );
  const flag = `--workspace=${selection.workspace.ref}`;
  const hint = (value) => {
    if (Array.isArray(value)) return value.map(hint);
    if (!object(value) || !commands.has(value.command)) return value;
    requireState(
      Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string'),
      'Workspace navigation arguments are invalid'
    );
    const existing = value.args.filter((arg) => arg.startsWith('--workspace='));
    requireState(
      existing.length === 0 || (existing.length === 1 && existing[0] === flag),
      'Navigation hint has a conflicting workspace'
    );
    return { ...value, args: existing.length ? [...value.args] : [...value.args, flag] };
  };
  const decorate = (value) => {
    if (Array.isArray(value)) return value.map(decorate);
    if (!object(value)) return value;
    const result = { ...value };
    for (const [key, child] of Object.entries(value)) {
      if (key === 'navigation' || key === 'saveNavigation') result[key] = hint(child);
      else if (hintContainers.has(key)) result[key] = decorate(child);
    }
    return result;
  };
  return {
    ...decorate(compact),
    requestedWorkspace: selection.requested,
    workspaceSelection: selection,
    workspaceSwitchMayHaveBeenRequested: selection.workspaceSwitchMayHaveBeenRequested,
  };
}
