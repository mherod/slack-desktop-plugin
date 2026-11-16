// Slack adds # to named-channel pills in the picker and removes it in results.
// Preserve quoted text, escapes, whitespace and every other filter exactly.
export function canonicalChannelSearch(query) {
  let result = '',
    token = '',
    quote = null,
    escaped = false;
  const flush = () => {
    result += /^in:#[A-Za-z0-9_-]+$/.test(token) ? `in:${token.slice(4)}` : token;
    token = '';
  };
  for (const character of query) {
    if (/\s/u.test(character) && quote === null && !escaped) {
      flush();
      result += character;
      continue;
    }
    token += character;
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (quote === character) quote = null;
    else if (quote === null && (character === '"' || character === "'")) quote = character;
  }
  flush();
  return result;
}
