import { randomUUID } from 'node:crypto';
import { open, lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_LOCK_TIMEOUT = 30;
const ownerFile = 'owner.json';
const scope = 'cooperating helper processes only';
const operations = new Set([
  'inspect',
  'channels',
  'dms',
  'read-channel',
  'read-dm',
  'read-thread',
  'read-media',
  'read-transcript',
  'save-media',
  'search',
  'channel',
  'permissions',
  'workspaces',
  'current-workspace',
  'close-thread',
  'close-members',
  'members',
  'browse-channels',
  'browse-people',
  'switch-workspace',
  'send',
  'edit',
  'delete',
]);
const sameDirectory = (a, b) =>
  a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;

async function readOwner(directory) {
  let handle;
  try {
    const location = path.join(directory, ownerFile);
    const info = await lstat(location);
    if (!info.isFile() || info.size > 4096) return { ownerStatus: 'invalid' };
    handle = await open(location, 'r');
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > 4096
    )
      return { ownerStatus: 'invalid' };
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return { ownerStatus: 'invalid' };
    let owner;
    try {
      owner = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } catch {
      return { ownerStatus: 'invalid' };
    }
    if (
      owner?.version !== 1 ||
      typeof owner.token !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(owner.token) ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !operations.has(owner.operation) ||
      typeof owner.acquiredAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(owner.acquiredAt) ||
      !Number.isFinite(Date.parse(owner.acquiredAt))
    )
      return { ownerStatus: 'invalid' };
    return { ownerStatus: 'known', owner };
  } catch (error) {
    return { ownerStatus: error.code === 'ENOENT' ? 'legacy-or-initializing' : 'unreadable' };
  } finally {
    await handle?.close();
  }
}

function processState(pid) {
  if (!pid) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'running';
  } catch (error) {
    return error.code === 'ESRCH' ? 'not-running' : 'unknown';
  }
}

async function diagnostic(directory, reason, started, timeoutSeconds) {
  const { ownerStatus, owner } = await readOwner(directory);
  return {
    path: directory,
    reason,
    waitedMs: Math.round(performance.now() - started),
    timeoutSeconds,
    ownerStatus,
    ownerPid: owner?.pid ?? null,
    operation: owner?.operation ?? null,
    acquiredAt: owner?.acquiredAt ?? null,
    processState: processState(owner?.pid),
    scope,
  };
}

async function failure(directory, reason, started, timeoutSeconds, detail) {
  const error = new Error(detail);
  error.lock = await diagnostic(directory, reason, started, timeoutSeconds);
  error.next =
    'Retry after the owning helper finishes, or inspect the lock owner. Do not automatically remove the lock; PID liveness does not establish ownership or Slack UI state.';
  return error;
}

function pause(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// This lease coordinates cooperating wrappers, not Slack or other UI controllers.
// A dead PID is diagnostic evidence only: legacy locks and orphaned children are
// never reclaimed. Manual replacement of an active lock is unsupported.
export async function acquireLock(
  directory,
  { operation, timeoutSeconds = DEFAULT_LOCK_TIMEOUT, signal } = {}
) {
  if (!operations.has(operation)) throw new Error('Lock operation is invalid');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 120)
    throw new Error('Lock timeout must be an integer from 0 to 120 seconds');
  const started = performance.now();
  const deadline = started + timeoutSeconds * 1000;
  let identity;
  let attempted = false;
  for (;;) {
    if (signal?.aborted)
      throw await failure(
        directory,
        'cancelled',
        started,
        timeoutSeconds,
        'Cancelled while waiting for the Slack activity lock'
      );
    if (attempted && performance.now() >= deadline)
      throw await failure(
        directory,
        'timeout',
        started,
        timeoutSeconds,
        'Timed out waiting for the Slack activity lock'
      );
    attempted = true;
    try {
      await mkdir(directory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() >= deadline)
        throw await failure(
          directory,
          'timeout',
          started,
          timeoutSeconds,
          'Timed out waiting for the Slack activity lock'
        );
      await pause(Math.min(100, Math.max(1, deadline - performance.now())), signal);
    }
  }
  const token = randomUUID();
  const location = path.join(directory, ownerFile);
  try {
    identity = await lstat(directory);
    if (!identity.isDirectory())
      throw new Error('Activity lock directory changed during acquisition');
    const handle = await open(location, 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          version: 1,
          token,
          pid: process.pid,
          operation,
          acquiredAt: new Date().toISOString(),
        })
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Only an unchanged, empty directory can be removed after publication fails.
    // Unknown/partial owner data is deliberately retained for inspection.
    try {
      if (
        identity &&
        sameDirectory(identity, await lstat(directory)) &&
        (await readdir(directory)).length === 0
      )
        await rmdir(directory);
    } catch {
      /* Preserve the original acquisition failure. */
    }
    throw error;
  }
  const waitedMs = Math.round(performance.now() - started);
  let released = false;
  const release = async () => {
    if (released) return;
    try {
      const current = await lstat(directory);
      const entries = await readdir(directory);
      const { ownerStatus, owner } = await readOwner(directory);
      if (
        !sameDirectory(identity, current) ||
        entries.length !== 1 ||
        entries[0] !== ownerFile ||
        ownerStatus !== 'known' ||
        owner.token !== token ||
        !sameDirectory(identity, await lstat(directory))
      )
        throw new Error('Activity lock ownership changed; lock preserved');
      await unlink(location);
      await rmdir(directory);
      released = true;
    } catch (error) {
      const failureError = await failure(
        directory,
        'ownership-changed',
        started,
        timeoutSeconds,
        `Could not release the owned Slack activity lock: ${error.message}`
      );
      failureError.lock.waitedMs = waitedMs;
      throw failureError;
    }
  };
  if (signal?.aborted) {
    await release();
    throw await failure(
      directory,
      'cancelled',
      started,
      timeoutSeconds,
      'Cancelled before starting Slack work'
    );
  }
  return { waitedMs, timeoutSeconds, release };
}
