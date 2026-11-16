import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeSearchQuery, validateSearchQueryTranslation } from './slack-search-query.mjs';
import {
  generateEmojiMap,
  EMOJI_DATA_REVISION,
  EMOJI_DATA_SHA256,
} from './generate-slack-emoji-map.mjs';
import emojiMap from '../references/emoji-map.json' with { type: 'json' };
import provenance from '../references/emoji-data-provenance.json' with { type: 'json' };

test.each([
  '',
  'plain text',
  'in:general from:example :custom_emoji:',
  '123 # *',
  'literal\nquery',
  'plain\u200btext',
  ':slightly_smiling_face:',
])('non-emoji query retains legacy handling: %j', (query) => {
  expect(normalizeSearchQuery(query)).toBeNull();
});

test.each([
  ['😀', ':grinning:'],
  ['🙂', ':slightly_smiling_face:'],
  ['x😀y', 'x :grinning: y'],
  ['😀😀', ':grinning: :grinning:'],
  ['"😀"', '" :grinning: "'],
  ["'😀'", "' :grinning: '"],
  [' 😀 ', ' :grinning: '],
  ['hello\u00a0😀\u2003world', 'hello\u00a0:grinning:\u2003world'],
  ['in:general before:2026-01-01 😀', 'in:general before:2026-01-01 :grinning:'],
  [':custom_emoji:😀:grinning:', ':custom_emoji: :grinning: :grinning:'],
  ['has:😀', 'has::grinning:'],
  ['has:😀 in:general', 'has::grinning: in:general'],
  ['in:"some room" has:😀', 'in:"some room" has::grinning:'],
  ['"done" has:😀', '"done" has::grinning:'],
  ['"done' + '\\'.repeat(2) + '" has:😀', '"done' + '\\'.repeat(2) + '" has::grinning:'],
  ['in:"some' + '\\'.repeat(2) + '" 😀', 'in:"some' + '\\'.repeat(2) + '" :grinning:'],
  ['find has:👍🏽', 'find has::+1::skin-tone-4:'],
  ['👍🏽', ':+1::skin-tone-4:'],
  ['👩🏽‍💻', ':female-technologist::skin-tone-4:'],
  ['👨‍👩‍👧‍👦', ':man-woman-girl-boy:'],
  ['❤️', ':heart:'],
  ['❤', ':heart:'],
  ['1️⃣', ':one:'],
  ['1⃣', ':one:'],
  ['🇬🇧', ':gb:'],
  ['🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}', ':flag-england:'],
])('whole emoji translation: %s', (requestedQuery, submittedQuery) => {
  const result = normalizeSearchQuery(requestedQuery);
  expect(result.requestedQuery).toBe(requestedQuery);
  expect(result.submittedQuery).toBe(submittedQuery);
  expect(result.substitutions.length).toBeGreaterThan(0);
});

test('substitutions preserve occurrence order and exact source variation sequences', () => {
  expect(normalizeSearchQuery('❤️ ❤ 😀😀').substitutions).toEqual([
    { unicode: '❤️', shortcode: ':heart:' },
    { unicode: '❤', shortcode: ':heart:' },
    { unicode: '😀', shortcode: ':grinning:' },
    { unicode: '😀', shortcode: ':grinning:' },
  ]);
});

test.each([
  '😀🏽',
  '😀‍😀',
  '😀\u0301',
  '❤\ufe0e',
  '😀\ufe0f\ufe0f',
  '🇬',
  '👩🏻‍❤️‍👩🏿',
  '👩🏽‍🤝‍👨🏻',
  '1\ufe0f',
  'a\u20e3',
  '\ufe0f',
])('unknown whole grapheme cannot be partially converted: %s', (query) => {
  expect(() => normalizeSearchQuery(query)).toThrow('Unsupported emoji sequence');
  expect(() => normalizeSearchQuery(`😀 ${query}`)).toThrow('Unsupported emoji sequence');
});

