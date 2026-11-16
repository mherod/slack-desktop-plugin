// One child and one helper lease span reference validation and native input.
// No selection token is sent until the caller has verified the fresh media binding.
export async function runTranscript(
  command,
  { signal, select, timeoutMs = 90000, terminationGraceMs = 1000, spawn = Bun.spawn }
) {
  if (signal?.aborted) throw new Error('Transcript inspection cancelled before native work');
  const child = spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  let timedOut = false;
  let interrupt;
  const interrupted = new Promise((resolve) => {
    interrupt = resolve;
  });
  let killTimer;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    // Only terminate our own helper. A wedged native read must not hold the
    // shared activity lease forever or survive a cancelled wrapper.
    killTimer = setTimeout(() => child.kill('SIGKILL'), terminationGraceMs);
  };
  const cancel = () => {
    interrupt('cancelled');
    stop();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    interrupt('timed out');
    stop();
  }, timeoutMs);
  let preflight = null,
    result = null,
    rejectedResult = null,
    context = null,
    selectionError = null;
  let openingMayHaveBeenRequested = false;
  let buffered = '',
    totalBytes = 0;
  const decoder = new TextDecoder();
  const accept = async (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid transcript protocol receipt');
    if (value.phase === 'select') {
      if (preflight || result) throw new Error('Repeated or out-of-order transcript preflight');
      preflight = value;
      try {
        const selected = await Promise.race([
          Promise.resolve().then(() => select(value)),
          interrupted.then((reason) => {
            throw new Error(`Transcript selection ${reason}`);
          }),
        ]);
        if (signal?.aborted || timedOut) throw new Error('Transcript selection cancelled');
        if (typeof selected?.token !== 'string' || !selected.token || selected.token.length > 200)
          throw new Error('No verified transcript selection token');
        context = selected.context;
        // A failed write/flush cannot prove that native did not receive the token.
        openingMayHaveBeenRequested = true;
        child.stdin.write(`${JSON.stringify({ token: selected.token })}\n`);
        await child.stdin.flush();
      } catch (error) {
        selectionError = error;
        if (!openingMayHaveBeenRequested && !signal?.aborted && !timedOut) {
          child.stdin.write('{"cancel":true}\n');
          await child.stdin.flush();
        }
      } finally {
        child.stdin.end();
      }
    } else {
      if (result || (value.phase === 'result' && (!preflight || !context || selectionError))) {
        rejectedResult = value;
        throw new Error('Transcript result has no verified selection');
      }
      result = value;
    }
  };
  try {
    for await (const chunk of child.stdout) {
      totalBytes += chunk.byteLength;
      if (totalBytes > 32 * 1024 * 1024)
        throw new Error('Transcript receipt exceeded output bounds');
      buffered += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        if (!line) {
          buffered = buffered.slice(newline + 1);
          continue;
        }
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          break;
        } // Existing permission/error receipts may be pretty JSON; parse at EOF.
        buffered = buffered.slice(newline + 1);
        await accept(value);
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) await accept(JSON.parse(buffered));
    const nativeCode = await child.exited;
    if (signal?.aborted)
      throw new Error('Transcript inspection cancelled; inspect current state before retrying');
    if (timedOut)
      throw new Error('Transcript inspection timed out; inspect current state before retrying');
    if (!result)
      throw new Error('Native transcript result is missing; inspect current state before retrying');
    return {
      code: selectionError ? 1 : nativeCode,
      context,
      receipt: {
        ...result,
        ...(preflight ? { preflight } : {}),
        ...(selectionError
          ? {
              status: 'stopped',
              error: selectionError.message,
              openingMayHaveBeenRequested,
              next: openingMayHaveBeenRequested
                ? 'Transcript opening may have been requested. Inspect the current Slack state before another command; do not replay the opening.'
                : 'Reread the source and follow an existing transcript hint; no transcript-opening token was sent.',
            }
          : {}),
      },
    };
  } catch (error) {
    stop();
    await child.exited;
    return {
      code: 1,
      context: null,
      receipt: {
        operation: 'read-transcript',
        status: 'stopped',
        error: selectionError?.message ?? error.message,
        openingMayHaveBeenRequested,
        ...(preflight ? { preflight } : {}),
        ...(result || rejectedResult ? { nativeResult: result ?? rejectedResult } : {}),
        next: 'Inspect the current Slack state before another command; do not replay an uncertain transcript opening.',
      },
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', cancel);
    child.stdin.end();
  }
}
