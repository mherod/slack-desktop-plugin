// A canonical observed file page supplies a file identity, never a file-owner
// team or an inferred Download URL. Keep this independent of UI and I/O.
export function parseFilePageURL(value, contextId) {
  const match =
    typeof value === 'string' && value.length <= 32768
      ? value.match(
          /^https:\/\/(?:[a-z0-9-]+\.)*slack\.com\/files\/U[A-Z0-9]+\/(F[A-Z0-9]+)\/([A-Za-z0-9._~!$&'()*+,;=:@%-]+)(?:\?([^#]*))?$/
        )
      : null;
  let basename;
  try {
    if (match) basename = decodeURIComponent(match[2]);
  } catch {
    // Invalid escaping cannot establish source identity.
  }
  if (
    !/^[TE][A-Z0-9]{1,63}$/.test(contextId ?? '') ||
    !match ||
    match[1].length > 64 ||
    !basename ||
    ['.', '..'].includes(basename) ||
    /[\/\\\x00-\x1f\x7f-\x9f]/.test(basename) ||
    (match[3] !== undefined && match[3] !== `origin_team=${contextId}`)
  )
    throw new Error('File page must be an exact canonical observed Slack file URL');
  return { fileId: match[1], filePageURL: value, basename };
}
