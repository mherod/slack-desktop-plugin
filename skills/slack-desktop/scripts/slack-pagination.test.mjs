import { describe, expect, test } from 'bun:test';
import { collectPages, paginateOutput } from './slack-pagination.mjs';

const ts = (n) => `1700000000.${String(n).padStart(6, '0')}`;
const rootTS = ts(0);
function fixture({
  count = 24,
  start = 1,
  thread = false,
  dm = false,
  root = true,
  total = count,
} = {}) {
  const id = dm ? 'DDEMO' : 'CDEMO';
  const message = (n) => ({
    id: thread ? `${id}-${rootTS}-thread-list-Thread_${ts(n)}` : `message-list_${ts(n)}`,
    permalink: `https://demo.slack.com/archives/${id}/p${ts(n).replace('.', '')}${thread && n ? `?thread_ts=${rootTS}` : ''}`,
    author: n % 2 ? 'Sam Example' : null,
    text: `Message ${n} ${'x'.repeat(600)}`,
    links: [],
    attachments: [],
    textComplete: false,
  });
  const records = Array.from({ length: count }, (_, i) => message(start + i));
  const compact = {
    schemaVersion: 1,
    operation: thread ? 'read-thread' : dm ? 'read-dm' : 'read-channel',
    requested: thread ? `${id}:${rootTS}` : dm ? '@alex.example' : 'project-help',
    conversation: { id, name: dm ? 'Alex Example' : 'project-help', kind: dm ? 'dm' : 'channel' },
    coverage: { complete: false, warnings: [], observedCount: records.length },
    pagination: { supported: false, hasMore: null, nextCursor: null },
    ...(thread
      ? {
          thread: {
            ref: `${id}:${rootTS}`,
            rootTS,
            root: root ? message(0) : null,
            rootPermalink: message(0).permalink,
            replies: records,
            observedReplyCount: count,
            displayedReplyCount: total,
          },
          navigation: [{ command: 'read-channel', args: ['project-help'] }],
        }
      : { messages: records }),
  };
  const values = Array.from({ length: count }, (_, i) => ts(start + i));
  const native = {
    direction: null,
    cursor: null,
    status: 'initial',
    scrollAttempts: 0,
    beforeTimestamps: thread && root ? [rootTS, ...values] : [...values],
    afterTimestamps: thread && root ? [rootTS, ...values] : [...values],
  };
  const page = (direction, boundary, options = {}) => ({
    ...native,
    direction,
    cursor: `${id}:${ts(boundary)}`,
    status: 'advanced',
    ...options,
  });
  return { compact, native, page, id, records };
}

