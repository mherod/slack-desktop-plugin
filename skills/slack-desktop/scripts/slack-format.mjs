// Pure CLI parsing and output rendering. Plain text treats all UI strings as untrusted.

import { parseMediaReference } from './slack-read-media.mjs';
import { renderMembers } from './slack-members.mjs';
import { directoryOperations, renderDirectory } from './slack-directory.mjs';
import { compactUIObservation, formatUIObservation } from './slack-ui.mjs';
import {
  COMPOSE_OPERATIONS,
  normalizeMessageText,
  renderCompose,
  validMessageReference,
  validSendDestination,
} from './slack-compose.mjs';

const formats = new Set(['text', 'json', 'full-json']);
const passThroughFlags = new Set(['--help', '--request']);
const semanticKeys = new Set([
  'schemaVersion',
  'operation',
  'requested',
  'observedAt',
  'workspace',
  'workspaces',
  'switch',
  'workspaceSwitchMayHaveBeenRequested',
  'workspaceSelection',
  'requestedWorkspace',
  'conversation',
  'channels',
  'dms',
  'messages',
  'media',
  'transcript',
  'openingMayHaveBeenRequested',
  'saved',
  'downloadMayHaveStarted',
  'sourceMayHaveReopened',
  'source',
  'viewerMayHaveOpened',
  'viewer',
  'sources',
  'thread',
  'search',
  'view',
  'query',
  'candidates',
  'candidateCount',
  'exactMatchCount',
  'lookup',
  'candidatesTruncated',
  'coverage',
  'pagination',
  'navigation',
  'status',
  'error',
  'next',
  'accessibilityTrusted',
  'permissionScope',
  'accessibilityProbe',
  'accessStatus',
  'postEventAccess',
  'promptRequested',
  'settingsOpenRequested',
  'executable',
  'note',
  'verification',
  'interaction',
  'searchTranslation',
  'wasOpen',
  'closed',
  'closeMayHaveBeenRequested',
  'requested',
  'channel',
  'total',
  'members',
  'dialogMayBeOpen',
  'people',
  'timestamp',
  'ref',
  'permalink',
  'placeholder',
  'composer',
  'actionMayHaveOccurred',
  'recovery',
  'textTranslation',
]);
const diagnosticKeys = new Set([
  'nodes',
  'content',
  'desktop',
  'desktopSamples',
  'samples',
  'pid',
  'foregroundPid',
  'foregroundBefore',
  'foregroundAfter',
  'cursorBefore',
  'cursorAfter',
]);
const workspaceScopedCommands = new Set([
  'channels',
  'dms',
  'search',
  'channel',
  'read-channel',
  'read-dm',
  'read-thread',
  'read-media',
  'read-transcript',
  'save-media',
  'members',
  'browse-channels',
  'browse-people',
  'send',
  'edit',
  'delete',
]);

function validWorkspaceTarget(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.trim() === value &&
    Array.from(value).length <= 200 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  );
}

function usageError(message) {
  const error = new Error(
    `${message}. Use --format=text, --format=json, or --format=full-json; put literal flag-like arguments after --.`
  );
  error.exitCode = 2;
  return error;
}

function groupReference(value) {
  return typeof value === 'string' && /^group:[CG][A-Z0-9]+$/.test(value) && !/[\r\n]/.test(value)
    ? value
    : null;
}

