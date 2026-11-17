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

// members sets its own collection budget unless --max-seconds overrides it.
export function membersMaxSeconds({ args, maxSeconds, pages }) {
  return args[0] === 'members' ? (maxSeconds ?? (pages === undefined ? 160 : 70)) : undefined;
}

/**
 * The native helper's argument list for one parsed command: the command and
 * its native flags, then the --interaction and --workspace prefixes. Pure, so
 * tests can check every list the wrapper emits against the native parser.
 */
export function nativeCommandArgs({
  args,
  page,
  pages,
  maxSeconds,
  since,
  dmSearch,
  allowClipboard,
  textTranslation,
  confirmDelete,
  ui,
  interaction,
  workspaceTarget,
}) {
  const nativeArgs = page
    ? [...args, `${page.direction === 'older' ? '--before' : '--after'}=${page.cursor}`]
    : [...args];
  if (pages !== undefined) nativeArgs.push(`--pages=${pages}`);
  const membersSeconds = membersMaxSeconds({ args, maxSeconds, pages });
  if (membersSeconds !== undefined) nativeArgs.push(`--max-seconds=${membersSeconds}`);
  if (since !== undefined && pages > 1) nativeArgs.push(`--since=${since.epoch}`);
  if (dmSearch !== undefined) nativeArgs.push(`--search=${dmSearch}`);
  if (allowClipboard) nativeArgs.push('--allow-clipboard');
  if (textTranslation) nativeArgs.push(`--text=${textTranslation.submittedText}`);
  if (confirmDelete) nativeArgs.push('--confirm-delete');
  if (ui) {
    nativeArgs.push('--ui', `--filter=${ui.filter}`, `--limit=${ui.limit}`, `--depth=${ui.depth}`);
    if (ui.prepare) nativeArgs.push('--prepare');
  }
  // Select and pin the requested workspace in the same native process as the
  // command. Never spawn a separate switch followed by an unbound read.
  const commandArgs = nativeInteractionArgs(nativeArgs, interaction);
  if (workspaceTarget !== undefined)
    commandArgs.splice(interaction === 'foreground' ? 1 : 0, 0, `--workspace=${workspaceTarget}`);
  return commandArgs;
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
