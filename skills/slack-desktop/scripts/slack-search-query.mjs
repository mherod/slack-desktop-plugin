import { isDeepStrictEqual } from 'node:util';
import emojiMap from '../references/emoji-map.json' with { type: 'json' };

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const emojiComponent =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u20E3]/u;
const controls = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const codepoints = (text) =>
  Array.from(text, (point) =>
    point.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  ).join('-');
const unsupported = () =>
  new Error(
    'Unsupported emoji sequence in search query; use an explicitly known Slack shortcode or revise the query. No search was submitted.'
  );
const unsupportedFilter = () =>
  new Error(
    'Emoji attached to this search filter is unsupported. Only has:EMOJI with one complete emoji operand is verified; use an explicitly known query instead. No search was submitted.'
  );

function quotedAt(query, index) {
  let quote = null;
  for (let position = 0; position < index; position++) {
    const character = query[position];
    if (character === '\\') position++;
    else if (quote === character) quote = null;
    else if (quote === null && (character === '"' || character === "'")) quote = character;
  }
  return quote !== null;
}

export function normalizeSearchQuery(query) {
  if (typeof query !== 'string') throw new Error('Search query must be a string');
  if (!emojiComponent.test(query)) return null;
  const segments = [];
  for (const { segment, index } of segmenter.segment(query)) {
    if (segments.length === 500)
      throw new Error('Emoji search query exceeds 500 characters; no search was submitted');
    const shortcode = emojiMap[codepoints(segment)] ?? null;
    if (!shortcode && emojiComponent.test(segment)) throw unsupported();
    segments.push({ segment, index, shortcode, hasOperand: false });
  }
  const emoji = segments.filter((segment) => segment.shortcode !== null);
  if (emoji.length === 0) return null;
  if (segments.some(({ segment, shortcode }) => !shortcode && controls.test(segment)))
    throw new Error(
      'Emoji search query contains unsupported control characters; no search was submitted'
    );

  const tokens = Array.from(query.matchAll(/\S+/gu));
  // Quoted or whitespace-separated filter operands must not evade token checks.
  const filterRanges = Array.from(
    query.matchAll(
      /(?:^|\s)-?[A-Za-z][A-Za-z0-9_-]*:(?:"(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|\s+\S+|[^\s]*)/gu
    )
  );
  for (const current of emoji) {
    const token = tokens.find(
      (match) => current.index >= match.index && current.index < match.index + match[0].length
    );
    const enclosingFilter = filterRanges.find(
      (match) => current.index >= match.index && current.index < match.index + match[0].length
    );
    const exactHas =
      token?.[0] === `has:${current.segment}` &&
      !quotedAt(query, token.index) &&
      (!enclosingFilter || enclosingFilter[0].trimStart() === token[0]);
    const unknownColon = token?.[0].replace(/:[A-Za-z0-9_+\-]+:/g, '').includes(':');
    if ((enclosingFilter || unknownColon) && !exactHas) throw unsupportedFilter();
    current.hasOperand = exactHas;
  }

  let submittedQuery = '';
  for (const [index, current] of segments.entries()) {
    const previous = segments[index - 1];
    if (
      previous &&
      (previous.shortcode || current.shortcode) &&
      !current.hasOperand &&
      !/\s$/u.test(previous.segment) &&
      !/^\s/u.test(current.segment)
    )
      submittedQuery += ' ';
    submittedQuery += current.shortcode ?? current.segment;
  }
  let count = 0;
  for (const _ of segmenter.segment(submittedQuery)) {
    if (++count > 500)
      throw new Error(
        'Translated emoji search query exceeds 500 characters; no search was submitted'
      );
  }
  return {
    requestedQuery: query,
    submittedQuery,
    substitutions: emoji.map(({ segment, shortcode }) => ({ unicode: segment, shortcode })),
  };
}

// Translation is query metadata, never an override of native source/scope proof.
export function validateSearchQueryTranslation(receipt, requested) {
  const expected = normalizeSearchQuery(requested);
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    (expected === null
      ? Object.hasOwn(receipt, 'searchTranslation')
      : !isDeepStrictEqual(receipt.searchTranslation, expected))
  )
    throw new Error('Search query translation differs from the requested query');
  return receipt;
}