describe('logical Slack pagination', () => {
  test('initial conversation returns the last ten full records with an older command at the shown boundary', () => {
    const f = fixture();
    const result = paginateOutput(f.compact, f.native);
    expect(result.messages.map((m) => m.id)).toEqual(f.records.slice(-10).map((m) => m.id));
    expect(result.messages[0].text.length).toBeGreaterThan(600);
    expect(result.pagination).toMatchObject({
      supported: true,
      direction: null,
      status: 'initial',
      hasMore: null,
      capturedCount: 24,
      returnedCount: 10,
      eligibleCount: 24,
      nextCursor: `CDEMO:${ts(15)}`,
      newer: null,
      older: {
        navigation: { command: 'read-channel', args: ['project-help', `--before=CDEMO:${ts(15)}`] },
      },
    });
    expect(result.coverage).toMatchObject({
      complete: false,
      observedCount: 10,
      capturedCount: 24,
    });
  });

  test('initial thread starts with the first ten replies without skipping the earlier loaded replies', () => {
    const f = fixture({ thread: true });
    const result = paginateOutput(f.compact, f.native);
    expect(result.thread.replies.map((m) => m.id)).toEqual(f.records.slice(0, 10).map((m) => m.id));
    expect(result.thread.root).toEqual(f.compact.thread.root);
    expect(result.thread).toMatchObject({ observedReplyCount: 10, capturedReplyCount: 24 });
    expect(result.pagination.older).toBeNull();
    expect(result.pagination.newer).toEqual({
      cursor: `CDEMO:${ts(10)}`,
      navigation: {
        command: 'read-thread',
        args: [`CDEMO:${rootTS}`, `--after=CDEMO:${ts(10)}`],
      },
    });
    expect(result.coverage).toMatchObject({ observedCount: 11, capturedCount: 25 });
  });

  test('successive forward pages serve every loaded reply once despite the viewport containing more than ten', () => {
    const f = fixture({ thread: true });
    const first = paginateOutput(f.compact, f.native);
    const second = paginateOutput(f.compact, f.page('newer', 10));
    const third = paginateOutput(f.compact, f.page('newer', 20));
    expect([...first.thread.replies, ...second.thread.replies, ...third.thread.replies]).toEqual(
      f.records
    );
    expect(second.pagination.nextCursor).toBe(`CDEMO:${ts(20)}`);
    expect(second.pagination.older.cursor).toBe(`CDEMO:${ts(11)}`);
    expect(third.pagination.newer).toBeNull();
    expect(third.pagination.hasMore).toBeNull();
    expect(third.coverage.complete).toBe(false);
  });

  test('older pages exclude overlap and retain nearest older rows before offering their shown boundary', () => {
    const f = fixture();
    const result = paginateOutput(f.compact, f.page('older', 15));
    expect(result.messages).toEqual(f.records.slice(4, 14));
    expect(result.pagination.nextCursor).toBe(`CDEMO:${ts(5)}`);
    expect(result.pagination.newer.cursor).toBe(`CDEMO:${ts(14)}`);
    expect(result.pagination.eligibleCount).toBe(14);
  });

  test('DM actions keep the verified display name as one argument', () => {
    const f = fixture({ dm: true });
    const result = paginateOutput(f.compact, f.native);
    expect(result.pagination.older.navigation).toEqual({
      command: 'read-dm',
      args: ['Alex Example', `--before=DDEMO:${ts(15)}`],
    });
  });

  test('group DM continuations use the verified ID instead of an ambiguous display label', () => {
    const f = fixture();
    Object.assign(f.compact, { operation: 'read-dm', requested: 'group:CDEMO' });
    Object.assign(f.compact.conversation, { kind: 'dm', dmKind: 'group', name: 'Sam, Alex' });
    const first = paginateOutput(f.compact, f.native);
    expect(first.pagination.older.navigation).toEqual({
      command: 'read-dm',
      args: ['group:CDEMO', `--before=CDEMO:${ts(15)}`],
    });
    const second = paginateOutput(f.compact, f.page('older', 15));
    expect(second.pagination.newer.navigation.args).toEqual([
      'group:CDEMO',
      `--after=CDEMO:${ts(14)}`,
    ]);
    expect(second.messages).toEqual(f.records.slice(4, 14));
    expect(second.conversation.dmKind).toBe('group');
  });

  test('group DM metadata cannot turn an individual DM or channel into a group continuation', () => {
    for (const dm of [false, true]) {
      const f = fixture({ dm });
      f.compact.operation = 'read-dm';
      f.compact.conversation.dmKind = 'group';
      expect(() => paginateOutput(f.compact, f.native)).toThrow('group DM identity');
    }
  });

  test('virtualized roots retain both thread directions and never invent root text', () => {
    const f = fixture({ thread: true, root: false, start: 5, count: 3, total: 20 });
    const result = paginateOutput(f.compact, f.native);
    expect(result.thread.root).toBeNull();
    expect(result.pagination.older.cursor).toBe(`CDEMO:${ts(5)}`);
    expect(result.pagination.newer.cursor).toBe(`CDEMO:${ts(7)}`);
  });

  test('an exposed root alone does not hide continuation when Slack displays more replies', () => {
    const f = fixture({ thread: true, count: 2, total: 6 });
    const result = paginateOutput(f.compact, f.native);
    expect(result.pagination.older).toBeNull();
    expect(result.pagination.newer.cursor).toBe(`CDEMO:${ts(2)}`);
    expect(result.coverage.warnings).toContain('2 of 6 displayed thread replies are exposed');
  });

  test('explicit zero replies retain the separate root without offering unusable page commands', () => {
    const f = fixture({ thread: true, count: 0 });
    const result = paginateOutput(f.compact, f.native);
    expect(result.thread.replies).toEqual([]);
    expect(result.thread.root).toEqual(f.compact.thread.root);
    expect(result.pagination).toMatchObject({
      older: null,
      newer: null,
      nextCursor: null,
      hasMore: null,
    });
  });

  test('stale and foreign cursor identities fail before any content is returned', () => {
    const f = fixture();
    expect(() => paginateOutput(f.compact, f.page('older', 99))).toThrow('stale');
    expect(() =>
      paginateOutput(f.compact, f.page('older', 10, { cursor: `COTHER:${ts(10)}` }))
    ).toThrow('different conversation');
    expect(() => paginateOutput(f.compact, f.page('older', 10, { cursor: 'CDEMO:1.1' }))).toThrow(
      'different conversation'
    );
  });

  test('scrolling requires the exact directional edge across before and after captures', () => {
    const f = fixture({ start: 11, count: 10 });
    expect(() =>
      paginateOutput(
        f.compact,
        f.page('newer', 10, {
          beforeTimestamps: [ts(9), ts(10)],
          scrollAttempts: 1,
        })
      )
    ).toThrow('verified scrolled edge');
    const result = paginateOutput(
      f.compact,
      f.page('newer', 10, {
        beforeTimestamps: [ts(9), ts(10), ts(11)],
        scrollAttempts: 1,
      })
    );
    expect(result.messages).toEqual(f.records);
  });

  test('retaining only the thread root cannot conceal skipped replies after scrolling newer', () => {
    const f = fixture({ thread: true, start: 20, count: 2, total: 21 });
    expect(() =>
      paginateOutput(
        f.compact,
        f.page('newer', 2, {
          beforeTimestamps: [rootTS, ts(1), ts(2)],
          scrollAttempts: 1,
        })
      )
    ).toThrow('verified scrolled edge');
  });

  test('older scrolling cannot substitute a surviving newer row for the oldest edge', () => {
    const f = fixture({ start: 1, count: 10 });
    expect(() =>
      paginateOutput(
        f.compact,
        f.page('older', 10, {
          beforeTimestamps: [ts(0), ts(10)],
          scrollAttempts: 1,
        })
      )
    ).toThrow('verified scrolled edge');
    const result = paginateOutput(
      f.compact,
      f.page('older', 10, {
        beforeTimestamps: [ts(10), ts(11)],
        scrollAttempts: 1,
      })
    );
    expect(result.messages).toEqual(f.records.slice(0, 9));
  });

  test('no progress returns an empty page and no same-direction retry without claiming an endpoint', () => {
    const f = fixture({ count: 4 });
    const result = paginateOutput(
      f.compact,
      f.page('older', 1, { status: 'no-progress', scrollAttempts: 1 })
    );
    expect(result.messages).toEqual([]);
    expect(result.pagination).toMatchObject({
      status: 'no-progress',
      older: null,
      nextCursor: null,
      hasMore: null,
    });
    expect(result.pagination.newer.cursor).toBe(`CDEMO:${ts(4)}`);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.warnings.at(-1)).toContain('end of history is unknown');
  });

  test('no-progress preserves a thread root but does not count it as a new reply', () => {
    const f = fixture({ thread: true, count: 2 });
    const result = paginateOutput(f.compact, f.page('newer', 2, { status: 'no-progress' }));
    expect(result.thread.observedReplyCount).toBe(0);
    expect(result.thread.root).toEqual(f.compact.thread.root);
    expect(result.pagination.newer).toBeNull();
    expect(result.coverage.observedCount).toBe(1);
  });

  test('native advancement and no-progress claims must agree with eligible records', () => {
    const f = fixture({ count: 4 });
    expect(() => paginateOutput(f.compact, f.page('older', 1))).toThrow('without new messages');
    expect(() => paginateOutput(f.compact, f.page('older', 4, { status: 'no-progress' }))).toThrow(
      'despite eligible messages'
    );
  });

  test('native timestamps and semantic message order must match exactly', () => {
    const f = fixture({ count: 3 });
    expect(() =>
      paginateOutput(f.compact, { ...f.native, afterTimestamps: [ts(1), ts(3)] })
    ).toThrow('differ');
    expect(() =>
      paginateOutput(f.compact, { ...f.native, afterTimestamps: [ts(1), ts(1), ts(3)] })
    ).toThrow('duplicated');
    f.compact.messages.reverse();
    expect(() => paginateOutput(f.compact, f.native)).toThrow('out of order');
  });

  test('canonical identities reject foreign permalinks and mismatched row timestamps', () => {
    const f = fixture({ count: 3 });
    f.compact.messages[0].permalink = f.compact.messages[0].permalink.replace(
      '/CDEMO/',
      '/COTHER/'
    );
    expect(() => paginateOutput(f.compact, f.native)).toThrow('different conversation');
    f.compact.messages[0].permalink = f.compact.messages[1].permalink;
    expect(() => paginateOutput(f.compact, f.native)).toThrow('differs from its permalink');
  });

  test('stale thread row namespaces deduplicate using verified permalink timestamp', () => {
    const f = fixture({ thread: true, count: 2 });
    f.compact.thread.replies[0].id = `COLD-1699999999.000001-thread-list-Thread_${ts(1)}`;
    const result = paginateOutput(f.compact, f.native);
    expect(result.thread.replies).toHaveLength(2);
    f.compact.thread.replies.push(structuredClone(f.compact.thread.replies[0]));
    expect(() => paginateOutput(f.compact, f.native)).toThrow('duplicated or out of order');
  });

  test('root duplication and conflicting root parameters are rejected', () => {
    const f = fixture({ thread: true, count: 2 });
    f.compact.thread.replies.unshift(structuredClone(f.compact.thread.root));
    expect(() => paginateOutput(f.compact, f.native)).toThrow('contain the root');
    f.compact.thread.replies.shift();
    f.compact.thread.replies[0].permalink = f.compact.thread.replies[0].permalink.replace(
      rootTS,
      ts(99)
    );
    expect(() => paginateOutput(f.compact, f.native)).toThrow('conflicting thread identity');
  });

  test('timestamps remain strings without loss of microsecond boundaries', () => {
    const f = fixture({ start: 999997, count: 3 });
    const result = paginateOutput(f.compact, f.page('newer', 999997));
    expect(result.messages).toEqual(f.records.slice(1));
    expect(result.pagination.newer.cursor).toBe('CDEMO:1700000000.999999');
    expect(typeof result.pagination.cursor).toBe('string');
  });

  test('input remains immutable and old full-capture count notes are replaced', () => {
    const f = fixture({ thread: true, count: 24, total: 30 });
    f.compact.coverage.warnings = [
      '24 of 30 displayed thread replies are exposed',
      'Attachment content unknown',
    ];
    const before = structuredClone({ compact: f.compact, native: f.native });
    const result = paginateOutput(f.compact, f.native);
    result.thread.replies[0].text = 'caller change';
    expect({ compact: f.compact, native: f.native }).toEqual(before);
    expect(result.coverage.warnings).toEqual([
      'Attachment content unknown',
      '24 of 30 displayed thread replies are exposed',
    ]);
    expect(result.navigation).toEqual(f.compact.navigation);
    expect(result.coverage.reason).not.toContain('No scrolling');
  });
});

