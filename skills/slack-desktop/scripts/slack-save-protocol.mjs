// One native child retains the selected control and background guard while the
// wrapper waits for the download ledger and publishes the verified local file.
export async function runSaveMedia(
  command,
  {
    signal,
    select,
    selectSource,
    selectViewer,
    complete,
    timeoutMs = 120000,
    terminationGraceMs = 1000,
    spawn = Bun.spawn,
  }
) {
  if (signal?.aborted) throw new Error('Attachment saving cancelled before native work');
  const child = spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  const work = new AbortController();
  let timedOut = false,
    stopping = false,
    killTimer,
    preflight = null,
    sourcePreflight = null,
    rejectedSourcePreflight = null,
    sourceRequest = null,
    viewerPreflight = null,
    rejectedViewerPreflight = null,
    started = null,
    publicationPreflight = null,
    rejectedPublicationPreflight = null,
    publicationRequested = false,
    resolvePublicationCheckpoint = null,
    result = null,
    context = null;
  let taskError = null,
    sourceRequested = false,
    sourceMayHaveReopened = false,
    viewerRequested = false,
    downloadRequested = false,
    viewerMayHaveOpened = false,
    downloadMayHaveStarted = false,
    completionTask = null,
    completionFinished = false,
    transfer = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    work.abort();
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), terminationGraceMs);
  };
  const cancel = () => stop();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const exited = Promise.resolve(child.exited).then((code) => {
    if (!completionFinished) work.abort();
    return code;
  });
  const interruption = () =>
    new Promise((_, reject) => {
      if (work.signal.aborted) reject(new Error('Attachment saving interrupted'));
      else
        work.signal.addEventListener(
          'abort',
          () => reject(new Error('Attachment saving interrupted')),
          { once: true }
        );
    });
  async function write(value) {
    child.stdin.write(JSON.stringify(value) + '\n');
    await child.stdin.flush();
  }
  async function publicationCheckpoint() {
    if (!started || result || taskError || completionFinished || publicationRequested)
      throw new Error('Publication checkpoint is unavailable or was already requested');
    if (work.signal.aborted) throw new Error('Publication checkpoint interrupted');
    publicationRequested = true;
    const acknowledged = new Promise((resolve) => {
      resolvePublicationCheckpoint = resolve;
    });
    await write({ verifyWorkspace: true });
    return Promise.race([acknowledged, interruption()]);
  }
  function validSourcePlan(plan) {
    return (
      plan &&
      typeof plan === 'object' &&
      !Array.isArray(plan) &&
      Object.keys(plan).length === 2 &&
      Object.hasOwn(plan, 'workspace') &&
      Object.hasOwn(plan, 'messageRef') &&
      typeof plan.workspace === 'string' &&
      /^[TE][A-Z0-9]{1,63}$/.test(plan.workspace) &&
      !/[\r\n]/.test(plan.workspace) &&
      typeof plan.messageRef === 'string' &&
      /^[CDG][A-Z0-9]{1,63}:\d{10}\.\d{6}$/.test(plan.messageRef) &&
      !/[\r\n]/.test(plan.messageRef)
    );
  }
  function selectionAction(selection, { allowViewer, allowSource = false }) {
    const keys = selection && typeof selection === 'object' ? Object.keys(selection) : [];
    const actions = keys.filter((key) => ['token', 'openViewer', 'reopenSource'].includes(key));
    const action = actions[0];
    if (
      !selection ||
      Array.isArray(selection) ||
      keys.length !== 2 ||
      !keys.includes('context') ||
      actions.length !== 1 ||
      (action === 'openViewer' && !allowViewer) ||
      (action === 'reopenSource' && !allowSource) ||
      !selection.context ||
      typeof selection.context !== 'object' ||
      Array.isArray(selection.context) ||
      (action === 'reopenSource'
        ? !validSourcePlan(selection[action])
        : typeof selection[action] !== 'string' || !/^[A-Za-z0-9-]{1,200}$/.test(selection[action]))
    )
      throw new Error('Selection requires exactly one verified action and context');
    return action;
  }
  function recoveryHint() {
    if (downloadMayHaveStarted)
      return 'Inspect Slack and its download state before another command; do not replay an uncertain download.';
    if (viewerMayHaveOpened)
      return 'The file viewer may be open. Inspect Slack before another command; no Download token was sent and an uncertain viewer opening must not be replayed.';
    if (sourceMayHaveReopened)
      return 'Source navigation may have changed Slack. Inspect current state before another request; no Download token was sent and uncertain source navigation must not be replayed.';
    if (
      !preflight &&
      typeof result?.next === 'string' &&
      (result.status === 'permission-required' ||
        (result.accessibilityProbe &&
          ['permission-required', 'unavailable'].includes(result.accessStatus)))
    )
      return result.next;
    return 'Reread the source or correct the destination; no download token was sent.';
  }
  let completionDrained = false;
  async function drainCompletion() {
    if (!completionTask || completionDrained) return;
    completionDrained = true;
    // Production callbacks honor abort, including the publisher's kill grace.
    // A broken callback must still not hold the shared activity lease forever.
    let drainTimer;
    try {
      await Promise.race([
        completionTask,
        new Promise((resolve) => {
          drainTimer = setTimeout(resolve, terminationGraceMs + 1000);
        }),
      ]);
    } finally {
      clearTimeout(drainTimer);
    }
  }
  async function accept(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid save-media protocol receipt');
    // Even an out-of-order native receipt can report an action that may already
    // have happened. Its evidence cannot authorize the next protocol transition.
    if (value.sourceAction?.attempted === true) sourceMayHaveReopened = true;
    if (value.viewerAction?.attempted === true) viewerMayHaveOpened = true;
    if (value.action?.attempted === true) downloadMayHaveStarted = true;
    if (value.phase === 'select') {
      if (preflight || sourcePreflight || viewerPreflight || started || result)
        throw new Error('Repeated or out-of-order download preflight');
      preflight = value;
      let actionDeliveryAttempted = false;
      try {
        const selection = await Promise.race([
          Promise.resolve().then(() => select(value, work.signal)),
          interruption(),
        ]);
        if (work.signal.aborted) throw new Error('Download selection interrupted');
        const action = selectionAction(selection, { allowViewer: true, allowSource: true });
        context = selection.context;
        if (action === 'openViewer' && typeof selectViewer !== 'function')
          throw new Error('Viewer opening requires a verified viewer-selection callback');
        if (action === 'reopenSource' && typeof selectSource !== 'function')
          throw new Error('Source reopening requires a verified source-selection callback');
        if (
          action === 'reopenSource' &&
          (sourceMayHaveReopened || viewerMayHaveOpened || downloadMayHaveStarted)
        )
          throw new Error('Source reopening cannot follow an attempted or uncertain action');
        actionDeliveryAttempted = true;
        if (action === 'reopenSource') {
          sourceRequested = true;
          sourceMayHaveReopened = true;
          sourceRequest = Object.freeze({
            workspace: selection.reopenSource.workspace,
            messageRef: selection.reopenSource.messageRef,
          });
        } else if (action === 'openViewer') {
          viewerRequested = true;
          viewerMayHaveOpened = true;
        } else {
          downloadRequested = true;
          downloadMayHaveStarted = true;
        }
        await write({ [action]: action === 'reopenSource' ? sourceRequest : selection[action] });
      } catch (error) {
        taskError = error;
        if (!actionDeliveryAttempted && !work.signal.aborted) await write({ cancel: true });
        child.stdin.end();
      }
    } else if (value.phase === 'source-select') {
      if (
        !preflight ||
        !context ||
        !sourceRequested ||
        sourcePreflight ||
        viewerRequested ||
        downloadRequested ||
        viewerMayHaveOpened ||
        downloadMayHaveStarted ||
        taskError ||
        started ||
        result ||
        value.operation !== preflight.operation ||
        value.requested !== preflight.requested ||
        value.pid !== preflight.pid
      ) {
        rejectedSourcePreflight = value;
        throw new Error('Repeated, mismatched or out-of-order source download preflight');
      }
      sourcePreflight = value;
      let actionDeliveryAttempted = false;
      try {
        const selection = await Promise.race([
          Promise.resolve().then(() => selectSource(value, context, work.signal)),
          interruption(),
        ]);
        if (work.signal.aborted) throw new Error('Source download selection interrupted');
        const action = selectionAction(selection, { allowViewer: true });
        context = selection.context;
        if (action === 'openViewer' && typeof selectViewer !== 'function')
          throw new Error('Viewer opening requires a verified viewer-selection callback');
        actionDeliveryAttempted = true;
        if (action === 'openViewer') {
          viewerRequested = true;
          viewerMayHaveOpened = true;
        } else {
          downloadRequested = true;
          downloadMayHaveStarted = true;
        }
        await write({ [action]: selection[action] });
      } catch (error) {
        taskError = error;
        if (!actionDeliveryAttempted && !work.signal.aborted) await write({ cancel: true });
        child.stdin.end();
      }
    } else if (value.phase === 'viewer-select') {
      if (
        !preflight ||
        !context ||
        !viewerRequested ||
        downloadRequested ||
        viewerPreflight ||
        taskError ||
        started ||
        result
      ) {
        rejectedViewerPreflight = value;
        throw new Error('Repeated or out-of-order viewer download preflight');
      }
      viewerPreflight = value;
      let actionDeliveryAttempted = false;
      try {
        const selection = await Promise.race([
          Promise.resolve().then(() => selectViewer(value, context, work.signal)),
          interruption(),
        ]);
        if (work.signal.aborted) throw new Error('Viewer download selection interrupted');
        selectionAction(selection, { allowViewer: false });
        context = selection.context;
        actionDeliveryAttempted = true;
        downloadRequested = true;
        downloadMayHaveStarted = true;
        await write({ token: selection.token });
      } catch (error) {
        taskError = error;
        if (!actionDeliveryAttempted && !work.signal.aborted) await write({ cancel: true });
        child.stdin.end();
      }
    } else if (value.phase === 'started') {
      if (!preflight || !context || !downloadRequested || taskError || started || result)
        throw new Error('Download started without one verified selection');
      started = value;
      completionTask = (async () => {
        try {
          transfer = await complete(value, context, work.signal, publicationCheckpoint);
          if (work.signal.aborted) throw new Error('Attachment completion interrupted');
          completionFinished = true;
          await write({ finish: true });
          child.stdin.end();
        } catch (error) {
          taskError ??= error;
          if (!work.signal.aborted) {
            try {
              await write({ cancel: true });
            } catch {
              stop();
            }
          }
          child.stdin.end();
        }
      })();
    } else if (value.phase === 'publish') {
      if (
        !started ||
        !completionTask ||
        !publicationRequested ||
        publicationPreflight ||
        !resolvePublicationCheckpoint ||
        completionFinished ||
        result ||
        taskError ||
        value.operation !== started.operation ||
        value.requested !== started.requested ||
        value.pid !== started.pid ||
        value.action?.startedAt !== started.action?.startedAt
      ) {
        rejectedPublicationPreflight = value;
        throw new Error('Unsolicited, repeated or changed publication checkpoint');
      }
      publicationPreflight = value;
      if (value.status === 'stopped' || value.error)
        throw new Error(value.error ?? 'Publication workspace verification stopped');
      resolvePublicationCheckpoint(value);
      resolvePublicationCheckpoint = null;
    } else {
      const setupFailure =
        !preflight &&
        !value.phase &&
        value.status !== 'ok' &&
        (value.error || value.status === 'permission-required');
      if (value.phase !== 'result' && !setupFailure)
        throw new Error('Unexpected native download phase');
      if (result) throw new Error('Repeated native download result');
      result = value;
      if (
        value.phase === 'result' &&
        value.status === 'ok' &&
        (!started || !completionFinished || taskError)
      )
        throw new Error('Download result arrived before verified completion');
      if (value.error || value.status === 'stopped') {
        taskError ??= new Error(
          typeof value.error === 'string' ? value.error : 'Native download stopped'
        );
        work.abort();
      }
    }
  }
  let buffer = '',
    bytes = 0;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.byteLength;
      if (bytes > 32 * 1024 * 1024) throw new Error('Download receipt exceeded bounds');
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        if (!line) {
          buffer = buffer.slice(newline + 1);
          continue;
        }
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          break;
        }
        buffer = buffer.slice(newline + 1);
        await accept(value);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await accept(JSON.parse(buffer));
    const nativeCode = await exited;
    if (completionTask) {
      if (work.signal.aborted) await drainCompletion();
      else await completionTask;
    }
    if (signal?.aborted || timedOut)
      throw new Error(timedOut ? 'Attachment saving timed out' : 'Attachment saving cancelled');
    if (!result) throw new Error('Native download result is missing');
    return {
      code: taskError ? nativeCode || 1 : nativeCode,
      context,
      transfer,
      receipt: {
        ...result,
        ...(preflight ? { preflight } : {}),
        ...(sourcePreflight ? { sourcePreflight } : {}),
        ...(sourceRequest ? { sourceRequest } : {}),
        ...(sourceMayHaveReopened ? { sourceMayHaveReopened: true } : {}),
        ...(viewerPreflight ? { viewerPreflight } : {}),
        ...(started ? { started } : {}),
        ...(publicationPreflight ? { publicationPreflight } : {}),
        ...(rejectedPublicationPreflight ? { rejectedPublicationPreflight } : {}),
        viewerMayHaveOpened,
        downloadMayHaveStarted,
        ...(taskError ? { status: 'stopped', error: taskError.message, nativeResult: result } : {}),
        ...(taskError || nativeCode !== 0
          ? {
              next: recoveryHint(),
            }
          : {}),
      },
    };
  } catch (error) {
    taskError ??= error;
    stop();
    await exited;
    await drainCompletion();
    return {
      code: 1,
      context,
      transfer,
      receipt: {
        operation: 'save-media',
        status: 'stopped',
        error: taskError?.message ?? error.message,
        viewerMayHaveOpened,
        downloadMayHaveStarted,
        ...(preflight ? { preflight } : {}),
        ...(sourcePreflight ? { sourcePreflight } : {}),
        ...(sourceRequest ? { sourceRequest } : {}),
        ...(sourceMayHaveReopened ? { sourceMayHaveReopened: true } : {}),
        ...(rejectedSourcePreflight ? { rejectedSourcePreflight } : {}),
        ...(viewerPreflight ? { viewerPreflight } : {}),
        ...(rejectedViewerPreflight ? { rejectedViewerPreflight } : {}),
        ...(started ? { started } : {}),
        ...(publicationPreflight ? { publicationPreflight } : {}),
        ...(rejectedPublicationPreflight ? { rejectedPublicationPreflight } : {}),
        ...(result ? { nativeResult: result } : {}),
        next: recoveryHint(),
      },
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', cancel);
    work.abort();
    child.stdin.end();
  }
}
