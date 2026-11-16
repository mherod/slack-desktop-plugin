import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mediaObservationOutput } from './slack-output.mjs';
import { classifyMediaExposure, loadMediaReferences, resolveMedia } from './slack-read-media.mjs';
import {
  prepareDownloadState,
  waitForDownload,
  prepareViewerDownloadState,
  waitForViewerDownload,
} from './slack-download-store.mjs';
import {
  verifySavePhase,
  savedMediaOutput,
  saveMediaSelectionOutput,
} from './slack-save-media.mjs';
import { runSaveMedia } from './slack-save-protocol.mjs';
import { selectSaveMediaAction, selectViewerDownloadCandidate } from './slack-save-viewer.mjs';
import { nativeInteractionArgs } from './slack-interaction.mjs';
import { validateWorkspaceScope } from './slack-workspace-scope.mjs';

// A completed workspace switch is historical evidence. Every action-bearing
// phase also needs its own fresh pin, with the same selection across the child.
export function createSaveWorkspaceVerifier(target) {
  let selected, nativeSelection, pid;
  return (receipt) => {
    if (target === undefined) return;
    const current = validateWorkspaceScope(receipt, 'save-media', target);
    if (
      current.status !== 'ok' ||
      receipt.workspaceScopeError !== undefined ||
      !Number.isInteger(receipt.pid) ||
      receipt.pid <= 0 ||
      receipt.workspaceSelection?.pid !== receipt.pid ||
      receipt.workspaceScope?.contextId !== current.workspace.contextId ||
      receipt.workspaceScope?.windowId !== receipt.workspaceSelection?.after?.windowId
    )
      throw new Error(
        receipt.workspaceScopeError ??
          current.error ??
          'Save phase has no fresh selected workspace/window verification'
      );
    if (
      selected &&
      (!isDeepStrictEqual(current, selected) ||
        !isDeepStrictEqual(receipt.workspaceSelection, nativeSelection) ||
        receipt.pid !== pid)
    )
      throw new Error('Workspace selection changed across save phases');
    selected = structuredClone(current);
    nativeSelection = structuredClone(receipt.workspaceSelection);
    pid = receipt.pid;
  };
}

// Pin the canonical parent before sending any Download token. The native
// publisher independently pins it with a directory fd and publishes exclusively.
export async function prepareDestination(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.endsWith('/') ||
    /[\x00-\x1f\x7f-\x9f]/.test(value)
  )
    throw new Error('Output must name a file, without control characters');
  const absolute = path.resolve(value);
  const parent = await realpath(path.dirname(absolute));
  const info = await stat(parent, { bigint: true });
  if (!info.isDirectory()) throw new Error('Output parent must be an existing directory');
  const destination = path.join(parent, path.basename(absolute));
  await requireAbsent(destination);
  return { path: destination, parent, device: String(info.dev), inode: String(info.ino) };
}

async function requireAbsent(destination) {
  try {
    await lstat(destination);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Output already exists; choose another file path (overwriting is not supported)');
}

async function recheckDestination(destination) {
  const info = await lstat(destination.parent, { bigint: true });
  if (
    !info.isDirectory() ||
    String(info.dev) !== destination.device ||
    String(info.ino) !== destination.inode ||
    (await realpath(destination.parent)) !== destination.parent
  )
    throw new Error('Output parent changed before download');
  await requireAbsent(destination.path);
}

export async function publishDownload(binary, request, { signal, timeoutMs = 65000 } = {}) {
  if (signal?.aborted) throw new Error('Publication cancelled before starting');
  const child = Bun.spawn([binary], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  let killTimer,
    stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1200);
  };
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    child.stdin.write(JSON.stringify(request));
    await child.stdin.flush();
    child.stdin.end();
    let text = '',
      bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const chunk of child.stdout) {
      bytes += chunk.byteLength;
      if (bytes > 65536) throw new Error('File publication receipt exceeded bounds');
      text += decoder.decode(chunk, { stream: true });
    }
    const code = await child.exited;
    text += decoder.decode();
    const receipt = JSON.parse(text);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
      throw new Error('File publication receipt is invalid');
    return { code, receipt, interrupted: stopped || signal?.aborted === true };
  } catch (error) {
    stop();
    await child.exited;
    return {
      code: 1,
      receipt: {
        operation: 'save-media-publish',
        status: 'stopped',
        error: error.message,
        artifact: { path: request.destination, published: null, verified: false },
      },
      interrupted: stopped,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', stop);
  }
}