test.each([
  'in:😀',
  'from:person😀',
  'has:😀x',
  '-has:😀',
  'HAS:😀',
  'has:😀😀',
  'has:"😀"',
  '"has:😀"',
  'has: 😀',
  'in:"some 😀"',
  'in:"a has:😀 b"',
  "from:'a has:😀 b'",
  'has: has:😀',
  '"hello has:😀 world"',
  "'hello has:😀 world'",
  '"some \\" has:😀 world"',
  '"some' + '\\'.repeat(3) + '" has:😀 world"',
  'in:"some \\" escaped 😀"',
  "from:'some \\' escaped 😀'",
  'in:"some' + '\\'.repeat(3) + '" escaped 😀"',
  "from:'some 😀'",
  'https://example.test/😀',
  '😀:value',
  '(has:😀)',
  'has:😀,',
])('unverified filter attachment is refused: %s', (query) => {
  expect(() => normalizeSearchQuery(query)).toThrow('search filter is unsupported');
});

test.each([
  '\n',
  '\t',
  '\0',
  '\u007f',
  '\u0085',
  '\u200b',
  '\u200d',
  '\u202e',
  '\u2066',
  '\ud800',
  '\udfff',
])('unmapped controls cannot accompany emoji: %j', (control) => {
  expect(() => normalizeSearchQuery(`text${control} 😀`)).toThrow('control characters');
  expect(normalizeSearchQuery(`text${control}`)).toBeNull();
});

test('source and translated limits are checked before native work', () => {
  expect(() => normalizeSearchQuery(' '.repeat(50000) + '😀')).toThrow('exceeds 500');
  expect(() => normalizeSearchQuery('😀' + ' '.repeat(500))).toThrow('exceeds 500');
  expect(() => normalizeSearchQuery('x'.repeat(490) + '😀')).toThrow(
    'Translated emoji search query exceeds 500'
  );
  expect(normalizeSearchQuery('x'.repeat(489) + '😀').submittedQuery.length).toBe(500);
  expect(normalizeSearchQuery('x'.repeat(50000))).toBeNull();
  expect(normalizeSearchQuery(' '.repeat(50000))).toBeNull();
});

test('receipt validation binds exact translation and returns the original receipt', () => {
  const requested = '😀😀';
  const receipt = { status: 'stopped', searchTranslation: normalizeSearchQuery(requested) };
  expect(validateSearchQueryTranslation(receipt, requested)).toBe(receipt);
  for (const mutate of [
    (r) => {
      delete r.searchTranslation;
    },
    (r) => {
      r.searchTranslation.requestedQuery = '😀';
    },
    (r) => {
      r.searchTranslation.submittedQuery = ':grinning:';
    },
    (r) => {
      r.searchTranslation.substitutions.pop();
    },
    (r) => {
      r.searchTranslation.substitutions[0].unicode = '🙂';
    },
    (r) => {
      r.searchTranslation.substitutions[0].shortcode = ':smile:';
    },
    (r) => {
      r.searchTranslation.substitutions[0].extra = true;
    },
    (r) => {
      r.searchTranslation.extra = true;
    },
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed);
    expect(() => validateSearchQueryTranslation(changed, requested)).toThrow('differs');
  }
  expect(validateSearchQueryTranslation({ status: 'ok' }, ':grinning:')).toEqual({ status: 'ok' });
  expect(() => validateSearchQueryTranslation({ searchTranslation: null }, 'plain')).toThrow(
    'differs'
  );
  expect(() => validateSearchQueryTranslation(receipt, 'plain')).toThrow('differs');
});

test('committed map is pinned, minimal and has no partial grapheme entries', async () => {
  const bytes = await readFile(new URL('../references/emoji-map.json', import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.mapSHA256);
  expect(Object.keys(emojiMap)).toHaveLength(provenance.mapEntries);
  expect(provenance.revision).toBe(EMOJI_DATA_REVISION);
  expect(provenance.sourceSHA256).toBe(EMOJI_DATA_SHA256);
  expect(provenance.excludedMultiModifierVariants).toBe(295);
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const [points, shortcode] of Object.entries(emojiMap)) {
    const text = String.fromCodePoint(...points.split('-').map((point) => parseInt(point, 16)));
    if (
      [...segmenter.segment(text)].length !== 1 ||
      !/^:[a-z0-9_+-]+:(?::skin-tone-[2-6]:)?$/.test(shortcode)
    )
      throw new Error(`Invalid committed mapping: ${points}`);
  }
  expect(() => generateEmojiMap(Buffer.from('[]'))).toThrow('pinned upstream SHA-256');
  expect(
    await readFile(new URL('../references/emoji-data-LICENSE.txt', import.meta.url), 'utf8')
  ).toContain('Copyright (c) 2013 Cal Henderson');
});