export function parseCLI(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string'))
    throw usageError('Arguments must be strings');
  const args = [];
  let page, pages, lockTimeout, dmSearch, allowClipboard, output, workspaceTarget, authorFilter;
  let since, maxSeconds, text;
  let confirmDelete = false;
  let interaction = 'background',
    interactionSeen = false;
  let originalRequired = false;
  const uiOptions = {};
  const uiSeen = new Set();
  let format = 'text',
    formatSeen = false,
    literal = false;
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (literal) {
        args.push(argument);
        continue;
      }
      if (argument === '--') {
        literal = true;
        continue;
      }
      if (argument.startsWith('--workspace=')) {
        if (workspaceTarget !== undefined) throw usageError('Specify --workspace only once');
        workspaceTarget = argument.slice('--workspace='.length);
        if (!validWorkspaceTarget(workspaceTarget))
          throw usageError(
            '--workspace requires one exact workspace name, workspace:DOMAIN reference or current context ID, 1–200 Unicode characters without controls or surrounding whitespace'
          );
        continue;
      }
      if (argument === '--interaction' || argument.startsWith('--interaction=')) {
        if (interactionSeen) throw usageError('Specify --interaction only once');
        const requested =
          argument === '--interaction' ? argv[++index] : argument.slice('--interaction='.length);
        if (!['background', 'foreground'].includes(requested))
          throw usageError('--interaction must be background or foreground');
        interaction = requested;
        interactionSeen = true;
        continue;
      }
      if (argument === '--original') {
        if (originalRequired) throw usageError('Specify --original only once');
        originalRequired = true;
        continue;
      }
      if (argument.startsWith('--output=')) {
        if (output !== undefined) throw usageError('Specify --output only once');
        output = argument.slice('--output='.length);
        if (
          !output.trim() ||
          Buffer.byteLength(output) > 4096 ||
          /[\x00-\x1f\x7f-\x9f]/.test(output)
        )
          throw usageError('--output requires a nonempty file path without control characters');
        continue;
      }
      if (argument.startsWith('--format=')) {
        if (formatSeen) throw usageError('Specify --format only once');
        const requested = argument.slice('--format='.length);
        if (!formats.has(requested))
          throw usageError(`Unknown output format ${JSON.stringify(requested)}`);
        format = requested;
        formatSeen = true;
        continue;
      }
      if (argument.startsWith('--before=') || argument.startsWith('--after=')) {
        if (page) throw usageError('Specify only one of --before or --after');
        const [option, cursor] = argument.split('=');
        if (argument !== `${option}=${cursor}` || !threadReference(cursor))
          throw usageError('Page references must use CONVERSATION:TIMESTAMP from the output');
        page = { direction: option === '--before' ? 'older' : 'newer', cursor };
        continue;
      }
      if (argument.startsWith('--pages=')) {
        if (pages !== undefined) throw usageError('Specify --pages only once');
        const count = argument.slice('--pages='.length);
        if (!/^(?:[1-9]|10)$/.test(count))
          throw usageError('--pages must be an integer from 1 to 10');
        pages = Number(count);
        continue;
      }
      if (argument.startsWith('--max-seconds=')) {
        if (maxSeconds !== undefined) throw usageError('Specify --max-seconds only once');
        const seconds = argument.slice('--max-seconds='.length);
        if (!/^[1-9][0-9]{0,2}$/.test(seconds) || Number(seconds) > 900)
          throw usageError('--max-seconds must be an integer from 1 to 900 seconds');
        maxSeconds = Number(seconds);
        continue;
      }
      if (argument.startsWith('--lock-timeout=')) {
        if (lockTimeout !== undefined) throw usageError('Specify --lock-timeout only once');
        const seconds = argument.slice('--lock-timeout='.length);
        if (!/^(?:0|[1-9]\d?|1[01]\d|120)$/.test(seconds))
          throw usageError('--lock-timeout must be an integer from 0 to 120 seconds');
        lockTimeout = Number(seconds);
        continue;
      }
      if (argument.startsWith('--text=')) {
        if (text !== undefined) throw usageError('Specify --text only once');
        text = argument.slice('--text='.length);
        continue;
      }
      if (argument === '--confirm-delete') {
        if (confirmDelete) throw usageError('Specify --confirm-delete only once');
        confirmDelete = true;
        continue;
      }
      if (argument === '--allow-clipboard') {
        if (allowClipboard) throw usageError('Specify --allow-clipboard only once');
        allowClipboard = true;
        continue;
      }
      if (argument.startsWith('--since=')) {
        if (since !== undefined) throw usageError('Specify --since only once');
        const value = argument.slice('--since='.length);
        // A bare date means local midnight; a full ISO date-time is used as given.
        const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? new Date(`${value}T00:00:00`)
          : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
            ? new Date(value)
            : null;
        const epoch = parsed ? Math.floor(parsed.getTime() / 1000) : Number.NaN;
        if (!Number.isSafeInteger(epoch) || epoch < 1_000_000_000 || epoch > 9_999_999_999)
          throw usageError(
            '--since requires YYYY-MM-DD or an ISO date-time such as 2026-01-31T09:00'
          );
        since = { requested: value, epoch };
        continue;
      }
      if (argument.startsWith('--from=')) {
        if (authorFilter !== undefined) throw usageError('Specify --from only once');
        const value = argument.slice('--from='.length);
        if (
          value.trim() === '' ||
          Array.from(value).length > 200 ||
          /[\x00-\x1f\x7f-\x9f]/.test(value)
        )
          throw usageError('--from requires 1–200 Unicode characters without control characters');
        authorFilter = value;
        continue;
      }
      if (argument.startsWith('--search=')) {
        if (dmSearch !== undefined) throw usageError('Specify --search only once');
        const value = argument.slice('--search='.length);
        if (Array.from(value).length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(value))
          throw usageError(
            '--search accepts at most 200 Unicode characters without control characters'
          );
        if (value !== '' && value.trim() === '')
          throw usageError('--search must be empty to clear or contain non-whitespace text');
        dmSearch = value;
        continue;
      }
      const uiOption = ['--ui', '--prepare'].includes(argument)
        ? argument.slice(2)
        : /^(?:--filter=|--limit=|--depth=)/.test(argument)
          ? argument.slice(2, argument.indexOf('='))
          : null;
      if (uiOption) {
        if (uiSeen.has(uiOption)) throw usageError(`Specify --${uiOption} only once`);
        uiSeen.add(uiOption);
        const value = argument.slice(argument.indexOf('=') + 1);
        if (uiOption === 'filter') {
          if (Array.from(value).length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(value))
            throw usageError(
              '--filter accepts at most 200 Unicode characters without control characters'
            );
          uiOptions.filter = value;
        } else if (uiOption === 'limit' || uiOption === 'depth') {
          const maximum = uiOption === 'limit' ? 500 : 40;
          if (
            !/^(?:0|[1-9]\d*)$/.test(value) ||
            Number(value) > maximum ||
            (uiOption === 'limit' && Number(value) < 1)
          )
            throw usageError(
              `--${uiOption} must be an integer from ${uiOption === 'limit' ? 1 : 0} to ${maximum}`
            );
          uiOptions[uiOption] = Number(value);
        } else uiOptions[uiOption] = true;
        continue;
      }
      if (argument.startsWith('-') && !passThroughFlags.has(argument))
        throw usageError(`Unknown option ${JSON.stringify(argument)}`);
      args.push(argument);
    }
    if (
      interaction === 'foreground' &&
      ![
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
      ].includes(args[0])
    )
      throw usageError('--interaction=foreground requires a command that interacts with Slack');
    if (
      page &&
      (args.length !== 2 || !['read-channel', 'read-dm', 'read-thread'].includes(args[0]))
    )
      throw usageError('--before and --after require read-channel, read-dm, or read-thread');
    if (
      pages !== undefined &&
      !(
        (['channels', 'dms', 'browse-channels', 'browse-people'].includes(args[0]) &&
          args.length === 1) ||
        (args.length === 2 &&
          [
            'read-channel',
            'read-dm',
            'read-thread',
            'read-transcript',
            'search',
            'members',
          ].includes(args[0]))
      )
    )
      throw usageError(
        '--pages requires channels, dms, read-channel, read-dm, read-thread, read-transcript, search, or members'
      );
    if (args[0] === 'members' && args.length !== 2)
      throw usageError('members requires one exact channel name');
    if (COMPOSE_OPERATIONS.has(args[0])) {
      if (args.length !== 2)
        throw usageError(
          args[0] === 'send'
            ? 'send requires one destination: #channel, @handle, exact DM name, group:ID or thread:REF'
            : `${args[0]} requires one message reference CONVERSATION:TIMESTAMP or permalink`
        );
      if (args[0] === 'send' && !validSendDestination(args[1]))
        throw usageError(
          'send destinations are #channel, @handle, an exact DM name, group:ID or thread:REF'
        );
      if (args[0] !== 'send' && !validMessageReference(args[1]))
        throw usageError(`${args[0]} requires CONVERSATION:TIMESTAMP or a Slack message permalink`);
      if ((args[0] === 'delete') !== (text === undefined))
        throw usageError('send and edit require --text=TEXT; delete accepts no text');
      if ((args[0] === 'delete') !== confirmDelete)
        throw usageError(
          'delete requires --confirm-delete (deletion cannot be undone); only delete accepts it'
        );
      if (text !== undefined) {
        try {
          normalizeMessageText(text);
        } catch (error) {
          throw usageError(error.message);
        }
      }
    } else if (text !== undefined || confirmDelete) {
      throw usageError('--text and --confirm-delete require send, edit or delete');
    }
    if (maxSeconds !== undefined && (args[0] !== 'members' || args.length !== 2))
      throw usageError('--max-seconds requires members with one exact channel name');
    if (since !== undefined) {
      if (args.length !== 2 || !['read-channel', 'read-dm'].includes(args[0]))
        throw usageError('--since requires read-channel or read-dm');
      if (page?.direction === 'newer') throw usageError('--since cannot be combined with --after');
      // Page back until the start is reached, within the ten-page maximum.
      pages ??= 10;
    }
    if (authorFilter !== undefined) {
      if (args.length !== 2 || !['read-channel', 'read-dm', 'search'].includes(args[0]))
        throw usageError('--from requires read-channel, read-dm or search');
      // One page rarely holds a given author's messages; scan several by default.
      pages ??= 5;
    }
    if (
      [
        'channels',
        'dms',
        'workspaces',
        'current-workspace',
        'close-thread',
        'close-members',
        'browse-channels',
        'browse-people',
      ].includes(args[0]) &&
      args.length !== 1
    )
      throw usageError(`${args[0]} does not accept positional arguments`);
    if (args[0] === 'switch-workspace' && (args.length !== 2 || !validWorkspaceTarget(args[1])))
      throw usageError(
        'switch-workspace requires one exact workspace name, workspace:DOMAIN reference or current context ID, 1–200 Unicode characters without controls or surrounding whitespace'
      );
    if (workspaceTarget !== undefined && !workspaceScopedCommands.has(args[0]))
      throw usageError(
        '--workspace requires channels, dms, search, channel, read-channel, read-dm, read-thread, read-media, read-transcript, save-media, members, browse-channels or browse-people'
      );
    if (['read-media', 'read-transcript', 'save-media'].includes(args[0])) {
      if (args.length !== 2) throw usageError(`${args[0]} requires one attachment reference`);
      try {
        parseMediaReference(args[1]);
      } catch (error) {
        throw usageError(error.message);
      }
    }
    if (args[0] === 'save-media' && output === undefined)
      throw usageError('save-media requires --output=PATH for the destination file');
    if (output !== undefined && args[0] !== 'save-media')
      throw usageError('--output requires save-media');
    if (originalRequired && args[0] !== 'save-media')
      throw usageError('--original requires save-media');
    if (args[0] === 'read-dm' && args[1]?.startsWith('group:') && !groupReference(args[1]))
      throw usageError('Group DM references must use group:CONVERSATION from dms output');
    const groupName =
      args[0] === 'read-dm' && args[1]?.startsWith('group-name:')
        ? args[1].slice('group-name:'.length)
        : undefined;
    if (
      groupName !== undefined &&
      (!groupName.trim() ||
        Array.from(groupName).length > 200 ||
        /[\x00-\x1f\x7f-\x9f]/.test(groupName))
    )
      throw usageError('Group names require 1–200 Unicode characters without controls');
    if (dmSearch !== undefined && (args[0] !== 'dms' || args.length !== 1))
      throw usageError('--search requires dms');
    const clipboardOperation =
      (args[0] === 'dms' && dmSearch !== undefined && dmSearch !== '') ||
      (args.length === 2 && groupName !== undefined);
    if (clipboardOperation && !allowClipboard)
      throw usageError('This operation requires explicit --allow-clipboard permission');
    const clipboardFallback =
      ['read-dm', 'send'].includes(args[0]) &&
      args.length === 2 &&
      !/^(?:group:|#|thread:)/.test(args[1]);
    if (allowClipboard && !clipboardOperation && !clipboardFallback)
      throw usageError('--allow-clipboard requires nonempty dms --search or a name/handle read-dm');
    const dmFilterOnly =
      args.length === 1 && args[0] === 'dms' && uiSeen.size === 1 && uiSeen.has('filter');
    if (
      uiSeen.size &&
      !dmFilterOnly &&
      (args.length !== 1 || args[0] !== 'inspect' || !uiSeen.has('ui'))
    )
      throw usageError(
        '--filter requires dms or inspect --ui; --ui, --limit, --depth and --prepare require inspect --ui'
      );
  } catch (error) {
    error.format = format;
    throw error;
  }
  return {
    args,
    format,
    interaction,
    ...(workspaceTarget !== undefined ? { workspaceTarget } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(args[0] === 'save-media' ? { originalRequired } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(confirmDelete ? { confirmDelete } : {}),
    ...(page ? { page } : {}),
    ...(pages !== undefined ? { pages } : {}),
    ...(maxSeconds !== undefined ? { maxSeconds } : {}),
    ...(lockTimeout !== undefined ? { lockTimeout } : {}),
    ...(dmSearch !== undefined ? { dmSearch } : {}),
    ...(authorFilter !== undefined ? { authorFilter } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(allowClipboard ? { allowClipboard } : {}),
    ...(args[0] === 'dms' && uiSeen.has('filter') ? { dmFilter: uiOptions.filter } : {}),
    ...(uiSeen.has('ui')
      ? {
          ui: {
            filter: '',
            limit: 80,
            depth: 20,
            prepare: false,
            ...Object.fromEntries(Object.entries(uiOptions).filter(([key]) => key !== 'ui')),
          },
        }
      : {}),
  };
}

function plain(value) {
  if (value === null || value === undefined) return '';
  const source = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return source
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

const inline = (value) => plain(value).replace(/\s+/g, ' ').trim();
const shorten = (value, maximum) => {
  const characters = Array.from(value);
  return {
    value: characters.length > maximum ? `${characters.slice(0, maximum - 1).join('')}…` : value,
    shortened: characters.length > maximum,
  };
};
const shortInline = (value, maximum = 160) => shorten(inline(value), maximum).value;
const list = (value) => (Array.isArray(value) ? value : []);
const countLabel = (count, singular, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;
const displayName = (value) =>
  typeof value === 'object' && value !== null ? (value.name ?? value.displayName) : value;
const shellArgument = (value) =>
  /^[A-Za-z0-9_@:#./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

function sourceLink(value) {
  if (typeof value !== 'string' || plain(value) !== value || /\s/.test(value) || value.length > 512)
    return null;
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

function threadReference(value) {
  return typeof value === 'string' &&
    value.length <= 128 &&
    /^[CDG][A-Z0-9]+:\d{10}\.\d{6}$/.test(value)
    ? value
    : null;
}

function channelCommand(value, compact, navigation) {
  if (typeof value !== 'string') return null;
  const name = value.startsWith('#') ? value.slice(1) : value;
  if (!name || Array.from(name).length > 80 || !/^[\p{L}\p{N}_-]+$/u.test(name)) return null;
  return scopeCommand(
    `read-channel ${name.startsWith('-') ? '-- ' : ''}${name}`,
    compact,
    navigation
  );
}

function pageCommand(compact, direction) {
  const page = compact.pagination;
  if (
    compact.status === 'partial' ||
    page?.supported !== true ||
    (page.status === 'no-progress' && page.direction === direction)
  )
    return null;
  const entry = page[direction],
    navigation = scopedNavigation(entry?.navigation, compact),
    cursor = threadReference(entry?.cursor);
  if (
    !cursor ||
    navigation?.command !== compact.operation ||
    !['read-channel', 'read-dm', 'read-thread'].includes(navigation.command) ||
    !Array.isArray(navigation.args) ||
    navigation.args.length !== 2
  )
    return null;
  const [target, option] = navigation.args;
  if (
    typeof target !== 'string' ||
    !target ||
    target.length > 500 ||
    plain(target) !== target ||
    /[\r\n\t]/.test(target) ||
    option !== `--${direction === 'older' ? 'before' : 'after'}=${cursor}` ||
    (compact.conversation?.id && cursor.split(':')[0] !== compact.conversation.id)
  )
    return null;
  if (navigation.command === 'read-channel' && !channelCommand(target)) return null;
  if (navigation.command === 'read-dm') {
    const group = compact.conversation?.dmKind === 'group';
    if (
      group
        ? compact.conversation?.kind !== 'dm' ||
          !groupReference(target) ||
          target !== `group:${compact.conversation?.id}`
        : target.startsWith('group:') || target.startsWith('group-name:')
    )
      return null;
  }
  if (
    navigation.command === 'read-thread' &&
    (!threadReference(target) || target !== compact.thread?.ref)
  )
    return null;
  return scopeCommand(
    `${navigation.command} ${target.startsWith('-') ? `${option} -- ${shellArgument(target)}` : `${shellArgument(target)} ${option}`}`,
    compact
  );
}

function candidateCommand(candidate, compact) {
  const navigation = scopedNavigation(candidate?.navigation, compact);
  const clipboard =
    navigation?.command === 'read-dm' &&
    navigation?.args?.length === 2 &&
    navigation.args[1] === '--allow-clipboard';
  if (
    !['read-dm', 'read-channel'].includes(navigation?.command) ||
    !Array.isArray(navigation.args) ||
    (navigation.args.length !== 1 && !clipboard)
  )
    return null;
  const target = navigation.args[0];
  if (
    typeof target !== 'string' ||
    !target ||
    target.length > 500 ||
    plain(target) !== target ||
    /[\r\n\t]/.test(target) ||
    (target !== candidate.name && target !== candidate.handle) ||
    (navigation.command === 'read-dm' &&
      (target.startsWith('group:') || target.startsWith('group-name:'))) ||
    (navigation.command === 'read-channel' && !channelCommand(target))
  )
    return null;
  return scopeCommand(
    `${navigation.command} ${clipboard ? '--allow-clipboard ' : ''}${target.startsWith('-') ? '-- ' : ''}${shellArgument(target)}`,
    compact
  );
}

function groupDMCommand(dm, compact) {
  const navigation = scopedNavigation(dm?.navigation, compact);
  const reference = groupReference(`group:${dm?.id}`);
  return dm?.kind === 'group' &&
    reference &&
    navigation?.command === 'read-dm' &&
    Array.isArray(navigation.args) &&
    navigation.args.length === 1 &&
    navigation.args[0] === reference
    ? scopeCommand(`read-dm ${reference}`, compact)
    : null;
}

function paginationLines(compact) {
  if (compact.pagination?.supported !== true) return [];
  const lines = [];
  const older = pageCommand(compact, 'older'),
    newer = pageCommand(compact, 'newer');
  if (older) lines.push(`Older: ${older}`);
  if (newer)
    lines.push(`${compact.operation === 'read-thread' ? 'More replies' : 'Newer'}: ${newer}`);
  return lines;
}

function threadHint(thread, compact) {
  const reference = threadReference(thread?.ref);
  if (!reference || thread.replyCount === 0) return null;
  const count =
    Number.isSafeInteger(thread.replyCount) && thread.replyCount > 0 ? thread.replyCount : null;
  const command = scopeCommand(`read-thread ${reference}`, compact, thread?.navigation);
  return command
    ? `${count === null ? 'Thread' : `${count} ${count === 1 ? 'reply' : 'replies'}`} · ${command}`
    : null;
}

function compactJSON(compact) {
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !diagnosticKeys.has(key))
          .map(([key, child]) => [key, clean(child)])
      );
    }
    return value;
  };
  const result = clean(
    Object.fromEntries(Object.entries(compact).filter(([key]) => semanticKeys.has(key)))
  );
  const lock = compactLock(compact.lock);
  if (lock) result.lock = lock;
  const observation = safeObservation(compact.observation);
  if (observation) result.observation = observation;
  return result;
}

function safeObservation(value) {
  if (!value) return null;
  try {
    return compactUIObservation(value);
  } catch {
    return null;
  }
}

function observationLine(compact) {
  const observation = safeObservation(compact.observation);
  if (!observation) return '';
  try {
    return formatUIObservation(observation);
  } catch {
    return '';
  }
}

function compactLock(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.path !== 'string' ||
    value.path.length > 4096 ||
    !['timeout', 'cancelled', 'ownership-changed'].includes(value.reason) ||
    !Number.isSafeInteger(value.waitedMs) ||
    value.waitedMs < 0 ||
    !Number.isInteger(value.timeoutSeconds) ||
    value.timeoutSeconds < 0 ||
    value.timeoutSeconds > 120 ||
    !['known', 'legacy-or-initializing', 'invalid', 'unreadable'].includes(value.ownerStatus) ||
    !['running', 'not-running', 'unknown'].includes(value.processState) ||
    value.scope !== 'cooperating helper processes only'
  )
    return null;
  const known = value.ownerStatus === 'known';
  if (
    known
      ? !Number.isSafeInteger(value.ownerPid) ||
        value.ownerPid < 1 ||
        ![
          'inspect',
          'channels',
          'dms',
          'read-channel',
          'read-dm',
          'read-thread',
          'search',
          'channel',
          'permissions',
          'workspaces',
          'current-workspace',
          'switch-workspace',
          'close-thread',
          'close-members',
          'members',
          'browse-channels',
          'browse-people',
          'send',
          'edit',
          'delete',
        ].includes(value.operation) ||
        typeof value.acquiredAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.acquiredAt)
      : value.ownerPid !== null ||
        value.operation !== null ||
        value.acquiredAt !== null ||
        value.processState !== 'unknown'
  )
    return null;
  return Object.fromEntries(
    [
      'path',
      'reason',
      'waitedMs',
      'timeoutSeconds',
      'ownerStatus',
      'ownerPid',
      'operation',
      'acquiredAt',
      'processState',
      'scope',
    ].map((key) => [key, value[key]])
  );
}

