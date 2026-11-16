#!/usr/bin/env bun
// Offline generator: supply the exact pinned upstream emoji-data.json, never a URL.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export const EMOJI_DATA_REVISION = '2771d0b1b3af25c069086e68e38f901c3dda8bdf';
export const EMOJI_DATA_SHA256 = '1d602e65be88772bf8cc368ce16b855d719eeddbafe128d471b80203f494d29f';
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function generateEmojiMap(bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== EMOJI_DATA_SHA256)
    throw new Error('Emoji data does not match the pinned upstream SHA-256');
  const records = JSON.parse(bytes.toString('utf8'));
  const map = new Map();
  const tones = new Map(
    records
      .filter((record) => /^1F3F[B-F]$/.test(record.unified))
      .map((record) => [record.unified, record.short_name])
  );
  let excludedMultiModifierVariants = 0;
  const add = (points, shortcode) => {
    if (points === null || points === undefined) return;
    if (!/^[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})*$/.test(points))
      throw new Error('Invalid upstream Unicode sequence');
    const unicode = String.fromCodePoint(...points.split('-').map((point) => parseInt(point, 16)));
    const segments = [...segmenter.segment(unicode)];
    if (segments.length !== 1 || segments[0].segment !== unicode)
      throw new Error('Upstream entry is not one complete grapheme');
    if (map.has(points) && map.get(points) !== shortcode)
      throw new Error('Conflicting upstream emoji identity');
    map.set(points, shortcode);
  };
  for (const record of records) {
    if (!/^[a-z0-9_+-]+$/.test(record.short_name))
      throw new Error('Invalid upstream canonical shortcode');
    const shortcode = `:${record.short_name}:`;
    add(record.unified, shortcode);
    add(record.non_qualified, shortcode);
    for (const [tone, variant] of Object.entries(record.skin_variations ?? {})) {
      // js-emoji's verified colon encoding appends one canonical modifier shortcode.
      // No multi-modifier spelling is inferred from unverified combinations.
      if (!tones.has(tone)) {
        excludedMultiModifierVariants++;
        continue;
      }
      const modified = `${shortcode}:${tones.get(tone)}:`;
      add(variant.unified, modified);
      add(variant.non_qualified, modified);
    }
  }
  const entries = [...map].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const text = JSON.stringify(Object.fromEntries(entries), null, 2) + '\n';
  return { text, entries: map.size, records: records.length, excludedMultiModifierVariants };
}

if (import.meta.main) {
  const [source, option, ...extra] = process.argv.slice(2);
  if (!source || (option !== undefined && option !== '--check') || extra.length)
    throw new Error(
      'Usage: bun generate-slack-emoji-map.mjs PATH_TO_PINNED_EMOJI_DATA_JSON [--check]'
    );
  const generated = generateEmojiMap(await readFile(source));
  const output = new URL('../references/emoji-map.json', import.meta.url);
  if (option === '--check') {
    if ((await readFile(output, 'utf8')) !== generated.text)
      throw new Error('Generated emoji map differs from the pinned data');
  } else await writeFile(output, generated.text);
  console.log(
    JSON.stringify({
      entries: generated.entries,
      records: generated.records,
      excludedMultiModifierVariants: generated.excludedMultiModifierVariants,
      sha256: createHash('sha256').update(generated.text).digest('hex'),
    })
  );
}