// The cache authorizes navigation only. The reopened source must independently
// resolve from fresh captures before the ordinary Download selector can run.
export function verifySourceReopening(preflight, initial, plan, resolved) {
  const navigation = preflight?.sourceNavigation;
  const contextId = resolved?.workspace?.contextId ?? resolved?.workspace?.id;
  const samePlan =
    plan &&
    Object.keys(plan).length === 2 &&
    /^[TE][A-Z0-9]{1,63}$/.test(plan.workspace ?? '') &&
    /^[CDG][A-Z0-9]{1,63}:\d{10}\.\d{6}$/.test(plan.messageRef ?? '') &&
    preflight?.sourceRequest &&
    Object.keys(preflight.sourceRequest).length === 2 &&
    preflight.sourceRequest.workspace === plan?.workspace &&
    preflight.sourceRequest.messageRef === plan?.messageRef;
  const conversationId = plan?.messageRef?.split(':')[0];
  const direct =
    navigation?.route === 'conversation' && navigation.pages === 0 && navigation.query === null;
  const searched =
    navigation?.route === 'conversation-search' &&
    Number.isInteger(navigation.pages) &&
    navigation.pages >= 1 &&
    navigation.pages <= 5 &&
    typeof navigation.query === 'string' &&
    navigation.query.length > 0 &&
    navigation.query.length <= 500 &&
    !/[\x00-\x1f\x7f-\x9f]/.test(navigation.query);
  if (
    initial?.operation !== 'save-media' ||
    initial.phase !== 'select' ||
    preflight?.operation !== 'save-media' ||
    preflight.phase !== 'source-select' ||
    preflight.pid !== initial?.pid ||
    !Number.isInteger(preflight.pid) ||
    preflight.pid <= 0 ||
    preflight.requested !== initial?.requested ||
    resolved?.requested !== initial?.requested ||
    resolved?.status !== 'ok' ||
    !samePlan ||
    contextId !== plan.workspace ||
    preflight.sourceAction?.attempted !== true ||
    preflight.sourceAction.accepted !== true ||
    preflight.sourceAction.opened !== true ||
    navigation?.complete !== true ||
    navigation.conversationId !== conversationId ||
    navigation.matchedMessageRef !== plan.messageRef ||
    !(direct || searched) ||
    preflight.action?.attempted === true ||
    preflight.viewerAction?.attempted === true
  )
    throw new Error('Reopened source does not match its verified request and navigation');
  const sources = Array.isArray(resolved.sources)
    ? resolved.sources.filter((source) => source.messageRef === plan.messageRef)
    : [];
  if (!sources?.length)
    throw new Error('The exact remembered attachment source is not exposed after navigation');
  return { ...resolved, sources, coverage: { ...resolved.coverage, sourceCount: sources.length } };
}