function lockLine(compact) {
  const lock = compactLock(compact.lock);
  if (!lock) return '';
  const owner =
    lock.ownerStatus === 'known'
      ? `owner PID ${lock.ownerPid}, ${lock.operation}; PID ${lock.processState === 'not-running' ? 'not running' : lock.processState}`
      : `owner ${lock.ownerStatus}`;
  return `Lock: waited ${(lock.waitedMs / 1000).toFixed(1)}s (limit ${lock.timeoutSeconds}s); ${owner}.`;
}

function workspaceSuffix(compact) {
  if (scopedWorkspace(compact)) return '';
  const name = shortInline(displayName(compact.workspace), 100);
  return name ? ` — ${name}` : '';
}

function workspaceContext(value) {
  return typeof value === 'string' && value.match(/^[TE][A-Z0-9]{1,63}$/)?.[0] === value
    ? value
    : null;
}

function workspaceDomain(value) {
  return typeof value === 'string' &&
    value.match(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.enterprise)?\.slack\.com$/)?.[0] ===
      value
    ? value
    : null;
}

function scopedWorkspace(compact) {
  const selection = compact?.workspaceSelection;
  const workspace = selection?.workspace;
  const to = selection?.switch?.to;
  const context = workspaceContext(workspace?.contextId);
  const domain = workspaceDomain(workspace?.domain);
  const referenceValid =
    (workspace?.domain === null && workspace?.ref === null) ||
    (domain && workspace.ref === `workspace:${domain}`);
  return selection?.operation === 'switch-workspace' &&
    selection.status === 'ok' &&
    context &&
    referenceValid &&
    to?.contextId === context &&
    to?.domain === workspace.domain &&
    to?.ref === workspace.ref &&
    (!compact.workspace || compact.workspace.contextId === context) &&
    [true, false].includes(selection.switch.changed)
    ? workspace
    : null;
}

function scopeCommand(command, compact, navigation) {
  if (!command) return null;
  if (navigation && !scopedNavigation(navigation, compact)) return null;
  if (!compact?.workspaceSelection && compact?.requestedWorkspace === undefined) return command;
  const workspace = scopedWorkspace(compact);
  if (!workspace?.ref) return null;
  const separator = command.indexOf(' ');
  const operation = separator < 0 ? command : command.slice(0, separator);
  if (!workspaceScopedCommands.has(operation)) return null;
  return `${operation} --workspace=${workspace.ref}${separator < 0 ? '' : command.slice(separator)}`;
}

function scopedNavigation(navigation, compact) {
  if (!Array.isArray(navigation?.args)) return navigation;
  const flags = navigation.args.filter(
    (arg) => typeof arg === 'string' && arg.startsWith('--workspace=')
  );
  if (!flags.length) return navigation;
  const workspace = scopedWorkspace(compact);
  if (flags.length !== 1 || !workspace || flags[0] !== `--workspace=${workspace.ref}`) return null;
  return { ...navigation, args: navigation.args.filter((arg) => arg !== flags[0]) };
}

function workspaceLabel(workspace) {
  const name = shortInline(workspace?.name, 160) || '[name unavailable]';
  const context = workspaceContext(workspace?.contextId);
  const identity = [context, workspaceDomain(workspace?.domain)].filter(Boolean).join('; ');
  return identity ? `${name} (${identity})` : name;
}

function workspaceCommand(workspace) {
  const domain = workspaceDomain(workspace?.domain);
  const ref = domain ? `workspace:${domain}` : null;
  const navigation = workspace?.navigation;
  // A rail entry has no domain; its offered target is its exact unique name.
  if (
    workspace?.domain === null &&
    workspace.ref === null &&
    navigation?.command === 'switch-workspace' &&
    Array.isArray(navigation.args) &&
    navigation.args.length === 1 &&
    navigation.args[0] === workspace.name
  )
    return `switch-workspace ${workspace.name.startsWith('-') ? '-- ' : ''}${shellArgument(workspace.name)}`;
  return ref &&
    workspace?.ref === ref &&
    navigation?.command === 'switch-workspace' &&
    Array.isArray(navigation.args) &&
    navigation.args.length === 1 &&
    navigation.args[0] === ref
    ? `switch-workspace ${ref}`
    : null;
}

function workspaceRows(workspaces, maximum = 30) {
  return list(workspaces)
    .slice(0, maximum)
    .map((workspace) => {
      const command = workspaceCommand(workspace);
      return `${workspace.current === true ? '* ' : '- '}${workspaceLabel(workspace)}${workspace.current === true ? ' [current]' : ''}${command ? `\n  → ${command}` : ''}`;
    });
}

