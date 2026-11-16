import { describe, expect, test } from 'bun:test';
import { applySince, withMessageRange } from './slack-output.mjs';
import { parseCLI } from './slack-format.mjs';

// Synthetic identities only.
const message = (seconds, displayedTime) => ({
  id: `message-list_${seconds}.000001`,
  author: 'Alex Example',
  displayedTime,
});
const compact = (operation = 'read-channel') => ({
  operation,
  coverage: { scope: 'demo' },
  messages: [
    message(1700000300, 'third'),
    message(1700000100, 'first'),
    message(1700000200, 'second'),
  ],
});

describe('collected message range', () => {
  test('records the oldest and newest collected messages from their row identities', () => {
    expect(withMessageRange(compact()).coverage.range).toEqual({
      oldestTimestamp: 1700000100,
      newestTimestamp: 1700000300,
      oldest: 'first',
      newest: 'third',
    });
  });

  test('is omitted when it cannot be established', () => {
    expect(withMessageRange(compact('search')).coverage.range).toBeUndefined();
    expect(
      withMessageRange({ ...compact(), messages: [{ id: 'other' }] }).coverage.range
    ).toBeUndefined();
    expect(withMessageRange({ ...compact(), messages: [] }).coverage.range).toBeUndefined();
  });
});

describe('since boundary', () => {
  test('keeps messages on or after the start and says the start was reached', () => {
    const result = applySince(compact(), { requested: 'demo', epoch: 1700000200 });
    expect(result.messages.map((entry) => entry.displayedTime)).toEqual(['third', 'second']);
    expect(result.coverage.since).toEqual({
      requested: 'demo',
      epoch: 1700000200,
      observedCount: 3,
      matchedCount: 2,
      reached: true,
    });
  });

  test('says when the collection stopped short of the start', () => {
    const result = applySince(compact(), { requested: 'demo', epoch: 1700000050 });
    expect(result.messages).toHaveLength(3);
    expect(result.coverage.since.reached).toBe(false);
  });

  test('refuses malformed boundaries, records and operations', () => {
    expect(() => applySince(compact(), { requested: 'demo', epoch: 1.5 })).toThrow();
    expect(() => applySince(compact('search'), { requested: 'demo', epoch: 1700000000 })).toThrow();
    expect(() =>
      applySince({ ...compact(), messages: [{ id: 'other' }] }, { requested: 'd', epoch: 17e8 })
    ).toThrow();
    const source = compact();
    expect(applySince(source, undefined)).toBe(source);
  });

  test('--since takes a date or ISO date-time and pages back up to ten pages', () => {
    const parsed = parseCLI(['read-channel', 'demo', '--since=2026-01-31T09:00:00Z']);
    expect(parsed.since).toEqual({ requested: '2026-01-31T09:00:00Z', epoch: 1769850000 });
    expect(parsed.pages).toBe(10);
    expect(parseCLI(['read-dm', '@alex', '--since=2026-01-31', '--pages=3']).pages).toBe(3);
    expect(parseCLI(['read-dm', '@alex', '--since=2026-01-31']).since.epoch).toBe(
      Math.floor(new Date('2026-01-31T00:00:00').getTime() / 1000)
    );
    for (const argv of [
      ['search', 'terms', '--since=2026-01-31'],
      ['read-thread', 'CDEMO:1700000000.000001', '--since=2026-01-31'],
      ['read-channel', 'demo', '--since=yesterday'],
      ['read-channel', 'demo', '--since=2026-13-45'],
      ['read-channel', 'demo', '--since=2026-01-31', '--since=2026-02-01'],
      ['read-channel', 'demo', '--since=2026-01-31', '--after=CDEMO:1700000000.000001'],
    ])
      expect(() => parseCLI(argv)).toThrow();
  });
});
