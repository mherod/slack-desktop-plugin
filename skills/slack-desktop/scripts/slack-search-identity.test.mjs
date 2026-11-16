import { expect, test } from 'bun:test';
import { canonicalChannelSearch } from './slack-search-identity.mjs';

test('only whole unquoted named-channel operands normalize', () => {
  for (const [input, expected] of [
    ['in:#general after:2026-11-08', 'in:general after:2026-11-08'],
    ['Search for: in:#team-updates', 'Search for: in:team-updates'],
    ['in:#a  in:#b\ttext', 'in:a  in:b\ttext'],
    ['"in:#general"', '"in:#general"'],
    ["'in:#general'", "'in:#general'"],
    ['"text in:#general" in:#other', '"text in:#general" in:other'],
    ['in:#general,', 'in:#general,'],
    ['-in:#general', '-in:#general'],
    ['from:#general', 'from:#general'],
    ['in:##general', 'in:##general'],
    ['in:#general, in channel', 'in:#general, in channel'],
    ['in:#general — Search', 'in:general — Search'],
    ['\\in:#general', '\\in:#general'],
    ['"unfinished in:#general', '"unfinished in:#general'],
  ])
    expect(canonicalChannelSearch(input)).toBe(expected);
  expect(canonicalChannelSearch('in:#other')).not.toBe(canonicalChannelSearch('in:general'));
  expect(canonicalChannelSearch('in:#general after:2026-11-09')).not.toBe(
    canonicalChannelSearch('in:general after:2026-11-08')
  );
});