function renderWorkspaces(compact) {
  if (compact.operation === 'current-workspace')
    return `Current workspace: ${workspaceLabel(compact.workspace)}\nNext: workspaces`;
  if (compact.operation === 'switch-workspace') {
    const changed = compact.switch?.changed;
    return [
      `${changed === true ? 'Switched workspace' : changed === false ? 'Already current' : 'Current workspace'}: ${workspaceLabel(compact.workspace)}`,
      changed === true ? `From: ${workspaceLabel(compact.switch?.from)}` : '',
      'Next: channels · dms · search QUERY',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const workspaces = list(compact.workspaces);
  const lines = [
    `Workspaces: ${countLabel(workspaces.length, 'exposed workspace')}`,
    ...workspaceRows(workspaces),
  ];
  if (workspaces.length > 30)
    lines.push(
      `${workspaces.length - 30} more omitted; use --format=json for all captured workspaces.`
    );
  lines.push('Coverage: exposed workspace switcher; other workspaces may be unavailable.');
  return lines.join('\n');
}

function workspaceFailureLines(compact) {
  if (!['workspaces', 'current-workspace', 'switch-workspace'].includes(compact.operation))
    return [];
  const candidates = list(compact.candidates);
  const total =
    Number.isSafeInteger(compact.candidateCount) && compact.candidateCount >= candidates.length
      ? compact.candidateCount
      : null;
  const shown = Math.min(candidates.length, 8);
  const capped =
    compact.candidatesTruncated === true || (total !== null && total > candidates.length);
  const candidateNote = capped
    ? `Candidates: showing ${shown} of ${total ?? `at least ${candidates.length}`} observed; --format=json retains ${candidates.length}. Use --format=full-json for the full exposed inventory.`
    : candidates.length > shown
      ? `Candidates: showing ${shown} of ${candidates.length} observed; use --format=json for all ${candidates.length} returned candidates.`
      : '';
  return [
    compact.workspace ? `Current workspace: ${workspaceLabel(compact.workspace)}` : '',
    compact.workspaceSwitchMayHaveBeenRequested === true
      ? 'Workspace switching may have been requested. Inspect current-workspace before another command; do not replay it automatically.'
      : compact.workspaceSwitchMayHaveBeenRequested === false
        ? 'No workspace-switch action was attempted.'
        : '',
    ...workspaceRows(candidates, 8),
    candidateNote,
  ].filter(Boolean);
}

function coverageNotes(compact, omitBoilerplate = false) {
  const boilerplate = new Set([
    'Unexposed history, thread replies and attachment contents were not read; missing metadata remains null',
    'Unexposed replies and attachment contents were not read; missing metadata remains null',
    'Search results are snippets; full messages and thread replies were not read.',
  ]);
  if (compact.operation === 'read-thread' && compact.thread?.root === null)
    boilerplate.add('Root message is outside this view.');
  if (compact.pagination?.supported === true && compact.pagination.status === 'no-progress')
    boilerplate.add(
      'No additional messages were verified in this direction; the end of history is unknown.'
    );
  if (
    compact.operation === 'read-thread' &&
    Number.isSafeInteger(compact.thread?.displayedReplyCount) &&
    compact.thread.displayedReplyCount >= 0
  )
    boilerplate.add(
      `${list(compact.thread.replies).length} of ${compact.thread.displayedReplyCount} displayed thread replies are exposed`
    );
  const warnings = list(compact.coverage?.warnings).filter(
    (warning) =>
      typeof warning === 'string' &&
      !(
        omitBoilerplate &&
        (boilerplate.has(warning) ||
          (compact.pagination?.supported === true &&
            compact.operation === 'read-thread' &&
            /^\d+ of \d+ displayed thread replies are exposed$/.test(warning)))
      )
  );
  const lines = warnings.slice(0, 2).map((warning) => `Note: ${shortInline(warning, 220)}`);
  if (warnings.length > 2)
    lines.push(
      `${warnings.length - 2} additional coverage notes are available with --format=json.`
    );
  return lines;
}

function batchState(compact) {
  const batch = compact.pagination?.batch;
  if (batch === undefined) return null;
  if (
    compact.pagination?.supported !== true ||
    ![
      'channels',
      'dms',
      'read-channel',
      'read-dm',
      'read-thread',
      'read-transcript',
      'search',
    ].includes(compact.operation) ||
    !batch ||
    !Number.isSafeInteger(batch.requestedPages) ||
    batch.requestedPages < 2 ||
    batch.requestedPages > 10 ||
    !Number.isSafeInteger(batch.completedPages) ||
    batch.completedPages < 1 ||
    batch.completedPages > batch.requestedPages ||
    !Number.isSafeInteger(batch.attemptedPages) ||
    batch.attemptedPages < batch.completedPages ||
    batch.attemptedPages > batch.requestedPages ||
    !(
      compact.operation === 'search'
        ? ['next']
        : ['channels', 'dms', 'read-transcript'].includes(compact.operation)
          ? ['down']
          : ['older', 'newer']
    ).includes(batch.direction) ||
    !(
      compact.operation === 'read-transcript'
        ? ['page-limit', 'no-progress', 'error', 'time-limit']
        : ['page-limit', 'no-progress', 'no-next-page', 'since-reached', 'error', 'time-limit']
    ).includes(batch.stopReason) ||
    !Number.isSafeInteger(batch.deduplicatedCount) ||
    batch.deduplicatedCount < 0
  )
    throw new Error('Multi-page summary is invalid');
  if (compact.operation === 'read-transcript') {
    const pagination = compact.pagination;
    if (
      pagination.direction !== 'down' ||
      pagination.hasMore !== null ||
      !Number.isSafeInteger(pagination.capturedCount) ||
      pagination.capturedCount < 0 ||
      !Number.isSafeInteger(pagination.returnedCount) ||
      pagination.returnedCount < 0 ||
      !Number.isSafeInteger(pagination.scrollAttempts) ||
      pagination.scrollAttempts < 0 ||
      pagination.capturedCount - pagination.returnedCount !== batch.deduplicatedCount ||
      pagination.returnedCount !== list(compact.transcript?.segments).length ||
      compact.coverage?.segmentCount !== pagination.returnedCount ||
      compact.coverage?.complete !== false
    )
      throw new Error('Multi-page summary is invalid');
  }
  return batch;
}

function coverageLines(compact, kind) {
  const paginated = compact.pagination?.supported === true;
  const batch = batchState(compact);
  const listing = ['channels', 'dms'].includes(kind);
  const listingLabel = kind === 'dms' ? 'DM conversations' : 'channels';
  const dmView = kind === 'dms' && compact.coverage?.source === 'dms-view';
  const listingDescription = dmView
    ? 'DM conversations from the DMs view'
    : `sidebar ${listingLabel}`;
  const lines = [
    batch
      ? listing
        ? `Collected exposed ${listingDescription}; other ${listingLabel} may be outside these captures.`
        : kind === 'search'
          ? 'Collected search snippets; full message content and other matches may be outside these pages.'
          : `More ${kind === 'thread' ? 'replies' : 'messages'} and message content may be outside these pages.`
      : listing
        ? `Showing exposed ${listingDescription}; other ${listingLabel} may be outside this view.`
        : paginated && compact.pagination.status === 'no-progress'
          ? `No additional ${kind === 'thread' ? 'replies' : 'messages'} were exposed; history may continue.`
          : paginated
            ? `Showing this page of ${kind === 'thread' ? 'replies' : 'messages'}; more may be outside this view.`
            : kind === 'search'
              ? 'Showing search snippets; more message content may be outside this view.'
              : kind === 'thread'
                ? 'Showing loaded replies. More replies may be outside this view.'
                : 'Showing loaded messages; older messages and thread replies may be outside this view.',
  ];
  const content =
    kind === 'thread'
      ? [compact.thread?.root, ...list(compact.thread?.replies)]
      : list(compact.messages);
  if (
    content.some((message) => list(message?.attachments).length || list(message?.previews).length)
  )
    lines.push(
      'Media metadata only; file contents and external preview targets were not read.',
      'Use --format=json for media URLs and full metadata; references identify captured records.'
    );
  if (!paginated && compact.pagination?.hasMore === true) lines.push('More results are available.');
  if (compact.coverage?.captureTruncated === true) lines.push('The capture reached its limit.');
  if (batch) {
    const remainder = listing
      ? `other ${listingLabel} may remain`
      : kind === 'search'
        ? 'more matches may remain'
        : 'history may continue';
    const stopNotes = {
      'page-limit': `Reached the requested ${batch.requestedPages}-page limit; ${remainder}.`,
      'no-progress': `Stopped after a ${listing ? 'capture' : 'page'} exposed no additional ${listing ? (dmView ? 'rows in the DMs view' : 'sidebar rows') : kind === 'search' ? 'matches' : kind === 'thread' ? 'replies' : 'messages'}; ${remainder}.`,
      'no-next-page':
        'No further page was offered from the verified view; coverage remains partial.',
      'since-reached': 'Stopped paging once the requested start was reached.',
      'time-limit': 'The multi-page time limit was reached; only verified pages are included.',
    };
    if (stopNotes[batch.stopReason]) lines.push(stopNotes[batch.stopReason]);
    if (batch.deduplicatedCount)
      lines.push(
        listing
          ? `${countLabel(batch.deduplicatedCount, kind === 'dms' ? 'repeated DM observation' : 'repeated channel observation')} omitted.`
          : kind === 'search'
            ? `${batch.deduplicatedCount} repeated ${batch.deduplicatedCount === 1 ? 'match' : 'matches'} omitted.`
            : `${countLabel(batch.deduplicatedCount, 'repeated viewport message')} omitted.`
      );
  }
  lines.push(...coverageNotes(compact, true));
  lines.push(...paginationLines(compact));
  return lines;
}

function renderChannels(compact) {
  const channels = list(compact.channels),
    shown = channels.slice(0, 30);
  const batch = batchState(compact);
  const lines = [`Channels${workspaceSuffix(compact)}`];
  if (batch)
    lines.push(
      `${countLabel(channels.length, 'unique channel')} across ${countLabel(batch.completedPages, 'sidebar capture')}.`
    );
  for (const channel of shown) {
    const name = shortInline(displayName(channel), 120) || '(name not exposed)';
    const command = channelCommand(displayName(channel), compact, channel?.navigation);
    lines.push(
      `${name.startsWith('#') ? name : `#${name}`}${channel?.unread === true ? ' (unread)' : ''}${command ? ` · ${command}` : ''}`
    );
  }
  if (!shown.length) lines.push('No channels were exposed in the sidebar.');
  else if (!batch && channels.length <= shown.length)
    lines.push(`${countLabel(channels.length, 'captured channel')}.`);
  if (channels.length > shown.length) {
    lines.push(
      batch
        ? `Showing ${shown.length} of ${channels.length} collected channels; ${channels.length - shown.length} omitted from text.`
        : `Showing ${shown.length} of ${channels.length} captured channels; ${channels.length - shown.length} omitted.`,
      `Use --format=json for all ${batch ? 'collected' : 'captured'} channels.`
    );
  }
  lines.push(...coverageLines(compact, 'channels'));
  return lines.join('\n');
}

function autocompleteCommand(dm, compact) {
  const action = scopedNavigation(dm?.navigation, compact);
  if (dm?.id !== null || action?.command !== 'read-dm' || !Array.isArray(action.args)) return null;
  if (
    dm.kind === 'person' &&
    typeof dm.handle === 'string' &&
    /^[A-Za-z0-9._-]+$/.test(dm.handle) &&
    action.args.length === 1 &&
    action.args[0] === `@${dm.handle}`
  )
    return scopeCommand(`read-dm ${shellArgument(action.args[0])}`, compact);
  if (
    dm.kind === 'group' &&
    typeof dm.name === 'string' &&
    dm.name.trim() &&
    Array.from(dm.name).length <= 200 &&
    plain(dm.name) === dm.name &&
    !/[\r\n\t]/.test(dm.name) &&
    action.args.length === 2 &&
    action.args[0] === `group-name:${dm.name}` &&
    action.args[1] === '--allow-clipboard'
  )
    return scopeCommand(`read-dm --allow-clipboard ${shellArgument(action.args[0])}`, compact);
  return null;
}

function renderDMSearch(compact) {
  const dms = list(compact.dms),
    shown = dms.slice(0, 30);
  const search = compact.coverage?.search,
    batch = compact.pagination?.batch;
  if (
    search?.source !== 'dms-search-autocomplete' ||
    search.verified !== true ||
    typeof search.requestedQuery !== 'string' ||
    compact.coverage?.filters?.query !== search.requestedQuery ||
    !batch ||
    !Number.isInteger(batch.completedPages) ||
    batch.completedPages < 1 ||
    !Number.isInteger(batch.requestedPages) ||
    batch.requestedPages < batch.completedPages ||
    batch.requestedPages > 10 ||
    !['requested-pages', 'no-progress', 'empty-results', 'guard-failed'].includes(batch.stopReason)
  )
    throw new Error('DMs autocomplete summary is invalid');
  const lines = [
    `Slack DMs search matches${workspaceSuffix(compact)}`,
    `Query: ${JSON.stringify(shorten(plain(search.requestedQuery), 120).value)}.`,
  ];
  const match = compact.coverage?.match;
  if (match) {
    if (
      typeof match.query !== 'string' ||
      !Number.isSafeInteger(match.observedCount) ||
      match.observedCount < dms.length ||
      match.matchedCount !== dms.length ||
      JSON.stringify(match.fields) !== JSON.stringify(['name', 'participantLabels'])
    )
      throw new Error('Local DM match summary is invalid');
    lines.push(
      match.query === ''
        ? `Local filter: none; all ${match.observedCount} observed suggestions included.`
        : `Local filter: ${JSON.stringify(shorten(plain(match.query), 120).value)}; ${dms.length} of ${match.observedCount} observed suggestions matched.`
    );
  }
  lines.push(
    `${countLabel(dms.length, 'unique autocomplete match', 'unique autocomplete matches')} across ${countLabel(batch.completedPages, 'capture')}.`
  );
  for (const dm of shown) {
    const name = shortInline(dm.name, 120),
      handle = shortInline(dm.handle, 100);
    const command = autocompleteCommand(dm, compact);
    lines.push(
      `- ${name}${dm.kind === 'group' ? ' (group)' : ' (person)'}${handle ? ` · @${handle}` : ''}${command ? ` · ${command}` : ''}`
    );
  }
  if (!dms.length)
    lines.push(
      match?.query
        ? 'No captured suggestions matched the local filter.'
        : 'No autocomplete matches were exposed for this query.'
    );
  if (dms.length > shown.length)
    lines.push(
      `Showing ${shown.length} of ${dms.length} matches; use --format=json for all captured matches.`
    );
  lines.push('The DMs unread setting is preserved; its effect on suggestions is not verified.');
  lines.push(
    'Suggestions may include people without an existing DM. Conversation IDs and full group membership are unknown.'
  );
  if (batch.stopReason === 'no-progress')
    lines.push('No additional suggestions were exposed; more matches may exist.');
  if (compact.status === 'partial' || compact.error)
    lines.push(
      ...[
        `Stopped: ${shortInline(compact.error, 300)}`,
        observationLine(compact),
        `Next: ${shortInline(compact.next, 300)}`,
      ].filter(Boolean)
    );
  return lines.join('\n');
}

function renderDMs(compact) {
  if (compact.coverage?.source === 'dms-search-autocomplete') return renderDMSearch(compact);
  const dms = list(compact.dms),
    shown = dms.slice(0, 30);
  const batch = batchState(compact);
  const source = compact.coverage?.source === 'dms-view' ? 'DMs view' : 'sidebar';
  const lines = [`DMs${workspaceSuffix(compact)}`];
  const search = compact.coverage?.search;
  if (search) {
    if (
      source !== 'DMs view' ||
      search.source !== 'slack-dms-view' ||
      typeof search.requestedQuery !== 'string' ||
      search.verified !== true ||
      compact.coverage?.filters?.query !== search.requestedQuery
    )
      throw new Error('Native DMs search summary is invalid');
    lines.push(
      search.requestedQuery === ''
        ? 'Slack DMs search: cleared.'
        : `Slack DMs search: ${JSON.stringify(shorten(plain(search.requestedQuery), 120).value)}.`
    );
  }
  const match = compact.coverage?.match;
  if (match) {
    if (
      typeof match.query !== 'string' ||
      !Number.isSafeInteger(match.observedCount) ||
      match.observedCount < dms.length ||
      match.matchedCount !== dms.length ||
      JSON.stringify(match.fields) !== JSON.stringify(['name', 'participantLabels'])
    )
      throw new Error('Local DM match summary is invalid');
    lines.push(
      match.query === ''
        ? `Local filter: none; all ${match.observedCount} observed conversations included.`
        : `Local filter: ${JSON.stringify(shorten(plain(match.query), 120).value)}; ${match.matchedCount} of ${match.observedCount} observed conversations matched.`
    );
  }
  if (source === 'DMs view') {
    const query = shortInline(compact.coverage?.filters?.query, 120);
    const filters = [
      ...(query && !search ? [`search ${JSON.stringify(query)}`] : []),
      ...(compact.coverage?.filters?.unreadOnly === true ? ['unread only'] : []),
    ];
    if (filters.length) lines.push(`Filters: ${filters.join('; ')}.`);
  }
  if (batch)
    lines.push(
      `${countLabel(dms.length, 'unique DM conversation')} across ${countLabel(batch.completedPages, `${source} capture`)}.`
    );
  for (const dm of shown) {
    const name = shortInline(dm?.name, 120) || '(name not exposed)';
    const kind = dm?.kind === 'group' ? ' (group DM)' : dm?.kind === 'self' ? ' (you)' : '';
    const participantMatch =
      match?.query &&
      typeof dm?.name === 'string' &&
      !dm.name.toLowerCase().includes(match.query.toLowerCase()) &&
      list(dm.participantLabels).some(
        (label) =>
          typeof label === 'string' && label.toLowerCase().includes(match.query.toLowerCase())
      );
    const command =
      dm?.kind === 'group'
        ? groupDMCommand(dm, compact)
        : ['one-to-one', 'self'].includes(dm?.kind) && dm?.navigation?.command === 'read-dm'
          ? candidateCommand(dm, compact)
          : null;
    lines.push(
      `- ${name}${kind}${participantMatch ? ' (participant match)' : ''}${dm?.unread === true ? ' (unread)' : ''}${command ? ` · ${command}` : ''}`
    );
  }
  if (!shown.length)
    lines.push(
      match?.query
        ? 'No captured DM conversations matched the local filter.'
        : `No DM conversations were exposed in the ${source}.`
    );
  else if (!batch && dms.length <= shown.length)
    lines.push(`${countLabel(dms.length, 'captured DM conversation')}.`);
  if (dms.length > shown.length) {
    lines.push(
      `Showing ${shown.length} of ${dms.length} ${batch ? 'collected' : 'captured'} DM conversations; ${dms.length - shown.length} omitted${batch ? ' from text' : ''}.`,
      `Use --format=json for all ${batch ? 'collected' : 'captured'} DM conversations.`
    );
  }
  lines.push(...coverageLines(compact, 'dms'));
  return lines.join('\n');
}

function mediaReference(value, type) {
  if (type === 'm') {
    try {
      return parseMediaReference(value).ref;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'string' || value.length > 160) return null;
  const match = value.match(/^(.+)\/([mp])([1-9]\d{0,3})$/);
  return match && match[2] === type && threadReference(match[1]) ? value : null;
}

function transcriptCommand(media, requested = media?.ref, compact) {
  const reference = mediaReference(requested, 'm');
  return reference &&
    media?.ref === reference &&
    ['audio', 'video'].includes(media.kind) &&
    media.transcript?.state === 'available' &&
    media.transcript.navigation !== null
    ? scopeCommand(`read-transcript ${reference}`, compact, media.transcript?.navigation)
    : null;
}

function renderRichContent(message, compact) {
  let trimmed = false;
  const field = (value, maximum) => {
    const result = shorten(inline(value).replace(/[\uE000\uE001]/g, ''), maximum);
    trimmed ||= result.shortened;
    return result.value;
  };
  const lines = [];
  const quotes = list(message.quotedMessages);
  for (const quote of quotes.slice(0, 2)) {
    const author = field(displayName(quote?.author), 80) || 'Author not exposed';
    const body = field(quote?.text, 220) || '[No text exposed]';
    lines.push(`Quoted · ${author}: ${body}`);
  }
  if (quotes.length > 2) {
    lines.push(`${countLabel(quotes.length - 2, 'additional quote')} omitted.`);
    trimmed = true;
  }
  const entries = [
    ...list(message.attachments).map((item) => ({ item, preview: false })),
    ...list(message.previews).map((item) => ({ item, preview: true })),
  ];
  const kinds = {
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    document: 'Document',
    file: 'File',
    link: 'Link',
  };
  for (const { item, preview } of entries.slice(0, 4)) {
    const kind = kinds[item?.kind] ?? (preview ? 'Link' : 'Attachment');
    const label = field(
      preview ? (item?.title ?? item?.label) : (item?.label ?? item?.filename),
      120
    );
    const duration = field(item?.displayedDuration, 40);
    const description = field(item?.description, 140);
    const author = field(displayName(item?.provenance?.author), 80);
    const reference = mediaReference(item?.ref, preview ? 'p' : 'm');
    const transcript =
      item?.transcript?.state === 'available'
        ? 'transcript available'
        : item?.transcript?.state === 'generatable'
          ? 'transcript generation offered'
          : '';
    const details = [
      preview ? `Preview · ${kind}` : kind,
      label,
      duration,
      transcript,
      author ? `quoted from ${author}` : '',
      description
        ? `Description${item?.descriptionSource === 'accessibility' ? ' (accessibility)' : ''}: ${description}`
        : '',
      reference
        ? preview
          ? `[${reference}]`
          : scopeCommand(`read-media ${reference}`, compact, item?.navigation)
        : '',
      preview ? '' : transcriptCommand(item, item?.ref, compact),
    ];
    lines.push(details.filter(Boolean).join(' · '));
  }
  if (entries.length > 4) {
    lines.push(`${countLabel(entries.length - 4, 'additional media item')} omitted.`);
    trimmed = true;
  }
  return { lines, trimmed };
}

function renderMedia(compact) {
  const media = compact.media ?? {};
  let trimmed = false;
  const field = (value, maximum) => {
    const result = shorten(inline(value).replace(/[\uE000\uE001]/g, ''), maximum);
    trimmed ||= result.shortened;
    return result.value;
  };
  const kind =
    { image: 'Image', video: 'Video', audio: 'Audio', document: 'Document', file: 'File' }[
      media.kind
    ] ?? 'Attachment';
  const reference = mediaReference(compact.requested, 'm');
  const name = field(media.label ?? media.filename, 200);
  const lines = [
    [kind, name, reference ? `[${reference}]` : ''].filter(Boolean).join(' · ') +
      workspaceSuffix(compact),
  ];
  if (media.filename && media.filename !== media.label)
    lines.push(`Filename: ${field(media.filename, 200)}`);
  if (media.description)
    lines.push(
      `Description${media.descriptionSource === 'accessibility' ? ' (accessibility)' : ''}: ${field(media.description, 1200)}`
    );
  if (media.displayedDuration) lines.push(`Duration: ${field(media.displayedDuration, 80)}`);
  if (media.displayedPlaybackTime)
    lines.push(`Displayed playback position: ${field(media.displayedPlaybackTime, 80)}`);
  if (media.kind === 'audio' || media.kind === 'video' || media.transcript?.state === 'available')
    lines.push(
      `Transcript: ${
        media.transcript?.state === 'available'
          ? 'available in Slack; content not read'
          : media.transcript?.state === 'generatable'
            ? 'generation offered in Slack; not generated'
            : 'availability unknown'
      }`
    );
  const transcriptHint = transcriptCommand(media, compact.requested, compact);
  if (transcriptHint) lines.push(`Read transcript: ${transcriptHint}`);
  const saveNavigation = scopedNavigation(media.saveNavigation, compact);
  if (
    reference &&
    saveNavigation?.command === 'save-media' &&
    saveNavigation.args?.length === 1 &&
    saveNavigation.args[0] === reference &&
    saveNavigation.requiredOption === '--output=PATH'
  ) {
    const command = scopeCommand(
      `save-media ${reference} --output=PATH`,
      compact,
      media.saveNavigation
    );
    if (command) lines.push(`Save attachment: ${command}`);
  }
  const provenance = field(displayName(media.provenance?.author), 120);
  if (provenance) lines.push(`Quoted from: ${provenance}`);
  const urlLine = (label, value) => {
    if (!value) return;
    const url = sourceLink(value);
    if (url && !new URL(url).username && !new URL(url).password) lines.push(`${label}: ${url}`);
    else trimmed = true;
  };
  urlLine('Quoted source', media.provenance?.permalink);
  urlLine('File page', media.filePageUrl);
  urlLine('Download target (observed)', media.downloadUrl);
  urlLine('Thumbnail', media.thumbnailUrl);
  if (![media.filePageUrl, media.downloadUrl, media.thumbnailUrl].includes(media.url))
    urlLine('Media link (observed)', media.url);
  const sources = list(compact.sources);
  const seenThreads = new Set();
  for (const source of sources.slice(0, 6)) {
    const author = field(displayName(source.author), 120);
    const messageRef = threadReference(source.messageRef);
    const details = [
      author ? `${author}${source.authorInferred === true ? ' (inferred)' : ''}` : '',
      messageRef,
    ].filter(Boolean);
    lines.push(`Source${details.length ? `: ${details.join(' · ')}` : ' message'}`);
    urlLine('Message', source.permalink);
    const provenances = list(source.provenance).filter(
      (entry) => entry && JSON.stringify(entry) !== JSON.stringify(media.provenance)
    );
    for (const entry of provenances.slice(0, 2)) {
      const quotedAuthor = field(displayName(entry.author), 120);
      if (quotedAuthor) lines.push(`Quoted from: ${quotedAuthor}`);
      urlLine('Quoted source', entry.permalink);
    }
    if (provenances.length > 2) {
      lines.push(`${countLabel(provenances.length - 2, 'additional provenance record')} omitted.`);
      trimmed = true;
    }
    const action = source.thread?.navigation;
    const hint =
      action?.command === 'read-thread' &&
      Array.isArray(action.args) &&
      action.args.length === 1 &&
      action.args[0] === source.thread?.ref
        ? threadHint(source.thread, compact)
        : null;
    if (hint && !seenThreads.has(hint)) {
      lines.push(hint);
      seenThreads.add(hint);
    }
  }
  if (sources.length > 6) {
    lines.push(`${countLabel(sources.length - 6, 'additional source')} omitted.`);
    trimmed = true;
  }
  lines.push('Metadata only; file contents and transcripts were not read.');
  lines.push(
    trimmed
      ? 'Some details were shortened or omitted; use --format=json for all captured metadata.'
      : 'Use --format=json for all captured metadata.'
  );
  return lines.join('\n');
}

function renderTranscript(compact) {
  const batch = batchState(compact);
  const media = compact.media ?? {};
  const reference = mediaReference(compact.requested, 'm');
  const kind = { audio: 'Audio', video: 'Video' }[media.kind] ?? 'Media';
  const title = shortInline(media.label ?? media.filename, 160);
  const lines = [
    ['Transcript', kind, title, reference ? `[${reference}]` : ''].filter(Boolean).join(' · ') +
      workspaceSuffix(compact),
    '',
  ];
  const segments = list(compact.transcript?.segments);
  let remaining = 6000,
    shown = 0,
    shortened = false;
  for (const segment of segments.slice(0, 40)) {
    const timestamp = shortInline(segment?.timestamp, 80);
    const prefix = timestamp ? `${timestamp} · ` : '';
    if (remaining <= Array.from(prefix).length + 1) break;
    const body = shorten(plain(segment?.text).trim(), remaining - Array.from(prefix).length);
    const line = `${prefix}${body.value}`;
    lines.push(line);
    shown += 1;
    shortened ||= body.shortened;
    remaining -= Array.from(line).length + 1;
    if (body.shortened) break;
  }
  if (!segments.length) lines.push('No transcript segments were exposed.');
  if (shown < segments.length)
    lines.push(
      `${countLabel(segments.length - shown, 'additional transcript segment')} omitted from text.`
    );
  if (shortened) lines.push('Transcript text was shortened.');
  if (shown < segments.length || shortened)
    lines.push('Use --format=json for every captured segment and its full text.');
  if (batch) {
    lines.push(
      '',
      `${countLabel(segments.length, 'unique transcript segment')} across ${batch.completedPages} of ${batch.requestedPages} requested pages; ${countLabel(batch.deduplicatedCount, 'repeated observation')} removed.`,
      {
        'page-limit': 'Requested page limit reached; completeness unknown.',
        'no-progress': 'No new segments were verified; completeness unknown.',
        error: 'The next page could not be verified; completeness unknown.',
        'time-limit': 'Collection time limit reached; completeness unknown.',
      }[batch.stopReason]
    );
  } else {
    lines.push(
      '',
      `${countLabel(segments.length, 'captured transcript segment')}; completeness unknown.`
    );
  }
  const sources = list(compact.sources);
  for (const source of sources.slice(0, 6)) {
    const author = shortInline(displayName(source?.author), 80);
    const ref = threadReference(source?.messageRef);
    const label = [
      author ? `${author}${source.authorInferred === true ? ' (inferred)' : ''}` : '',
      ref,
    ]
      .filter(Boolean)
      .join(' · ');
    if (label) lines.push(`Source: ${label}`);
    const url = sourceLink(source?.permalink);
    if (url && !new URL(url).username && !new URL(url).password) lines.push(`Message: ${url}`);
  }
  if (sources.length > 6)
    lines.push(
      `${countLabel(sources.length - 6, 'additional source')} omitted; use --format=json.`
    );
  if (reference?.startsWith('F')) {
    const command = scopeCommand(`read-media ${reference}`, compact);
    if (command) lines.push(`Inspect attachment: ${command}`);
  } else if (reference) {
    lines.push('Refresh attachment reference: inspect, then follow its read-media hint.');
  }
  return lines.join('\n');
}

function renderMessage(message, isSearch = false, includeThreadHint = true, compact) {
  const name = shortInline(displayName(message.author), 80);
  const author = name
    ? `${name}${message.authorInferred === true ? ' (inferred)' : ''}`
    : 'Author not exposed';
  const time =
    shortInline(message.displayedTime ?? message.displayedDay, 100) || 'Time not exposed';
  const channel = isSearch ? shortInline(displayName(message.channel), 80) : '';
  const channelLabel =
    channel.startsWith('#') || channel.startsWith('Thread in ') ? channel : `#${channel}`;
  const heading = `${author} · ${time}${channel ? ` · ${channelLabel}` : ''}`;
  const attachments = list(message.attachments);
  const rawBody = plain(message.text ?? message.snippet).trim();
  const body = shorten(
    rawBody ||
      (attachments.length
        ? `[No text exposed; ${countLabel(attachments.length, 'attachment')} captured]`
        : '[No text exposed]'),
    500
  );
  const source = sourceLink(message.permalink);
  const hint = includeThreadHint ? threadHint(message.thread, compact) : null;
  const rich = renderRichContent(message, compact);
  return {
    block: `${heading}\n  ${body.value.replace(/\n/g, '\n  ')}${rich.lines.length ? `\n  ${rich.lines.join('\n  ')}` : ''}${source ? `\n  ${source}` : ''}${hint ? `\n  ${hint}` : ''}`,
    shortened: body.shortened,
    richTrimmed: rich.trimmed,
  };
}

function renderMessageRows(compact, isSearch = false) {
  const messages = list(compact.messages);
  const paginated = !isSearch && compact.pagination?.supported === true;
  const batch = batchState(compact);
  if (paginated && messages.length > (batch ? batch.completedPages * 10 : 10))
    throw new Error(
      batch ? 'Message batch exceeds its page limit' : 'Message page exceeds ten messages'
    );
  const shown = paginated
    ? messages
    : isSearch
      ? messages.slice(0, batch ? batch.completedPages * 10 : 10)
      : messages.slice(-10);
  const blocks = [];
  let shortened = 0,
    richTrimmed = false;
  const range = compact.coverage?.range;
  if (range !== undefined && !isSearch) {
    if (
      !Number.isSafeInteger(range.oldestTimestamp) ||
      !Number.isSafeInteger(range.newestTimestamp) ||
      range.oldestTimestamp > range.newestTimestamp
    )
      throw new Error('Collected message range is invalid');
    const oldest = shortInline(range.oldest, 60),
      newest = shortInline(range.newest, 60);
    if (oldest && newest)
      blocks.push(
        oldest === newest
          ? `Collected messages are from ${oldest}.`
          : `Collected messages span ${oldest} to ${newest}.`
      );
  }
  const sinceMatch = compact.coverage?.since;
  if (sinceMatch !== undefined) {
    if (
      typeof sinceMatch.requested !== 'string' ||
      typeof sinceMatch.reached !== 'boolean' ||
      !Number.isSafeInteger(sinceMatch.observedCount) ||
      !Number.isSafeInteger(sinceMatch.matchedCount) ||
      sinceMatch.matchedCount > sinceMatch.observedCount ||
      (compact.coverage?.authorMatch === undefined && sinceMatch.matchedCount !== messages.length)
    )
      throw new Error('Since boundary evidence is invalid');
    blocks.push(
      `Since ${shortInline(sinceMatch.requested, 40)}: ${sinceMatch.matchedCount} of ${countLabel(sinceMatch.observedCount, 'collected message')} on or after it. ${
        sinceMatch.reached
          ? 'The collection reaches back to that start.'
          : 'The collection stopped before reaching that start; earlier messages in the period may be missing. Continue with the older-page reference.'
      }`
    );
  }
  const authorMatch = compact.coverage?.authorMatch;
  if (authorMatch !== undefined) {
    if (
      typeof authorMatch.query !== 'string' ||
      authorMatch.matchedCount !== messages.length ||
      !Number.isSafeInteger(authorMatch.observedCount) ||
      authorMatch.observedCount < messages.length ||
      messages.some(
        (message) =>
          typeof message.author !== 'string' ||
          !message.author.toLowerCase().includes(authorMatch.query.toLowerCase())
      )
    )
      throw new Error('Author match evidence is invalid');
    blocks.push(
      `Author filter: ${JSON.stringify(shorten(plain(authorMatch.query), 120).value)}; ${messages.length} of ${countLabel(authorMatch.observedCount, 'collected message')} matched. Other pages were not scanned.`
    );
  }
  if (isSearch && batch)
    blocks.push(
      `${messages.length} unique ${messages.length === 1 ? 'match' : 'matches'} across ${countLabel(batch.completedPages, 'result page')}.`
    );
  if (!shown.length) {
    if (!(paginated && compact.pagination.status === 'no-progress'))
      blocks.push(
        isSearch
          ? 'No message results were exposed.'
          : 'No messages were exposed in the loaded conversation.'
      );
  } else if (batch && !isSearch)
    blocks.push(
      `${countLabel(messages.length, 'message')} across ${countLabel(batch.completedPages, 'page')}.`
    );
  else if (!batch && messages.length <= 10)
    blocks.push(
      paginated
        ? `${countLabel(messages.length, 'message')} on this page.`
        : `${countLabel(messages.length, 'captured message')}.`
    );
  else if (!batch)
    blocks.push(
      `Showing ${isSearch ? 'first' : 'last'} ${shown.length} of ${messages.length} captured messages; ${messages.length - shown.length} omitted.`
    );
  if (isSearch && batch && shown.length < messages.length)
    blocks.push(
      `Showing first ${shown.length} of ${messages.length} collected matches; ${messages.length - shown.length} omitted from text.`
    );
  for (const message of shown) {
    const rendered = renderMessage(message, isSearch, true, compact);
    if (rendered.shortened) shortened++;
    richTrimmed ||= rendered.richTrimmed;
    blocks.push(rendered.block);
  }
  if (shortened) blocks.push(`${countLabel(shortened, 'message')} shortened to 500 characters.`);
  if (messages.length > shown.length || shortened)
    blocks.push(
      paginated
        ? `Use --format=json for full text on ${batch ? 'these pages' : 'this page'}.`
        : isSearch && batch
          ? 'Use --format=json for all collected matches and their full captured text.'
          : 'Use --format=json for all captured content.'
    );
  if (richTrimmed)
    blocks.push(
      'Quoted content or media metadata was shortened or omitted; use --format=json for all captured details.'
    );
  blocks.push(coverageLines(compact, isSearch ? 'search' : 'messages').join('\n'));
  return blocks.join('\n\n');
}

function renderThread(compact) {
  const thread = compact.thread;
  const rootOutsideView = thread?.root === null;
  if (
    !rootOutsideView &&
    (!thread?.root || typeof thread.root !== 'object' || Array.isArray(thread.root))
  )
    throw new Error('Thread root message is unavailable');
  const rootPermalink = sourceLink(thread.rootPermalink);
  if (rootOutsideView && !rootPermalink) throw new Error('Thread root permalink is unavailable');
  const name = shortInline(compact.conversation?.name, 120);
  const destination =
    compact.conversation?.kind === 'channel' ? `#${name.replace(/^#/, '')}` : name;
  const replies = list(thread.replies),
    paginated = compact.pagination?.supported === true;
  const batch = batchState(compact);
  if (paginated && replies.length > (batch ? batch.completedPages * 10 : 10))
    throw new Error(
      batch ? 'Thread batch exceeds its page limit' : 'Thread page exceeds ten replies'
    );
  const shown = paginated ? replies : replies.slice(-10);
  const total =
    Number.isSafeInteger(thread.displayedReplyCount) && thread.displayedReplyCount >= 0
      ? thread.displayedReplyCount
      : null;
  const replyCount = (count) => `${count} ${count === 1 ? 'reply' : 'replies'}`;
  const root = rootOutsideView
    ? { block: `Root message is outside this view.\n  ${rootPermalink}`, shortened: false }
    : renderMessage(
        { ...thread.root, permalink: thread.root.permalink ?? thread.rootPermalink },
        false,
        false,
        compact
      );
  const reference = threadReference(thread.ref);
  const channel =
    compact.conversation?.kind === 'channel'
      ? channelCommand(compact.conversation.name, compact)
      : null;
  const blocks = [
    `Thread${destination ? ` in ${destination}` : ''}${workspaceSuffix(compact)}${reference ? `\nReference: ${reference}` : ''}${channel ? `\nBack to channel: ${channel}` : ''}`,
    `Root message\n${root.block}`,
  ];
  const summary = replies.length
    ? batch
      ? `${replyCount(replies.length)} across ${countLabel(batch.completedPages, 'page')}`
      : paginated
        ? `${replyCount(replies.length)} on this page`
        : `${replies.length} captured ${replies.length === 1 ? 'reply' : 'replies'}`
    : 'No replies were exposed';
  blocks.push(
    `Replies\n${summary}; ${total === null ? 'total reply count not exposed' : `Slack shows ${replyCount(total)}`}.`
  );
  if (replies.length > shown.length)
    blocks.push(
      `Showing last ${shown.length} of ${replies.length} captured replies; ${replies.length - shown.length} omitted.`
    );
  let shortened = root.shortened ? 1 : 0,
    richTrimmed = root.richTrimmed === true;
  for (const reply of shown) {
    const rendered = renderMessage(reply, false, false, compact);
    if (rendered.shortened) shortened++;
    richTrimmed ||= rendered.richTrimmed;
    blocks.push(rendered.block);
  }
  if (shortened) blocks.push(`${countLabel(shortened, 'message')} shortened to 500 characters.`);
  if (replies.length > shown.length || shortened)
    blocks.push(
      paginated
        ? `Use --format=json for full text on ${batch ? 'these pages' : 'this page'}.`
        : 'Use --format=json for all captured content.'
    );
  if (richTrimmed)
    blocks.push(
      'Quoted content or media metadata was shortened or omitted; use --format=json for all captured details.'
    );
  blocks.push(coverageLines(compact, 'thread').join('\n'));
  return blocks.join('\n\n');
}

function pageLabel(page) {
  if (typeof page === 'number' && Number.isFinite(page)) return `page ${page}`;
  if (typeof page === 'string') return shortInline(page, 80).replace(/^page\s*/i, 'page ');
  if (page && typeof page === 'object') {
    const current = page.current ?? page.number ?? page.index;
    const total = page.total ?? page.totalPages;
    if (current !== undefined && current !== null)
      return `page ${shortInline(current, 12)}${total !== undefined && total !== null ? ` of ${shortInline(total, 12)}` : ''}`;
  }
  return '';
}

function renderSearch(compact) {
  const query = shortInline(compact.search?.query ?? compact.requested, 200);
  const lines = [`Search${query ? `: ${query}` : ''}${workspaceSuffix(compact)}`];
  const total = compact.search?.totalResults;
  let page = pageLabel(
    typeof compact.search?.page === 'number' && compact.search?.pageCount !== undefined
      ? { current: compact.search.page, total: compact.search.pageCount }
      : compact.search?.page
  );
  const batch = batchState(compact);
  const first = compact.search?.firstPage,
    last = compact.search?.lastPage;
  if (batch && (first != null || last != null)) {
    if (
      !Number.isSafeInteger(first) ||
      first < 1 ||
      !Number.isSafeInteger(last) ||
      last < first ||
      last !== compact.search.page ||
      (Number.isSafeInteger(compact.search.pageCount) && last > compact.search.pageCount)
    )
      throw new Error('Search result page range is invalid');
    page = first === last ? `page ${first}` : `pages ${first}–${last}`;
    if (Number.isSafeInteger(compact.search.pageCount)) page += ` of ${compact.search.pageCount}`;
  }
  const summary = [
    typeof total === 'number' && Number.isFinite(total) ? countLabel(total, 'result') : '',
    page,
  ]
    .filter(Boolean)
    .join(' · ');
  if (summary) lines.push(summary);
  if (total === 0 && list(compact.messages).length === 0 && !batch) {
    lines.push('No results.', ...coverageLines(compact, 'search'));
    return lines.join('\n');
  }
  return `${lines.join('\n')}\n\n${renderMessageRows(compact, true)}`;
}

function renderQuery(query) {
  const value = shortInline(query?.value, 180);
  const suggestions = list(query?.suggestions);
  const lines = [`Search box${value ? `: ${value}` : ' is open'} (not submitted).`];
  for (const suggestion of suggestions.slice(0, 10)) {
    const label = shortInline(suggestion.label, 140);
    const handle = shortInline(suggestion.handle, 80);
    if (label || handle)
      lines.push(`- ${label}${handle && !label.includes(handle) ? ` (${handle})` : ''}`);
  }
  if (suggestions.length > 10)
    lines.push(
      `Showing 10 of ${suggestions.length} captured suggestions; use --format=json for all captured suggestions.`
    );
  return lines.join('\n');
}

function accessibilityProbeLine(compact) {
  const probe = compact.accessibilityProbe;
  if (!probe || typeof probe !== 'object') return '';
  const states = {
    accessible: 'accessible',
    'api-disabled': 'API disabled',
    unavailable: 'unavailable',
    'not-running': 'Slack not running',
    ambiguous: 'multiple Slack apps',
    'not-checked': 'not checked',
  };
  const status = states[probe.status] ?? 'unknown';
  const code = Number.isInteger(probe.error?.code) ? ` (${probe.error.code})` : '';
  return `Slack AX: ${status}${code}.`;
}

function renderPermissions(compact) {
  const access = (value) =>
    value === true ? 'allowed' : value === false ? 'unavailable here' : 'unknown';
  const probeAccessible =
    compact.accessibilityProbe === undefined || compact.accessibilityProbe?.status === 'accessible';
  const ready =
    !compact.error &&
    (compact.status === 'ready' || compact.status === undefined) &&
    probeAccessible &&
    compact.accessibilityTrusted === true &&
    compact.postEventAccess === true;
  const state = ready
    ? 'ready'
    : compact.status === 'inspection-only' &&
        probeAccessible &&
        compact.accessibilityTrusted === true &&
        compact.postEventAccess === false &&
        !compact.error
      ? 'inspection only'
      : compact.status === 'permission-required' ||
          compact.accessibilityTrusted === false ||
          compact.accessibilityProbe?.status === 'api-disabled'
        ? 'required in this execution context'
        : compact.status === 'unavailable' ||
            compact.status === 'stopped' ||
            (!probeAccessible && compact.accessibilityProbe?.status !== 'api-disabled')
          ? 'unavailable'
          : 'required in this execution context';
  const lines = [
    `Slack permissions: ${state}.`,
    `Accessibility: ${access(compact.accessibilityTrusted)}. Keyboard input: ${access(compact.postEventAccess)}.`,
  ];
  const probe = accessibilityProbeLine(compact);
  if (probe) lines.push(probe);
  if (compact.error) {
    const detail = typeof compact.error === 'object' ? compact.error?.message : compact.error;
    lines.push(`Stopped: ${shortInline(detail, 900) || 'Slack access could not be verified.'}`);
  }
  if (compact.promptRequested === true) lines.push('Permission prompt requested.');
  if (compact.settingsOpenRequested === true) lines.push('System Settings opening requested.');
  if (!ready && compact.next) lines.push(`Next: ${shortInline(compact.next, 900)}`);
  if (!ready && compact.executable) lines.push(`Helper: ${shortInline(compact.executable, 300)}`);
  return lines.join('\n');
}

function renderCandidates(compact) {
  const query = shortInline(compact.query ?? compact.requested, 180);
  const candidates = list(compact.candidates),
    shown = candidates.slice(0, 8);
  const lines = [
    `${compact.status === 'stopped' ? 'Destination lookup incomplete' : compact.status === 'ambiguous' ? 'Destination needs a choice' : 'No exact destination match'}${query ? `: ${query}` : '.'}`,
    'No destination was selected.',
  ];
  if (shown.length) {
    lines.push('Choose an available candidate:');
    for (const candidate of shown) {
      const name = shortInline(candidate?.name, 100) || 'Name not exposed';
      const handle = shortInline(candidate?.handle, 100);
      const command = candidateCommand(candidate, compact);
      lines.push(
        `- ${name}${handle && handle !== name ? ` (${handle})` : ''}${command ? ` · ${command}` : ''}`
      );
    }
  } else lines.push('No available candidates were exposed.');
  const total =
    Number.isSafeInteger(compact.candidateCount) && compact.candidateCount >= candidates.length
      ? compact.candidateCount
      : candidates.length;
  if (total > shown.length) lines.push(`Showing ${shown.length} of ${total} available candidates.`);
  if (candidates.length > shown.length)
    lines.push('Use --format=json for all returned candidates.');
  if (compact.candidatesTruncated === true) lines.push('The returned candidate list was capped.');
  const observation = observationLine(compact);
  if (observation) lines.push(observation);
  if (compact.next) lines.push(`Next: ${shortInline(compact.next, 500)}`);
  return lines.join('\n');
}

function renderSavedMedia(compact) {
  const saved = compact.saved;
  const lines = [];
  const unverifiedScope =
    (compact.requestedWorkspace !== undefined || compact.workspaceSelection !== undefined) &&
    !scopedWorkspace(compact);
  const viewerDownload = saved?.representation === 'observed-viewer-download';
  const fileDownload =
    saved?.representation === 'slack-file-download' &&
    saved.originalSelection?.status === 'selected' &&
    saved.originalSelection?.basis === 'source-bound-private-file-download';
  if (saved?.published === true) {
    const verified = saved.verified === true && !unverifiedScope;
    lines.push(
      `${verified ? 'Saved' : 'Published; verification incomplete'}: ${shortInline(saved.path, 700) || '[path unavailable]'}`
    );
    if (Number.isSafeInteger(saved.bytes) && saved.bytes >= 0)
      lines.push(
        `${saved.bytes} bytes · ${fileDownload ? 'Slack file download' : viewerDownload ? 'Slack file viewer Download' : 'Slack Download target'}`
      );
    if (typeof saved.sha256 === 'string' && /^[a-f0-9]{64}$/.test(saved.sha256))
      lines.push(`SHA-256: ${saved.sha256}`);
  } else if (saved?.published === null) {
    lines.push(
      `Publication uncertain; inspect: ${shortInline(saved.path, 700) || '[path unavailable]'}`
    );
  }
  if (fileDownload)
    lines.push('Original download route selected; uploaded-byte identity remains unknown.');
  else if (saved?.originalSelection?.basis === 'viewer-download-route-unexposed')
    lines.push('Original route was not exposed; viewer Download target selected.');
  else if (saved?.originalSelection?.status === 'unavailable')
    lines.push('Original download route unavailable; observed Download target selected.');
  if (compact.error || compact.status !== 'ok' || unverifiedScope) {
    const detail = typeof compact.error === 'object' ? compact.error?.message : compact.error;
    lines.push(
      `Stopped: ${shortInline(detail, 900) || (unverifiedScope ? 'The save workspace could not be verified.' : 'The attachment could not be saved and verified.')}`
    );
    const probe = accessibilityProbeLine(compact);
    if (probe) lines.push(probe);
    if (compact.downloadMayHaveStarted === true)
      lines.push('Slack may have started a download. Do not replay it automatically.');
    const viewerFailure = compact.viewer?.failure;
    if (viewerFailure && typeof viewerFailure === 'object') {
      const reason = shortInline(viewerFailure.reason, 200);
      const details = viewerFailure.family === 'file-details';
      const count = details ? viewerFailure.cardCount : viewerFailure.activeImageCount;
      const observed =
        Number.isSafeInteger(count) && count >= 0
          ? details
            ? `${count} observed file card${count === 1 ? '' : 's'}`
            : `${count} observed active image${count === 1 ? '' : 's'}`
          : null;
      const detail = [reason, observed].filter(Boolean).join(' · ');
      if (detail) lines.push(`Viewer check: ${detail}`);
    }
    const cleanup = compact.viewer?.cleanup;
    if (cleanup?.status === 'closed' && cleanup.closed === true && compact.viewer.closed === true)
      lines.push('Viewer cleanup: closed.');
    else if (cleanup?.status === 'withheld') lines.push('Viewer cleanup: withheld.');
    else if (cleanup?.status === 'unverified' || cleanup?.status === 'closed')
      lines.push('Viewer cleanup: closure unverified.');
    if (compact.viewerMayHaveOpened === true && compact.viewer?.closed !== true)
      lines.push('The file viewer may be open. Inspect Slack before another request.');
    const observation = observationLine(compact);
    if (observation) lines.push(observation);
    if (compact.next) lines.push(`Next: ${shortInline(compact.next, 700)}`);
  }
  return lines.join('\n');
}

function renderText(compact) {
  const selection = compact.workspaceSelection;
  if (selection && selection.status !== 'ok') {
    const stoppedSelection = {
      ...selection,
      operation: 'switch-workspace',
      status: ['ambiguous', 'not-found'].includes(selection.status) ? selection.status : 'stopped',
      error: selection.error ?? compact.error,
      next: selection.next ?? compact.next,
      workspaceSwitchMayHaveBeenRequested: Object.hasOwn(
        compact,
        'workspaceSwitchMayHaveBeenRequested'
      )
        ? compact.workspaceSwitchMayHaveBeenRequested
        : selection.workspaceSwitchMayHaveBeenRequested,
      workspaceSelection: undefined,
    };
    if (
      compact.operation === 'save-media' &&
      (compact.saved ||
        compact.downloadMayHaveStarted === true ||
        compact.viewerMayHaveOpened === true ||
        compact.sourceMayHaveReopened === true)
    )
      return `Workspace verification stopped for save-media.\n${renderText(stoppedSelection)}\n\n${renderSavedMedia({ ...compact, status: 'stopped' })}`;
    return `Workspace selection stopped before ${shortInline(compact.operation, 80) || 'the requested operation'}.\n${renderText(stoppedSelection)}`;
  }
  if (compact.operation === 'save-media') return renderSavedMedia(compact);
  if (
    !['workspaces', 'current-workspace', 'switch-workspace'].includes(compact.operation) &&
    (['ambiguous', 'not-found'].includes(compact.status) ||
      (compact.status === 'stopped' && Array.isArray(compact.candidates)))
  )
    return renderCandidates(compact);
  if (compact.operation === 'dms' && compact.coverage?.source === 'dms-search-autocomplete')
    return renderDMSearch(compact);
  if (compact.status === 'partial' && batchState(compact)) {
    const content = renderText({
      ...compact,
      status: 'ok',
      error: undefined,
      next: undefined,
      observation: undefined,
      pagination: { ...compact.pagination, older: null, newer: null },
    });
    const detail = typeof compact.error === 'object' ? compact.error?.message : compact.error;
    return [
      content,
      `Stopped: ${shortInline(detail, 900) || 'The remaining pages could not be verified.'}`,
      observationLine(compact),
      compact.next ? `Next: ${shortInline(compact.next, 700)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  if ('accessibilityTrusted' in compact || compact.operation === 'permissions')
    return renderPermissions(compact);
  if (COMPOSE_OPERATIONS.has(compact.operation) && 'actionMayHaveOccurred' in compact)
    return renderCompose(compact);
  if (compact.error || ['stopped', 'ambiguous', 'not-found'].includes(compact.status)) {
    const detail = typeof compact.error === 'object' ? compact.error?.message : compact.error;
    return [
      `Stopped: ${shortInline(detail, 900) || 'The Slack operation could not be verified.'}`,
      ...workspaceFailureLines(compact),
      compact.operation === 'close-members'
        ? [
            compact.closeMayHaveBeenRequested === true
              ? 'A close may have been requested; do not replay it automatically.'
              : compact.closeMayHaveBeenRequested === false
                ? 'No close was requested.'
                : 'Whether a close was requested is unknown.',
            compact.dialogMayBeOpen === true
              ? 'The members dialog may still be open.'
              : compact.dialogMayBeOpen === false
                ? 'The dialog was observed closed.'
                : 'The current dialog state is unknown.',
          ].join('\n')
        : '',
      compact.operation === 'read-transcript'
        ? compact.openingMayHaveBeenRequested === true
          ? 'Transcript opening may have been requested. Inspect Slack before another command; do not replay it automatically.'
          : compact.openingMayHaveBeenRequested === false
            ? 'No transcript-opening token was sent.'
            : ''
        : '',
      accessibilityProbeLine(compact),
      lockLine(compact),
      observationLine(compact),
      compact.next ? `Next: ${shortInline(compact.next, 700)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (['workspaces', 'current-workspace', 'switch-workspace'].includes(compact.operation))
    return renderWorkspaces(compact);
  if (compact.operation === 'members' && compact.status === 'ok') return renderMembers(compact);
  if (directoryOperations.has(compact.operation) && compact.status === 'ok')
    return renderDirectory(compact);
  if (COMPOSE_OPERATIONS.has(compact.operation)) return renderCompose(compact);
  if (compact.operation === 'close-thread')
    return compact.closed === true
      ? `Closed thread pane${compact.thread?.ref ? `: ${compact.thread.ref}` : ''}.${compact.thread?.ref ? `\nReopen: read-thread ${compact.thread.ref}` : ''}`
      : 'No thread pane was open; nothing was closed.';
  if (compact.operation === 'close-members')
    return compact.closed === true
      ? `Closed members dialog for #${shortInline(compact.channel?.name, 80)}.`
      : 'No members dialog was open; nothing was closed.';
  if (compact.operation === 'channels') return renderChannels(compact);
  if (compact.operation === 'dms') return renderDMs(compact);
  if (compact.operation === 'read-media') return renderMedia(compact);
  if (compact.operation === 'read-transcript') return renderTranscript(compact);
  if (compact.operation === 'read-thread') return renderThread(compact);
  if (compact.operation === 'search' || compact.search) return renderSearch(compact);
  if (compact.operation === 'read-channel' || compact.operation === 'read-dm') {
    const name =
      shortInline(compact.conversation?.name ?? compact.requested, 120) || 'conversation';
    const destination =
      compact.conversation?.kind === 'channel' || compact.operation === 'read-channel'
        ? `#${name.replace(/^#/, '')}`
        : `${name}${compact.conversation?.dmKind === 'group' ? ' (group DM)' : ''}`;
    return `${destination}${workspaceSuffix(compact)}\n\n${renderMessageRows(compact)}`;
  }
  const title = shortInline(compact.view?.title, 200);
  const lines = [title ? `Slack view: ${title}` : `Slack${workspaceSuffix(compact)}`];
  const url = sourceLink(compact.view?.url);
  if (url) lines.push(url);
  if (compact.query) lines.push(renderQuery(compact.query));
  else if (Array.isArray(compact.messages)) lines.push(renderMessageRows(compact));
  else if (Array.isArray(compact.channels)) lines.push(renderChannels(compact));
  else if (Array.isArray(compact.dms)) lines.push(renderDMs(compact));
  else if (compact.note) lines.push(shortInline(compact.note, 300));
  if (
    compact.query ||
    (!Array.isArray(compact.messages) &&
      !Array.isArray(compact.channels) &&
      !Array.isArray(compact.dms))
  )
    lines.push(...coverageNotes(compact));
  return lines.join('\n\n');
}

export function formatOutput(compact, format = 'text', receipt = undefined) {
  if (!formats.has(format)) throw usageError(`Unknown output format ${JSON.stringify(format)}`);
  if (format === 'full-json') {
    if (receipt === undefined) throw new Error('Full JSON receipt is unavailable');
    return JSON.stringify(receipt, null, 2);
  }
  if (!compact || typeof compact !== 'object' || Array.isArray(compact))
    throw new Error('Semantic Slack output is unavailable');
  const interaction = compact.interaction ?? receipt?.interaction;
  const semantic = interaction?.mode === 'foreground' ? { ...compact, interaction } : compact;
  if (format === 'json') return JSON.stringify(compactJSON(semantic), null, 2);
  let text = renderText(semantic);
  const selectedWorkspace = scopedWorkspace(semantic);
  if (selectedWorkspace && workspaceScopedCommands.has(semantic.operation))
    text = `Workspace: ${shortInline(selectedWorkspace.name, 160) || '[name unavailable]'} (${selectedWorkspace.contextId})${semantic.workspaceSelection.switch.changed === true ? ' [switched]' : ''}\n\n${text}`;
  if (semantic.searchTranslation) {
    text += `\n\nEmoji query: ${shortInline(semantic.searchTranslation.requestedQuery, 160)} → ${shortInline(semantic.searchTranslation.submittedQuery, 200)}`;
  }
  return interaction?.mode === 'foreground'
    ? `${text}\n\nForeground interaction requested; no automatic retry.`
    : text;
}