export async function saveMedia({
  binary,
  publisher,
  requested,
  output,
  originalRequired = false,
  interaction = 'background',
  workspaceTarget,
  mediaCache,
  statePath,
  signal,
}) {
  const destination = await prepareDestination(output);
  const bindings = await loadMediaReferences(mediaCache);
  const verifyWorkspace = createSaveWorkspaceVerifier(workspaceTarget);
  const observation = (preflight) => {
    if (
      preflight.operation !== 'save-media' ||
      preflight.requested !== requested ||
      !Array.isArray(preflight.observations) ||
      preflight.observations.length !== 2
    )
      throw new Error('Download preflight does not match the requested reference');
    return {
      ...preflight,
      operation: 'read-media',
      observations: preflight.observations.map(mediaObservationOutput),
    };
  };
  const selectDownload = async (preflight, resolved, workSignal, context = {}) => {
    const selected = selectSaveMediaAction(preflight, resolved, { originalRequired });
    const contextId = resolved.workspace?.contextId ?? resolved.workspace?.id;
    if (!contextId) throw new Error('Verified workspace context is missing');
    Object.assign(context, { preflight, resolved, destination });
    if (selected.action === 'open-viewer') {
      await recheckDestination(destination);
      if (workSignal.aborted) throw new Error('Viewer selection cancelled');
      Object.assign(context, { opener: selected });
      return { openViewer: selected.token, context };
    }
    const setup = await prepareDownloadState(statePath, { url: selected.url, contextId });
    await recheckDestination(destination);
    if (workSignal.aborted) throw new Error('Download selection cancelled');
    Object.assign(context, { selected, setup });
    return { token: selected.token, context };
  };
  const command = [binary, ...nativeInteractionArgs(['save-media', requested], interaction)];
  if (workspaceTarget !== undefined)
    command.splice(interaction === 'foreground' ? 2 : 1, 0, `--workspace=${workspaceTarget}`);
  const captured = await runSaveMedia(command, {
    signal,
    timeoutMs: workspaceTarget === undefined ? 170000 : 185000,
    select: async (preflight, workSignal) => {
      verifyWorkspace(preflight);
      const exposure = classifyMediaExposure(observation(preflight), requested, bindings);
      if (exposure.status === 'absent') {
        await recheckDestination(destination);
        if (workSignal.aborted) throw new Error('Source reopening cancelled');
        return {
          reopenSource: exposure.source,
          context: {
            initialPreflight: preflight,
            sourcePlan: exposure.source,
            bindings,
            destination,
          },
        };
      }
      return selectDownload(preflight, exposure.resolved, workSignal);
    },
    selectSource: async (preflight, context, workSignal) => {
      verifyWorkspace(preflight);
      const resolved = resolveMedia(observation(preflight), requested, context.bindings);
      const bound = verifySourceReopening(
        preflight,
        context.initialPreflight,
        context.sourcePlan,
        resolved
      );
      return selectDownload(preflight, bound, workSignal, context);
    },
    selectViewer: async (viewerPreflight, context, workSignal) => {
      verifyWorkspace(viewerPreflight);
      const selected = selectViewerDownloadCandidate(
        viewerPreflight,
        context.preflight,
        context.resolved,
        context.opener,
        { originalRequired }
      );
      const contextId = context.resolved.workspace?.contextId ?? context.resolved.workspace?.id;
      const setup =
        selected.scope === 'file-details'
          ? await prepareDownloadState(statePath, { url: selected.url, contextId })
          : await prepareViewerDownloadState(statePath, {
              sourceURL: selected.sourceURL,
              contextId,
            });
      await recheckDestination(destination);
      if (workSignal.aborted) throw new Error('Viewer Download selection cancelled');
      Object.assign(context, { viewerPreflight, selected, setup });
      return { token: selected.token, context };
    },
    complete: async (started, context, workSignal, publicationCheckpoint) => {
      verifyWorkspace(started);
      verifySavePhase(started, context.preflight, context.selected, 'started');
      context.started = started;
      const wait = context.selected.scope === 'viewer' ? waitForViewerDownload : waitForDownload;
      context.download = await wait(statePath, {
        ...context.setup,
        startedAt: started.action.startedAt,
        signal: workSignal,
      });
      await recheckDestination(destination);
      if (workspaceTarget !== undefined) {
        const checkpoint = await publicationCheckpoint();
        verifyWorkspace(checkpoint);
        verifySavePhase(checkpoint, context.preflight, context.selected, 'publish');
        if (checkpoint.action.startedAt !== started.action.startedAt)
          throw new Error('Download timing changed before publication');
      }
      if (workSignal.aborted) throw new Error('Publication cancelled before starting');
      // Keep this before spawning: loss of the child receipt cannot prove that
      // no output was published. Never retry or remove a possibly saved artifact.
      context.publication = {
        operation: 'save-media-publish',
        status: 'stopped',
        artifact: { path: destination.path, published: null, verified: false },
      };
      const result = await publishDownload(
        publisher,
        {
          sourcePath: context.download.sourcePath,
          destination: destination.path,
          expectedSource: context.download.expectedSource,
          expectedParent: { device: destination.device, inode: destination.inode },
        },
        { signal: workSignal }
      );
      context.publication = result.receipt;
      if (result.code !== 0 || result.interrupted || result.receipt.status !== 'ok')
        throw new Error(
          result.receipt.error ?? 'File publication stopped; inspect the reported destination'
        );
      context.compact = savedMediaOutput(
        context.resolved,
        context.publication,
        context.download,
        destination.path,
        context.selected
      );
      return { download: context.download, publication: context.publication };
    },
  });
  const { context } = captured;
  let compact;
  try {
    if (captured.code !== 0 || captured.receipt.status !== 'ok')
      throw new Error(
        captured.receipt.error ?? 'Native download did not finish with verified desktop state'
      );
    verifyWorkspace(captured.receipt);
    verifySavePhase(captured.receipt, context.preflight, context.selected, 'result');
    if (captured.receipt.action.startedAt !== context.started.action.startedAt)
      throw new Error('Download receipt timing changed');
    compact = savedMediaOutput(
      context.resolved,
      context.publication,
      context.download,
      destination.path,
      context.selected
    );
    Object.assign(compact, sourceSaveState(captured.receipt), viewerSaveState(captured.receipt));
  } catch (error) {
    captured.code ||= 1;
    compact = failedSaveMediaOutput({ requested, error, receipt: captured.receipt, context });
  }
  return {
    code: captured.code,
    compact,
    receipt: {
      ...captured.receipt,
      ...(context?.download ? { download: context.download } : {}),
      ...(context?.publication ? { publication: context.publication } : {}),
      resolution: compact,
      status: compact.status,
    },
  };
}

