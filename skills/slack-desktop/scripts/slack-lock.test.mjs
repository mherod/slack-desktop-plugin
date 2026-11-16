import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, DEFAULT_LOCK_TIMEOUT } from './slack-lock.mjs';

const roots = [];
const children = new Set();
afterEach(async () => {
  for (const child of children) {
    child.kill('SIGTERM');
    await child.exited;
  }
  children.clear();
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'slack-lock-test-'));
  roots.push(root);
  return { root, lock: path.join(root, 'active.lock') };
}
async function eventually(predicate) {
  const deadline = performance.now() + 5000;
  while (!(await predicate())) {
    if (performance.now() >= deadline)
      throw new Error('Subprocess fixture did not reach expected state');
    await Bun.sleep(10);
  }
}
async function worker(f, name, timeout = 3) {
  const script = path.join(f.root, `${name}.mjs`);
  const module = new URL('./slack-lock.mjs', import.meta.url).href;
  await writeFile(
    script,
    `
import { acquireLock } from ${JSON.stringify(module)};
import { open, writeFile, unlink } from 'node:fs/promises';
const [root, name, timeout] = process.argv.slice(2);
const control = new AbortController();
const cancel = () => control.abort();
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);
let lease;
let sentinel;
try {
  await writeFile(root + '/' + name + '.started', 'started');
  lease = await acquireLock(root + '/active.lock', { operation:'dms', timeoutSeconds:Number(timeout), signal:control.signal });
  sentinel = await open(root + '/exclusive', 'wx');
  await writeFile(root + '/' + name + '.entered', 'entered');
  while (!(await Bun.file(root + '/' + name + '.release').exists()) && !control.signal.aborted) await Bun.sleep(10);
  await sentinel.close(); sentinel = null;
  await unlink(root + '/exclusive');
  await lease.release(); lease = null;
  await writeFile(root + '/' + name + '.result', JSON.stringify({status:'ok'}));
} catch (error) {
  await writeFile(root + '/' + name + '.result', JSON.stringify({status:'error', message:error.message, lock:error.lock}));
} finally {
  if (sentinel) { await sentinel.close(); await unlink(root + '/exclusive'); }
  if (lease) await lease.release();
}
`
  );
  const child = Bun.spawn([process.execPath, script, f.root, name, String(timeout)], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  children.add(child);
  return {
    child,
    started: () => Bun.file(path.join(f.root, `${name}.started`)).exists(),
    entered: () => Bun.file(path.join(f.root, `${name}.entered`)).exists(),
    release: () => writeFile(path.join(f.root, `${name}.release`), 'release'),
    result: async () => {
      await child.exited;
      children.delete(child);
      return JSON.parse(await readFile(path.join(f.root, `${name}.result`), 'utf8'));
    },
  };
}

describe('activity lock ownership', () => {
  test.each(['workspaces', 'current-workspace', 'switch-workspace', 'close-members'])(
    'retains %s as a known lock owner under contention',
    async (operation) => {
      const f = await fixture();
      const lease = await acquireLock(f.lock, { operation });
      const before = await readFile(path.join(f.lock, 'owner.json'), 'utf8');
      await expect(
        acquireLock(f.lock, { operation: 'current-workspace', timeoutSeconds: 0 })
      ).rejects.toMatchObject({
        lock: { ownerStatus: 'known', operation, ownerPid: process.pid, reason: 'timeout' },
      });
      expect(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).toBe(before);
      await lease.release();
      expect(await readdir(f.root)).toEqual([]);
    }
  );

  test('publishes bounded owner metadata, releases once, defaults to 30 seconds', async () => {
    const f = await fixture();
    const lease = await acquireLock(f.lock, { operation: 'inspect' });
    expect(DEFAULT_LOCK_TIMEOUT).toBe(30);
    expect(lease.timeoutSeconds).toBe(30);
    expect(lease.waitedMs).toBeGreaterThanOrEqual(0);
    const owner = JSON.parse(await readFile(path.join(f.lock, 'owner.json'), 'utf8'));
    expect(Object.keys(owner).sort()).toEqual([
      'acquiredAt',
      'operation',
      'pid',
      'token',
      'version',
    ]);
    expect(owner.pid).toBe(process.pid);
    expect(owner.operation).toBe('inspect');
    await lease.release();
    await lease.release();
    expect(await readdir(f.root)).toEqual([]);
  });

  test('does not treat a non-contention filesystem error as a held lock', async () => {
    const f = await fixture();
    await expect(
      acquireLock(path.join(f.root, 'absent', 'lock'), { operation: 'dms' })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('never reclaims empty legacy locks or malformed metadata', async () => {
    const f = await fixture();
    await mkdir(f.lock);
    for (const [content, status] of [
      [null, 'legacy-or-initializing'],
      ['{broken', 'invalid'],
    ]) {
      if (content) await writeFile(path.join(f.lock, 'owner.json'), content);
      let error;
      try {
        await acquireLock(f.lock, { operation: 'inspect', timeoutSeconds: 0 });
      } catch (caught) {
        error = caught;
      }
      expect(error.lock).toMatchObject({
        ownerStatus: status,
        processState: 'unknown',
        reason: 'timeout',
      });
      expect(await readdir(f.lock)).toEqual(content ? ['owner.json'] : []);
    }
  });

  test('refuses to release a changed token, extra contents or replaced directory', async () => {
    for (const change of ['token', 'extra', 'directory']) {
      const f = await fixture();
      const lease = await acquireLock(f.lock, { operation: 'dms' });
      if (change === 'token') {
        const filename = path.join(f.lock, 'owner.json');
        const data = JSON.parse(await readFile(filename, 'utf8'));
        await writeFile(
          filename,
          JSON.stringify({ ...data, token: '00000000-0000-0000-0000-000000000000' })
        );
      } else if (change === 'extra') await writeFile(path.join(f.lock, 'foreign'), 'keep');
      else {
        await rename(f.lock, `${f.lock}.original`);
        await mkdir(f.lock);
      }
      const before = await readdir(f.lock);
      await expect(lease.release()).rejects.toMatchObject({
        lock: { reason: 'ownership-changed' },
      });
      expect(await readdir(f.lock)).toEqual(before);
    }
  });

  test('an already cancelled acquisition never creates a lock', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireLock(f.lock, { operation: 'dms', signal: controller.signal })
    ).rejects.toMatchObject({ lock: { reason: 'cancelled' } });
    expect(await readdir(f.root)).toEqual([]);
  });
});

describe('real process contention', () => {
  test('serializes independently running helpers and lets a waiter acquire after release', async () => {
    const f = await fixture();
    const first = await worker(f, 'first');
    await eventually(first.entered);
    const second = await worker(f, 'second');
    await eventually(second.started);
    await Bun.sleep(150);
    expect(await second.entered()).toBe(false);
    await first.release();
    expect(await first.result()).toEqual({ status: 'ok' });
    await eventually(second.entered);
    await second.release();
    expect(await second.result()).toEqual({ status: 'ok' });
    await expect(readdir(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('zero and bounded timeouts report live owner without modifying its lease', async () => {
    const f = await fixture();
    const holder = await worker(f, 'holder');
    await eventually(holder.entered);
    const before = await readFile(path.join(f.lock, 'owner.json'), 'utf8');
    for (const timeout of [0, 1]) {
      const waiter = await worker(f, `waiter${timeout}`, timeout);
      const result = await waiter.result();
      expect(result.lock).toMatchObject({
        reason: 'timeout',
        timeoutSeconds: timeout,
        ownerStatus: 'known',
        ownerPid: holder.child.pid,
        operation: 'dms',
        processState: 'running',
      });
      if (timeout) expect(result.lock.waitedMs).toBeGreaterThanOrEqual(990);
      expect(result.lock.waitedMs).toBeLessThan(2000);
      expect(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).toBe(before);
    }
    await holder.release();
    await holder.result();
  });

  test('SIGTERM cancels a waiting helper without touching the holder', async () => {
    const f = await fixture();
    const holder = await worker(f, 'holder');
    await eventually(holder.entered);
    const before = await readFile(path.join(f.lock, 'owner.json'), 'utf8');
    const waiter = await worker(f, 'waiter');
    await eventually(waiter.started);
    await Bun.sleep(150);
    waiter.child.kill('SIGTERM');
    const result = await waiter.result();
    expect(result.lock.reason).toBe('cancelled');
    expect(await waiter.entered()).toBe(false);
    expect(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).toBe(before);
    await holder.release();
    await holder.result();
  });

  test('an exited owner PID remains diagnostic only and is not reclaimed', async () => {
    const f = await fixture();
    const child = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' });
    children.add(child);
    await child.exited;
    children.delete(child);
    await mkdir(f.lock);
    const owner = JSON.stringify({
      version: 1,
      token: '00000000-0000-0000-0000-000000000000',
      pid: child.pid,
      operation: 'inspect',
      acquiredAt: new Date().toISOString(),
    });
    await writeFile(path.join(f.lock, 'owner.json'), owner);
    await expect(
      acquireLock(f.lock, { operation: 'dms', timeoutSeconds: 0 })
    ).rejects.toMatchObject({
      lock: { reason: 'timeout', processState: 'not-running', ownerPid: child.pid },
    });
    expect(await readFile(path.join(f.lock, 'owner.json'), 'utf8')).toBe(owner);
  });
});