// Collection fixtures retain only public semantic identity plus the verified
// native timestamp receipt; no private Slack messages are embedded here.
function collectionFixture(options) {
  const f = fixture(options);
  f.compact.workspace = { contextId: 'TDEMO', id: 'TDEMO', name: 'Demo' };
  f.compact.view = {
    title: 'Verified conversation',
    url: `https://app.slack.com/client/TDEMO/${f.id}`,
  };
  return f;
}
const frame = (f, nativePage = f.native) => ({ compact: f.compact, nativePage });
const batch = (overrides = {}) => ({
  requestedPages: 3,
  attemptedPages: 3,
  completedPages: 3,
  direction: 'older',
  stopReason: 'page-limit',
  ...overrides,
});

describe('bounded Slack page collection', () => {
  test('group DM pages deduplicate messages and preserve ID-bound navigation', () => {
    const f = collectionFixture();
    Object.assign(f.compact, { operation: 'read-dm', requested: 'group:CDEMO' });
    Object.assign(f.compact.conversation, { kind: 'dm', dmKind: 'group', name: 'Sam, Alex' });
    const result = collectPages(
      [frame(f), frame(f, f.page('older', 15)), frame(f, f.page('older', 5))],
      batch()
    );
    expect(result.messages).toEqual(f.records);
    expect(result.conversation).toMatchObject({ kind: 'dm', dmKind: 'group', id: 'CDEMO' });
    expect(result.pagination.batch.deduplicatedCount).toBe(48);
    expect(result.pagination.older.navigation.args).toEqual([
      'group:CDEMO',
      `--before=CDEMO:${ts(1)}`,
    ]);
  });

  test('group DM subtype, ID and display-name changes retain only the verified prefix', () => {
    for (const change of ['subtype', 'id', 'name']) {
      const f = collectionFixture();
      Object.assign(f.compact, { operation: 'read-dm', requested: 'group:CDEMO' });
      Object.assign(f.compact.conversation, { kind: 'dm', dmKind: 'group', name: 'Sam, Alex' });
      const second = structuredClone(frame(f, f.page('older', 15)));
      if (change === 'subtype') delete second.compact.conversation.dmKind;
      if (change === 'id') second.compact.conversation.id = 'COTHER';
      if (change === 'name') second.compact.conversation.name = 'Sam, Taylor';
      const result = collectPages(
        [frame(f), second],
        batch({ attemptedPages: 2, completedPages: 2 })
      );
      expect(result.status).toBe('partial');
      expect(result.messages).toEqual(f.records.slice(-10));
      expect(result.pagination).toMatchObject({
        older: null,
        newer: null,
        nextCursor: null,
        batch: { completedPages: 1, stopReason: 'error' },
      });
    }
  });

  test('collects three logical pages as 24 chronological unique messages while deduplicating viewport overlap', () => {
    const f = collectionFixture();
    const result = collectPages(
      [frame(f), frame(f, f.page('older', 15)), frame(f, f.page('older', 5))],
      batch()
    );
    expect(result.messages).toEqual(f.records);
    expect(new Set(result.messages.map((message) => message.id)).size).toBe(24);
    expect(result.pagination).toMatchObject({
      capturedCount: 24,
      returnedCount: 24,
      hasMore: null,
      nextCursor: `CDEMO:${ts(1)}`,
      batch: { completedPages: 3, deduplicatedCount: 48, stopReason: 'page-limit' },
    });
    expect(result.coverage).toMatchObject({
      complete: false,
      observedCount: 24,
      capturedCount: 24,
    });
    expect(result.status).toBe('ok');
    expect(result.pagination.newer.cursor).toBe(`CDEMO:${ts(4)}`);
  });

  test('retains distinct IDs with identical text instead of deduplicating message content', () => {
    const f = collectionFixture();
    for (const message of f.records) message.text = 'Same text';
    const result = collectPages(
      [frame(f), frame(f, f.page('older', 15)), frame(f, f.page('older', 5))],
      batch()
    );
    expect(result.messages).toHaveLength(24);
    expect(result.messages.map((message) => message.id)).toEqual(
      f.records.map((message) => message.id)
    );
  });

  test('direction, cursor and scope changes retain only the verified prefix without navigation', () => {
    for (const changed of ['direction', 'cursor', 'workspace', 'conversation', 'operation']) {
      const f = collectionFixture();
      const second = frame(f, f.page('older', 15));
      second.compact = structuredClone(second.compact);
      if (changed === 'direction') second.nativePage = f.page('newer', 15);
      if (changed === 'cursor') second.nativePage = f.page('older', 14);
      if (changed === 'workspace') {
        second.compact.workspace.contextId = 'TOTHER';
        second.compact.workspace.id = 'TOTHER';
        second.compact.view.url = `https://app.slack.com/client/TOTHER/${f.id}`;
      }
      if (changed === 'conversation') second.compact.conversation.name = 'Another channel';
      if (changed === 'operation') second.compact.operation = 'read-dm';
      const result = collectPages(
        [frame(f), second],
        batch({ attemptedPages: 2, completedPages: 2 })
      );
      expect(result.status).toBe('partial');
      expect(result.messages).toEqual(f.records.slice(-10));
      expect(result.pagination).toMatchObject({
        older: null,
        newer: null,
        nextCursor: null,
        batch: { completedPages: 1, stopReason: 'error' },
      });
      expect(result.error).toBeTruthy();
    }
  });

  test('a first extraction failure throws, while a later failure retains only extracted pages', () => {
    const f = collectionFixture();
    const frames = [frame(f), frame(f, f.page('older', 15))];
    const metadata = batch({ attemptedPages: 2, completedPages: 2 });
    expect(() =>
      collectPages(frames, metadata, {}, () => {
        throw new Error('Unverified first capture');
      })
    ).toThrow('Unverified first capture');
    const result = collectPages(frames, metadata, {}, (value, index) => {
      if (index === 1) throw new Error('Malformed second capture');
      return value;
    });
    expect(result.error).toBe('Malformed second capture');
    expect(result.messages).toEqual(f.records.slice(-10));
    expect(result.pagination.batch.completedPages).toBe(1);
    expect(result.pagination.nextCursor).toBeNull();
  });

  test('thread root stays separate and appears once after it leaves later captures', () => {
    const first = collectionFixture({ thread: true, count: 12 });
    const second = collectionFixture({ thread: true, count: 12, root: false });
    second.compact.coverage.warnings.push('Root message is outside this view.');
    const result = collectPages(
      [frame(first), frame(second, second.page('newer', 10))],
      batch({ requestedPages: 2, attemptedPages: 2, completedPages: 2, direction: 'newer' })
    );
    expect(result.status).toBe('ok');
    expect(result.thread.root).toEqual(first.compact.thread.root);
    expect(result.thread.replies).toEqual(first.records);
    expect(result.thread.replies.some((message) => message.id === result.thread.root.id)).toBe(
      false
    );
    expect(result.thread).toMatchObject({ observedReplyCount: 12, capturedReplyCount: 12 });
    expect(result.coverage).toMatchObject({
      observedCount: 13,
      capturedCount: 13,
      complete: false,
    });
    expect(result.coverage.warnings).not.toContain('Root message is outside this view.');
    expect(result.pagination.batch.deduplicatedCount).toBe(12);
  });

  test('changed thread DOM namespaces still deduplicate canonical reply timestamps', () => {
    const f = collectionFixture({ thread: true, count: 14 });
    const second = structuredClone(frame(f, f.page('newer', 10)));
    for (const message of second.compact.thread.replies)
      message.id = `COLD-1699999999.000001-thread-list-Thread_${message.id.split('_').at(-1)}`;
    const result = collectPages(
      [frame(f), second],
      batch({ requestedPages: 2, attemptedPages: 2, completedPages: 2, direction: 'newer' })
    );
    expect(result.status).toBe('ok');
    expect(result.thread.replies).toHaveLength(14);
    expect(result.thread.capturedReplyCount).toBe(14);
    expect(result.pagination.batch.deduplicatedCount).toBe(14);
  });

  test('empty no-progress pages preserve collected content and only final-view opposite hints', () => {
    const f = collectionFixture({ count: 4 });
    const stopped = frame(f, f.page('older', 1, { status: 'no-progress', scrollAttempts: 1 }));
    const result = collectPages(
      [frame(f), stopped],
      batch({ requestedPages: 5, attemptedPages: 2, completedPages: 2, stopReason: 'no-progress' })
    );
    expect(result.messages).toEqual(f.records);
    expect(result.status).toBe('ok');
    expect(result.pagination).toMatchObject({
      status: 'no-progress',
      older: null,
      nextCursor: null,
      newer: { cursor: `CDEMO:${ts(4)}` },
      scrollAttempts: 1,
      batch: { completedPages: 2, stopReason: 'no-progress' },
    });
    expect(result.coverage.complete).toBe(false);
    expect(
      result.coverage.warnings.some((warning) => warning.includes('end of history is unknown'))
    ).toBe(true);
  });

  test('a native failure after a good page retains data with both directions withheld', () => {
    const f = collectionFixture();
    const result = collectPages(
      [frame(f)],
      batch({ requestedPages: 4, attemptedPages: 2, completedPages: 1, stopReason: 'error' }),
      { status: 'partial', error: 'Conversation changed before page two' }
    );
    expect(result.status).toBe('partial');
    expect(result.messages).toEqual(f.records.slice(-10));
    expect(result.error).toBe('Conversation changed before page two');
    expect(result.pagination).toMatchObject({ older: null, newer: null, nextCursor: null });
    expect(result.next).toContain('Inspect the current view');
  });

  test('rejects malformed budgets and native frame counters before aggregation', () => {
    const f = collectionFixture();
    const valid = { requestedPages: 3, attemptedPages: 1, completedPages: 1 };
    for (const overrides of [
      { requestedPages: 1 },
      // A --since read may page up to 30; nothing goes beyond that.
      { requestedPages: 31 },
      { requestedPages: 2.5 },
      { completedPages: 0 },
      { completedPages: 2 },
      { attemptedPages: 0 },
      { attemptedPages: 4 },
      { attemptedPages: 1.5 },
      { direction: 'sideways' },
      { stopReason: 'finished' },
    ]) {
      expect(() => collectPages([frame(f)], batch({ ...valid, ...overrides }))).toThrow();
    }
    expect(() => collectPages([], batch({ attemptedPages: 0, completedPages: 0 }))).toThrow();
  });

  test('disagreed terminal reasons become partial instead of claiming a complete request', () => {
    const f = collectionFixture();
    for (const stopReason of ['page-limit', 'no-progress', 'no-next-page', 'error', 'time-limit']) {
      const result = collectPages(
        [frame(f)],
        batch({ attemptedPages: 1, completedPages: 1, stopReason })
      );
      expect(result.status).toBe('partial');
      expect(result.messages).toEqual(f.records.slice(-10));
      expect(result.pagination.nextCursor).toBeNull();
      expect(result.error).toContain('stop reason');
    }
    const unverifiedAttempt = collectPages(
      [frame(f)],
      batch({ attemptedPages: 2, completedPages: 1 })
    );
    expect(unverifiedAttempt.error).toContain('unverified attempt');
  });

  test('a fully exposed thread can stop before its budget without claiming complete history', () => {
    const f = collectionFixture({ thread: true, count: 4 });
    const result = collectPages(
      [frame(f)],
      batch({
        attemptedPages: 1,
        completedPages: 1,
        direction: 'newer',
        stopReason: 'no-next-page',
      })
    );
    expect(result.status).toBe('ok');
    expect(result.thread.replies).toEqual(f.records);
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.coverage.complete).toBe(false);
  });

  test('replaces an authorless edge record with a later whole observation that has an author', () => {
    const f = collectionFixture({ dm: true });
    // The first page selects messages 15–24; the older page's capture still
    // exposes message 15 (its cursor boundary) beside its sender row.
    const second = structuredClone(frame(f, f.page('older', 15)));
    const key = `message-list_${ts(15)}`;
    const later = second.compact.messages.find((message) => message.id === key);
    expect(later).toBeDefined();
    f.compact.messages.find((message) => message.id === key).author = null;
    later.author = 'Sam Example';
    later.authorInferred = true;
    later.authorSourceMessageId = 'message-list_source';
    later.text = 'Later whole observation';
    const result = collectPages(
      [frame(f), second],
      batch({ requestedPages: 2, attemptedPages: 2, completedPages: 2 })
    );
    const kept = result.messages.find((message) => message.id === key);
    expect(kept).toMatchObject({
      author: 'Sam Example',
      authorInferred: true,
      authorSourceMessageId: 'message-list_source',
      text: 'Later whole observation',
    });
  });

  test('retains initial request metadata and whole records without mutating observations', () => {
    const f = collectionFixture({ dm: true });
    f.compact.conversation.handle = '@alex.example';
    f.compact.messages.at(-1).authorInferred = true;
    f.compact.messages.at(-1).authorSourceMessageId = f.compact.messages.at(-2).id;
    f.compact.messages.at(-1).attachments = [
      {
        label: 'diagram.png',
        kind: 'image',
        ref: 'FEXAMPLE1',
        fileId: 'FEXAMPLE1',
        referenceScope: 'workspace-file',
        contentRead: false,
        description: 'First observed description',
        descriptionSource: 'accessibility',
      },
    ];
    f.compact.messages.at(-1).previews = [
      { kind: 'link', title: 'Design', url: 'https://example.com', ref: `DDEMO:${ts(24)}/p1` },
    ];
    const second = structuredClone(frame(f, f.page('older', 15)));
    second.compact.requested = 'Alex Example';
    second.compact.conversation.handle = null;
    second.compact.messages.at(-1).text = 'Edited in a later overlapping observation';
    second.compact.messages.at(-1).attachments[0].description = 'Different later description';
    const frames = [frame(f), second];
    const original = structuredClone(frames);
    const result = collectPages(
      frames,
      batch({ requestedPages: 2, attemptedPages: 2, completedPages: 2 })
    );
    expect(result.requested).toBe('@alex.example');
    expect(result.conversation.handle).toBe('@alex.example');
    expect(result.messages.at(-1)).toEqual(f.records.at(-1));
    expect(result.messages.at(-1).authorInferred).toBe(true);
    expect(result.messages.at(-1).attachments[0].description).toBe('First observed description');
    expect(result.messages.at(-1).attachments[0].ref).toBe('FEXAMPLE1');
    expect(result.messages.at(-1).previews).toEqual(f.records.at(-1).previews);
    result.messages[0].text = 'Caller change';
    expect(frames).toEqual(original);
  });
});
