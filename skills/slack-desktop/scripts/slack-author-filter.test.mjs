import { describe, expect, test } from 'bun:test';
import { applyAuthorFilter } from './slack-output.mjs';
import { parseCLI } from './slack-format.mjs';

// Synthetic identities only.
const compact = (operation = 'read-channel') => ({
  operation,
  coverage: { scope: 'demo' },
  messages: [
    { author: 'Alex Example', text: 'one' },
    { author: 'helperbot', text: 'two' },
    { author: null, text: 'three' },
    { author: 'HelperBot', text: 'four' },
  ],
});

describe('author filter', () => {
  test('keeps messages whose observed author contains the text, ignoring case', () => {
    const result = applyAuthorFilter(compact(), 'helperbot');
    expect(result.messages.map((message) => message.text)).toEqual(['two', 'four']);
    expect(result.coverage).toMatchObject({
      scope: 'demo',
      authorMatch: { query: 'helperbot', field: 'author', observedCount: 4, matchedCount: 2 },
    });
  });

  test('reports how many messages were scanned when nothing matches', () => {
    const result = applyAuthorFilter(compact('search'), 'nobody');
    expect(result.messages).toEqual([]);
    expect(result.coverage.authorMatch).toMatchObject({ observedCount: 4, matchedCount: 0 });
  });

  test('an absent filter leaves the result untouched', () => {
    const source = compact();
    expect(applyAuthorFilter(source, undefined)).toBe(source);
  });

  test('refuses malformed filters, records and operations', () => {
    expect(() => applyAuthorFilter(compact(), ' ')).toThrow();
    expect(() => applyAuthorFilter(compact(), 'a\u0000b')).toThrow();
    expect(() => applyAuthorFilter(compact('read-thread'), 'alex')).toThrow();
    expect(() => applyAuthorFilter({ operation: 'search', messages: null }, 'alex')).toThrow();
    expect(() =>
      applyAuthorFilter({ operation: 'search', messages: [{ author: 7 }] }, 'alex')
    ).toThrow();
  });

  test('--from applies to message reads and search, and scans five pages by default', () => {
    expect(parseCLI(['read-channel', 'demo', '--from=alex'])).toMatchObject({
      authorFilter: 'alex',
      pages: 5,
    });
    expect(parseCLI(['search', 'terms', '--from=alex', '--pages=2'])).toMatchObject({
      authorFilter: 'alex',
      pages: 2,
    });
    expect(parseCLI(['read-dm', '@alex', '--from=alex']).authorFilter).toBe('alex');
    expect(parseCLI(['read-channel', 'demo']).authorFilter).toBeUndefined();
    for (const argv of [
      ['read-thread', 'CDEMO:1700000000.000001', '--from=alex'],
      ['channels', '--from=alex'],
      ['read-channel', 'demo', '--from='],
      ['read-channel', 'demo', '--from=a', '--from=b'],
    ])
      expect(() => parseCLI(argv)).toThrow();
  });
});
