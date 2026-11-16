// Explicit interaction selection. Never replay a failed command in another mode.
const foregroundCommands = new Set([
  'channels',
  'dms',
  'channel',
  'search',
  'read-channel',
  'read-dm',
  'read-thread',
  'read-transcript',
  'save-media',
  'switch-workspace',
]);

export function nativeInteractionArgs(args, mode = 'background') {
  if (!['background', 'foreground'].includes(mode))
    throw new Error('Interaction must be background or foreground');
  if (mode === 'background') return [...args];
  if (!foregroundCommands.has(args[0]))
    throw new Error('Foreground interaction requires a navigation, transcript or save command');
  // Prefix the native mode so a literal flag-like query keeps its position.
  return ['--interaction=foreground', ...args];
}

export function foregroundEvidence(receipt) {
  // Protocol cancellation may retain only the last preflight, rather than a
  // final native result. Preserve that evidence without inventing completion.
  const frames = [
    receipt,
    receipt?.nativeResult,
    receipt?.started,
    receipt?.viewerPreflight,
    receipt?.sourcePreflight,
    receipt?.preflight,
  ];
  return (
    frames.find((frame) => frame?.interaction?.mode === 'foreground')?.interaction ?? {
      mode: 'foreground',
      state: 'unknown',
      activationRequested: null,
      activated: null,
      focusRestoration: 'none',
    }
  );
}