// Retain established selection even when transfer stops before publication.
export function failedSaveMediaOutput({ requested, error, receipt, context }) {
  const viewerState = viewerSaveState(receipt);
  const sourceState = sourceSaveState(receipt);
  return {
    schemaVersion: 1,
    operation: 'save-media',
    status: 'stopped',
    requested,
    error: error instanceof Error ? error.message : String(error),
    ...(receipt.accessibilityProbe !== undefined
      ? { accessibilityProbe: receipt.accessibilityProbe }
      : {}),
    ...(receipt.accessStatus !== undefined ? { accessStatus: receipt.accessStatus } : {}),
    downloadMayHaveStarted: receipt.downloadMayHaveStarted === true,
    ...sourceState,
    ...viewerState,
    ...(context?.resolved
      ? { media: context.resolved.media, sources: context.resolved.sources }
      : {}),
    ...(context?.selected || context?.publication?.artifact
      ? {
          saved: {
            ...context?.publication?.artifact,
            ...(context?.selected ? saveMediaSelectionOutput(context.selected) : {}),
          },
        }
      : {}),
    next: receipt.downloadMayHaveStarted
      ? 'Inspect Slack Downloads and the reported destination before retrying; the native download may still complete. No automatic retry or overwrite was attempted.'
      : viewerState.viewerMayHaveOpened && viewerState.viewer?.closed !== true
        ? 'Inspect the file viewer before another request; no Download token was sent.'
        : sourceState.sourceMayHaveReopened
          ? 'Inspect the current Slack source before another request; no Download token was sent.'
          : receipt.accessibilityProbe && receipt.next
            ? receipt.next
            : 'Reread the source and check the output path; no Download token was sent.',
  };
}

export function sourceSaveState(receipt) {
  if (!receipt.sourceMayHaveReopened) return {};
  const action =
    receipt.sourceAction ??
    receipt.nativeResult?.sourceAction ??
    receipt.sourcePreflight?.sourceAction;
  const request = receipt.sourceRequest ?? receipt.nativeResult?.sourceRequest;
  return {
    sourceMayHaveReopened: true,
    source: { opened: action?.opened ?? null, messageRef: request?.messageRef ?? null },
  };
}

export function viewerSaveState(receipt) {
  if (!receipt.viewerMayHaveOpened) return {};
  const action =
    receipt.viewerAction ??
    receipt.nativeResult?.viewerAction ??
    receipt.viewerPreflight?.viewerAction;
  const failure = receipt.viewerFailure ?? receipt.nativeResult?.viewerFailure;
  const cleanup = receipt.viewerCleanup ?? receipt.nativeResult?.viewerCleanup;
  return {
    viewerMayHaveOpened: true,
    viewer: {
      opened: action?.opened ?? null,
      closed: action?.closed ?? null,
      ...Object.fromEntries(
        ['closeAttempted', 'closeError', 'sourceCheck']
          .filter((key) => action?.[key] !== undefined)
          .map((key) => [key, action[key]])
      ),
      ...(failure !== undefined ? { failure } : {}),
      ...(cleanup !== undefined ? { cleanup } : {}),
    },
  };
}
