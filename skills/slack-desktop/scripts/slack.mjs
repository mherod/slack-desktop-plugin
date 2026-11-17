#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  compactOutput,
  applyAuthorFilter,
  applyDMFilter,
  applySince,
  withMessageRange,
  mediaObservationOutput,
} from './slack-output.mjs';
import { loadMediaReferences, rememberMediaReferences, resolveMedia } from './slack-read-media.mjs';
import { selectTranscriptCandidate, transcriptOutput } from './slack-transcript.mjs';
import { collectTranscriptPages } from './slack-transcript-pages.mjs';
import { runTranscript } from './slack-transcript-protocol.mjs';
import { saveMedia, prepareDestination } from './slack-save-runner.mjs';
import { paginateOutput, collectPages } from './slack-pagination.mjs';
import { collectSearchPages } from './slack-search-pages.mjs';
import { collectChannelPages, collectDMPages } from './slack-channel-pages.mjs';
import { collectDMSearchPages } from './slack-dm-search.mjs';
import { parseCLI, formatOutput } from './slack-format.mjs';
import { acquireLock, DEFAULT_LOCK_TIMEOUT } from './slack-lock.mjs';
import { compactUIOutput, compactUIObservation, formatUIOutput } from './slack-ui.mjs';
import { foregroundEvidence, membersMaxSeconds, nativeCommandArgs } from './slack-interaction.mjs';
import { normalizeSearchQuery, validateSearchQueryTranslation } from './slack-search-query.mjs';
import { compactWorkspaces } from './slack-workspaces.mjs';
import { compactThreadClose } from './slack-thread-close.mjs';
import { COMPOSE_OPERATIONS, compactCompose, normalizeMessageText } from './slack-compose.mjs';
import { compactMembersClose, stoppedMembersClose } from './slack-members-close.mjs';
import { compactMembers } from './slack-members.mjs';
import { compactDirectory, directoryOperations } from './slack-directory.mjs';
import { validateWorkspaceScope, applyWorkspaceScope } from './slack-workspace-scope.mjs';
import {
  SLACK_NATIVE_BUNDLE,
  PUBLISHER_NATIVE_BUNDLE,
  captureNativeBundle,
  buildNativeBundle,
} from './slack-native-build.mjs';

const usage =
  'Usage: bun slack.mjs [--format=text|json|full-json] [--interaction=background|foreground] [--lock-timeout=SECONDS] [--workspace=REF] send #CHANNEL|NAME|@HANDLE|group:ID|thread:REF --text=TEXT | edit REF --text=TEXT | delete REF --confirm-delete | inspect [--ui] | workspaces | current-workspace | switch-workspace TARGET | channels | dms [--search=TEXT --allow-clipboard] [--filter=TEXT] | read-channel NAME | read-dm NAME_OR_@HANDLE_OR_group:ID_OR_group-name:NAME [--allow-clipboard] | read-thread REF_OR_PERMALINK | close-thread | close-members | members NAME [--pages=N] [--max-seconds=N] | browse-channels [--pages=N] | browse-people [--pages=N] | read-media REF | read-transcript REF | save-media REF --output=PATH [--original] | search QUERY | channel NAME | permissions [--request]';
let format = 'text';
let interaction = 'background';
let interactionReceipt;
let searchTranslation;
let workspaceOperation;
let workspaceTarget;
let workspaceSelection;
let workspaceSwitchUncertainty = false;
let requestedOperation;
let membersCloseNativeStarted = false;
let membersCloseReceipt;
let reported = false;
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

function checkCancelled() {
  if (cancellation.signal.aborted)
    throw new Error('Slack helper cancelled; no further work started');
}

function workspaceEnvelopes(receipt, operation) {
  const keys = ['preflight', 'nativeResult'];
  if (operation === 'save-media')
    keys.push(
      'sourcePreflight',
      'viewerPreflight',
      'started',
      'publicationPreflight',
      'rejectedSourcePreflight',
      'rejectedViewerPreflight',
      'rejectedPublicationPreflight'
    );
  return [receipt, ...keys.map((key) => receipt?.[key]).filter(Boolean)];
}

function receiveWorkspaceScope(receipt, operation, code) {
  if (workspaceTarget === undefined) return;
  const envelopes = workspaceEnvelopes(receipt, operation);
  const evidence = envelopes.flatMap((value) => [value, value?.workspaceSelection]);
  if (
    evidence.some(
      (value) =>
        value?.workspaceSwitchMayHaveBeenRequested === true || value?.switchAttempted === true
    )
  )
    workspaceSwitchUncertainty = true;
  else if (
    workspaceSwitchUncertainty !== true &&
    !evidence.some((value) => value?.workspaceSwitchMayHaveBeenRequested === null) &&
    evidence.some((value) => value?.workspaceSwitchMayHaveBeenRequested === false)
  )
    workspaceSwitchUncertainty = false;
  const selection = validateWorkspaceScope(receipt, operation, workspaceTarget, { code });
  if (
    workspaceSelection?.status === 'ok' &&
    (selection.status !== 'ok' ||
      JSON.stringify(selection.workspace) !== JSON.stringify(workspaceSelection.workspace) ||
      selection.switch?.changed !== workspaceSelection.switch?.changed)
  )
    throw new Error('Workspace selection changed across command protocol receipts');
  workspaceSelection = selection;
  if (
    selection.switch?.attempted === true ||
    selection.workspaceSwitchMayHaveBeenRequested === true
  )
    workspaceSwitchUncertainty = true;
  else if (
    workspaceSwitchUncertainty !== true &&
    selection.workspaceSwitchMayHaveBeenRequested === false
  )
    workspaceSwitchUncertainty = false;
}

function renderScopedOutput(compact, selectedFormat = 'text', receipt = undefined) {
  if (workspaceTarget !== undefined) {
    if (compact) {
      compact =
        workspaceSelection?.status === 'ok'
          ? applyWorkspaceScope(compact, workspaceSelection)
          : { ...compact, ...(workspaceSelection ? { workspaceSelection } : {}) };
      compact.requestedWorkspace = workspaceTarget;
      compact.workspaceSwitchMayHaveBeenRequested = workspaceSwitchUncertainty;
    }
    if (receipt)
      receipt.workspaceResolution = workspaceSelection ?? {
        status: 'stopped',
        requested: workspaceTarget,
        workspaceSwitchMayHaveBeenRequested: workspaceSwitchUncertainty,
      };
    if (receipt && compact && receipt.resolution !== undefined) receipt.resolution = compact;
  }
  return formatOutput(compact, selectedFormat, receipt);
}

async function run(command, timeout, capture = false, onSpawn) {
  checkCancelled();
  const child = Bun.spawn(command, {
    stdout: capture ? 'pipe' : 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  });
  onSpawn?.();
  const output = capture ? new Response(child.stdout).text() : Promise.resolve('');
  const terminate = () => child.kill('SIGTERM');
  cancellation.signal.addEventListener('abort', terminate, { once: true });
  const timer = setTimeout(terminate, timeout);
  try {
    const code = await child.exited,
      text = await output;
    checkCancelled();
    if (!capture && code !== 0)
      throw Object.assign(new Error(`Build step exited ${code}`), { exitCode: code });
    return { code, text };
  } finally {
    clearTimeout(timer);
    cancellation.signal.removeEventListener('abort', terminate);
  }
}

try {
  let args,
    page,
    pages,
    maxSeconds,
    ui,
    lockTimeout,
    dmFilter,
    authorFilter,
    since,
    dmSearch,
    allowClipboard,
    output,
    originalRequired,
    text,
    confirmDelete,
    textTranslation;
  try {
    ({
      args,
      format,
      page,
      pages,
      maxSeconds,
      ui,
      lockTimeout,
      dmFilter,
      authorFilter,
      since,
      dmSearch,
      allowClipboard,
      output,
      originalRequired,
      interaction,
      workspaceTarget,
      text,
      confirmDelete,
    } = parseCLI(process.argv.slice(2)));
    if (text !== undefined) textTranslation = normalizeMessageText(text);
    requestedOperation = args[0];
  } catch (error) {
    format = error.format ?? format;
    throw Object.assign(error, { exitCode: 2 });
  }
  if (['workspaces', 'current-workspace', 'switch-workspace'].includes(args[0]))
    workspaceOperation = args[0];
  if (
    !(
      args.length === 1 &&
      [
        'inspect',
        'channels',
        'dms',
        'workspaces',
        'current-workspace',
        'close-thread',
        'close-members',
        'browse-channels',
        'browse-people',
        '--help',
        'permissions',
      ].includes(args[0])
    ) &&
    !(
      args.length === 2 &&
      [
        'search',
        'channel',
        'read-channel',
        'read-dm',
        'read-thread',
        'read-media',
        'read-transcript',
        'save-media',
        'switch-workspace',
        'members',
        'send',
        'edit',
        'delete',
      ].includes(args[0])
    ) &&
    !(args.length === 2 && args[0] === 'permissions' && args[1] === '--request')
  ) {
    throw Object.assign(new Error(usage), { exitCode: 2 });
  }
  if (args[0] === '--help') {
    const help = `${usage}\n\nDefault: trimmed plain text. --format=json: full text on this page.\n--format=full-json: complete native receipt and diagnostics.\nFlags may appear before or after the command; use -- before a literal flag-like query.\nMessage reads return up to ten records per page. Add --pages=N (1–10) to collect multiple pages, deduplicated and chronological.\nCollections continue older for channels/DMs, newer for threads, or follow an explicit --before/--after direction. Search --pages=N collects consecutive result pages in Slack result order, deduplicated by observed message links. They stop early on no progress or a guard failure.\nchannels accepts --pages=N for downward Home-sidebar captures. dms opens or reuses Slack’s DMs view and collects downward from its current list position, including conversations absent from Home’s sidebar. Both deduplicate conversation IDs; text stays capped at 30 entries and JSON retains all collected entries. dms preserves the unread toggle, labels active filters, omits message previews from listing records and supplies guarded read-dm hints for one-to-one/self conversations plus ID-bound group:ID hints for groups. --filter=TEXT matches literal text without case sensitivity against captured DM names and explicitly observed participant header labels after all requested pages are verified and deduplicated. It preserves Slack’s current text filter, unread toggle and navigation behavior. Omitting --filter or using --filter= applies no local restriction. Filter text is limited to 200 Unicode characters without control characters. Participant labels may be incomplete; message previews are never searched. No conversation is opened.\nFollow --before=REF or --after=REF hints to continue in the current view.\nConversation/thread paging uses loaded messages first, then a scoped background accessibility scroll; unexposed history remains unknown.\nDM names must be exact; use @handle to disambiguate an initial read. Follow a known group:ID reference to read a group DM. The helper reuses the exact current group or sidebar control, then looks up an absent row by exact ID with a 12-second Search lookup deadline. Missing, mixed or ambiguous navigation options stop; the final exact ID and group type must verify before messages are returned. Lookup does not consume message pages. Continuations retain the verified display name or group:ID plus the conversation cursor.\nread-thread accepts a thread.ref from output or an observed permalink; locate the message first with search/read-channel/read-dm.\nread-media REF inspects exposed attachment metadata using two fresh captures; file IDs resolve in the current workspace, and MESSAGE/mN references require a remembered unchanged source binding. Reread the source when a reference is missing or stale. It accepts no pagination flags, opens no viewer and reads no file bytes or transcripts.\nread-transcript REF reads an existing audio/video transcript after verifying the media reference. It never generates a transcript, plays media or presses transcript timestamps. Keep the source exposed; unsupported or generation-only media stops with guidance. Add --pages=N (1–10) to collect downward transcript captures with matching timestamp/text groups deduplicated. Omitted or --pages=1 keeps the single capture. Collection stops at no progress, its page/time budget or changed evidence; later failures retain verified segments with exit 1. Completeness remains unknown. No continuation or clipboard flags are accepted.\nsave-media REF --output=PATH [--original] saves one requested attachment through its verified Download control. If its source is absent in two stable captures, a recent same-workspace remembered reference can reopen the exact source conversation/message once before fresh attachment verification. Hidden file IDs need a remembered file association; positional refs keep their original order binding. Missing, stale, conflicting or changed exposed evidence stops. Reopening requires an exact observed sidebar-ID route or supported channel/group ID-picker destination, with the actual conversation ID verified afterward. Individual DMs without an observed route stop. Older-message lookup requires a securely matched Slack-generated scope; unsupported DM filters and unknown scopes stop with a reread hint. This bounded recovery does not promise universal archive access and never opens an external URL or guesses a replacement. It cannot follow viewer or Download input. Source navigation may change the Slack view/unread state; failure output retains sourceMayHaveReopened separately from viewer/Download uncertainty. It prefers a source-bound Slack private-file download route when available, otherwise labels the observed Download fallback. Only a source exposing no Download controls may open a supported viewer. Static images keep their source-verified gallery viewer and scoped Download button. Documents/file cards, audio and video can use an exact source-owned View file details button; supported inline video can use More actions followed only by View details. File details requires an independently known source file ID, retained source, active same-file card and actual scoped Download URL. Any source file-page URL must remain equal, and source/pane players must independently stay idle without Play input. File details uses exact-URL completion; --original additionally needs matching canonical page and Download-route evidence before action. The URL-less image-viewer route remains an explicit fallback; rejected source controls never trigger either route. On success or safe pre-Download refusal, the helper closes only its own verified viewer or pane. Failures retain viewer-opening and closure uncertainty separately. --original requires the verified private-file route and stops before Download if unavailable or ambiguous. The output file must not exist and its parent must already exist. Slack must already have a configured download directory. The helper verifies a fresh completed native download, then copies at most 256 MiB with quarantine metadata and SHA-256 verification; Slack retains its normal copy. The file-download route selects Slack file contents; equality to the originally uploaded bytes remains unknown. No pagination or clipboard flags are accepted. A timeout or cancellation can leave a native download running; inspect the receipt before retrying.\npermissions checks access; permissions --request explicitly requests setup. Default background commands preserve desktop focus.\n`;
    const extra =
      '\nWith dms --search=TEXT --allow-clipboard, results are Slack DMs autocomplete suggestions, separate from the recent-conversation list. People may lack an existing DM; conversation IDs and complete group membership remain unknown. --pages=N collects bounded suggestion captures and deduplicates repeated option identities. --filter=TEXT applies locally afterward. The unread toggle is preserved; its effect on suggestions is not verified. --search= clears the native query and returns the normal DMs list without clipboard permission. Omitting --search preserves normal listing behavior. Search text is limited to 200 Unicode characters without controls; whitespace-only queries are rejected.\nFollow an offered read-dm @handle, or read-dm --allow-clipboard group-name:EXACT_NAME for a group-name lookup. Group lookup stops unless one exact group suggestion and its final conversation ID verify; continuations use the resulting group:ID. Ordinary read-dm NAME or @handle also accepts --allow-clipboard to try direct DMs search only after normal lookup exposes zero exact matches. Exact ambiguity, guard failures and cursor reads do not trigger fallback. Direct search requires one exact person in a fully exposed suggestion set, then verifies the real conversation ID before messages. Missing exposed identity or a canonical return route stops; search discovery consumes no message pages. --allow-clipboard explicitly permits guarded temporary clipboard use and is required on each command that uses it.\n' +
      '\nConcurrent helpers wait up to 30 seconds before build or Slack work. --lock-timeout=SECONDS (0–120) changes this bound; 0 fails immediately if occupied. Cancellation stops waiting. Lock diagnostics report owner PID liveness only; no stale lock is removed automatically. Full JSON includes coordination wait timing.\ninspect --ui reports bounded accessibility controls without navigation. Optional --filter=TEXT (case-insensitive, max 200 Unicode characters), --limit=N (1–500, default 80), --depth=N (0–40, default 20); empty filter includes all controls. --prepare explicitly permits accessibility-tree initialization. UI-only options require inspect --ui.\n';
    const accessHelp =
      '\npermissions checks process trust, actual Slack AXRole/AXChildren reads and post-event access in the current execution context; it cannot identify a sandbox or prove that macOS settings need changing. ready requires all three; inspection-only means AX reads work without keyboard permission (exit 0). Missing trust or API-disabled returns exit 3; unavailable, absent or ambiguous Slack access returns exit 1. First verify the approved host execution context through the runner’s normal approval mechanism and rerun only read-only permissions there; stop if approval is denied. Only if access remains denied in that approved context should the user check macOS settings or explicitly run permissions --request. That setup command can request the prompt/open Accessibility settings even when trust is true but the API is disabled; it never grants access or resumes input. Normal commands still fail before initialization or activation on an unreadable target. Do not automatically escalate, switch to foreground or replay an earlier action.\n';
    const workspaceHelp =
      '\nworkspaces lists signed-in entries exposed by Slack’s workspace selector, with current markers and switch-workspace workspace:DOMAIN hints. It may open the verified selector in the background and closes only a selector it opened. close-thread closes the open thread side pane through its verified Close button and confirms it is gone; with no thread pane open it is a verified no-op. It accepts no arguments, pagination or workspace flag and never closes any other pane. A pre-existing selector remains open. When Slack shows a workspace rail instead, entries have names only and hints use switch-workspace NAME for unique names; the rail is never opened or closed. current-workspace reads the current client name and T/E context without opening the selector. Inactive context IDs remain unknown. switch-workspace TARGET accepts an exact unique name, observed workspace:DOMAIN reference, or the current context ID. It verifies the exact selected domain/name after one target press in the same Slack window; already-current is a no-op. Unknown or ambiguous targets stop with candidates; no Add/Join/sign-out controls are used. These commands accept no pagination, clipboard or filter flags. Background is default; only switch-workspace accepts explicit foreground mode. A switch can restore a workspace’s previous view and affect unread state. Inspect a failed switch before retrying.\n';
    const workspaceScopeHelp =
      '\n--workspace=REF selects an exact observed workspace before channels, dms, search, channel, read-channel, read-dm, read-thread, read-media, read-transcript or save-media. Use a workspace:DOMAIN hint, exact unique name or current observed context ID. Selection and the requested operation share one native process and activity lease; all pages and media/transcript checks stay pinned to the verified workspace/window. Missing or ambiguous selection stops before the requested action; later drift never triggers another switch. Scoped output includes selection evidence and workspace-bound read hints. Page budgets are unchanged; scope selection adds a bounded 15-second process allowance. A preserved pre-existing selector can block the read. The target workspace remains current; no restoration or replay occurs. inspect, permissions and workspace-management commands reject this option; read-media still rejects foreground mode.\n';
    const interactionHelp =
      '\nInteraction defaults to background. --interaction=foreground explicitly permits one native activation of the pinned running Slack app for navigation, search, transcript reading or saving. It retains the same source/destination verification and targeted input, stops on an observed app switch, and leaves focus where it is (no restoration). Use it as a deliberate fallback only after inspecting an earlier failure; commands are never automatically replayed. It cannot resolve ambiguous targets or changed attachment evidence. inspect, read-media, permissions and help remain non-activating and reject foreground mode. Each command requires its own flag; emitted navigation hints retain the background default.\n';
    const membersHelp =
      '\nmembers NAME collects the channel member list in the background. --max-seconds=N accepts one integer from 1 to 900 and sets its collection time limit: the default is 160 seconds without --pages, or 70 seconds with --pages. --pages=N still caps collection at 3N captures; whichever bound is reached first stops collection. Navigation, closure, workspace selection and lock waiting are outside the collection budget. Unknown or changed source evidence still stops the read.\n';
    const membersCloseHelp =
      '\nclose-members closes only the current channel’s verified Members dialog through its own enabled Close button, then confirms it is gone in the same workspace and channel. It does not read member rows, so it can recover after a member-name parsing refusal. With no dialog open it is a verified no-op; unrelated dialogs, another tab, ambiguous controls or changed source evidence stop without a close. It accepts output formats and lock timeout, but no target, workspace, pagination, clipboard or foreground flag. A stopped close preserves possible input and dialog state; inspect before another request.\n';
    console.log(
      format === 'text'
        ? `${help}${extra}${workspaceHelp}${workspaceScopeHelp}${interactionHelp}${accessHelp}${membersHelp}${membersCloseHelp}`.trimEnd()
        : JSON.stringify(
            {
              usage,
              help:
                help +
                extra +
                workspaceHelp +
                workspaceScopeHelp +
                interactionHelp +
                accessHelp +
                membersHelp +
                membersCloseHelp,
            },
            null,
            2
          )
    );
    process.exit(0);
  }
  if (process.platform !== 'darwin')
    throw Object.assign(new Error('Slack desktop helper requires macOS'), { exitCode: 2 });
  if (args[0] === 'search') {
    try {
      searchTranslation = normalizeSearchQuery(args[1]);
      if (searchTranslation) args = [args[0], searchTranslation.submittedQuery];
    } catch (error) {
      throw Object.assign(error, { exitCode: 2 });
    }
  }
  if (args[0] === 'save-media') await prepareDestination(output);
  const cache = path.join(homedir(), '.cache', 'slack-desktop');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  // One lease spans source capture, compilation, native work and formatting.
  const lease = await acquireLock(path.join(cache, 'active.lock'), {
    operation: args[0],
    timeoutSeconds: lockTimeout ?? DEFAULT_LOCK_TIMEOUT,
    signal: cancellation.signal,
  });
  try {
    checkCancelled();
    const nativeBundle = await captureNativeBundle(SLACK_NATIVE_BUNDLE, { checkCancelled });
    const binary = await buildNativeBundle(nativeBundle, cache, { run, checkCancelled });
    const membersSeconds = membersMaxSeconds({ args, maxSeconds, pages });
    const commandArgs = nativeCommandArgs({
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
    });
    // members and the directory reads scroll lazily loaded lists by default.
    const extendedRuntime =
      pages > 1 ||
      ['members', 'browse-channels', 'browse-people'].includes(args[0]) ||
      args[0] === 'read-media' ||
      // A thread whose source is no longer on screen is reopened by conversation ID.
      args[0] === 'read-thread' ||
      // A plain read first scrolls a scrolled-back conversation to its newest messages.
      ['read-channel', 'read-dm'].includes(args[0]) ||
      // Composition navigates, acts once and then waits for verification.
      COMPOSE_OPERATIONS.has(args[0]) ||
      (dmSearch !== undefined && dmSearch !== '') ||
      (args[0] === 'read-dm' && allowClipboard);
    const mediaCache = path.join(cache, 'media-references.json');
    let code, text, transcriptContext, saved;
    if (workspaceTarget !== undefined) workspaceSwitchUncertainty = null;
    if (args[0] === 'save-media') {
      const publisherBundle = await captureNativeBundle(PUBLISHER_NATIVE_BUNDLE, {
        checkCancelled,
      });
      const publisher = await buildNativeBundle(publisherBundle, cache, { run, checkCancelled });
      saved = await saveMedia({
        binary,
        publisher,
        requested: args[1],
        output,
        originalRequired,
        interaction,
        workspaceTarget,
        mediaCache,
        statePath: path.join(
          homedir(),
          'Library',
          'Application Support',
          'Slack',
          'storage',
          'root-state.json'
        ),
        signal: cancellation.signal,
      });
      code = saved.code;
      text = JSON.stringify(saved.receipt);
    } else if (args[0] === 'read-transcript') {
      const command = [binary, ...commandArgs];
      const captured = await runTranscript(command, {
        signal: cancellation.signal,
        ...(workspaceTarget !== undefined ? { timeoutMs: 105000 } : {}),
        select: async (preflight) => {
          receiveWorkspaceScope(preflight, args[0], 0);
          if (workspaceTarget !== undefined && workspaceSelection?.status !== 'ok')
            throw new Error('Requested workspace did not verify before transcript selection');
          if (
            preflight.operation !== 'read-transcript' ||
            preflight.requested !== args[1] ||
            !Array.isArray(preflight.observations) ||
            preflight.observations.length !== 2
          )
            throw new Error('Transcript preflight does not match the requested reference');
          const media = resolveMedia(
            {
              ...preflight,
              operation: 'read-media',
              observations: preflight.observations.map(mediaObservationOutput),
            },
            args[1],
            await loadMediaReferences(mediaCache)
          );
          const selected = selectTranscriptCandidate(preflight, media);
          return { token: selected.token, context: media };
        },
      });
      code = captured.code;
      text = JSON.stringify(captured.receipt);
      transcriptContext = captured.context;
    } else {
      if (args[0] === 'switch-workspace') workspaceSwitchUncertainty = null;
      ({ code, text } = await run(
        [binary, ...commandArgs],
        // Member collection keeps its requested budget plus navigation/closure time.
        (membersSeconds !== undefined
          ? (membersSeconds + 20) * 1000
          : extendedRuntime
            ? 90000
            : 30000) + (workspaceTarget !== undefined ? 15000 : 0),
        true,
        () => {
          if (args[0] === 'close-members') membersCloseNativeStarted = true;
        }
      ));
    }
    let receipt;
    try {
      receipt = JSON.parse(text);
    } catch {
      throw new Error(
        `Helper returned no valid receipt (exit ${code}); inspect live state before retrying`
      );
    }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
      throw new Error('Helper returned an invalid receipt object');
    if (args[0] === 'close-members') membersCloseReceipt = receipt;
    let workspaceScopeError;
    if (workspaceTarget !== undefined) {
      try {
        receiveWorkspaceScope(receipt, args[0], code);
        if (workspaceSelection.status !== 'ok')
          workspaceScopeError = workspaceSelection.error ?? 'Requested workspace did not verify';
        // A failed final pin can retain raw pages for diagnosis. Do not let a
        // partial-result collector turn those diagnostics into verified content.
        for (const frame of workspaceEnvelopes(receipt, args[0])) {
          if (!frame || workspaceScopeError) continue;
          if (frame.workspaceScopeError !== undefined)
            workspaceScopeError = String(frame.workspaceScopeError);
          else if (
            !frame.workspaceScope &&
            [
              'content',
              'observations',
              'pages',
              'batch',
              'searchPages',
              'transcriptPages',
              'transcript',
            ].some((key) => frame[key] !== undefined)
          )
            workspaceScopeError =
              'Captured content has no fresh selected workspace/window verification';
        }
      } catch (error) {
        workspaceScopeError = error.message;
      }
    }
    if (interaction === 'foreground') {
      interactionReceipt = foregroundEvidence(receipt);
      receipt.interaction = interactionReceipt;
    }
    receipt.coordination = { waitedMs: lease.waitedMs, timeoutSeconds: lease.timeoutSeconds };
    if (args[0] === 'switch-workspace') {
      workspaceSwitchUncertainty =
        receipt.switchAttempted === true || receipt.workspaceSwitchMayHaveBeenRequested === true
          ? true
          : receipt.workspaceSwitchMayHaveBeenRequested === false
            ? false
            : null;
    }
    if (searchTranslation) {
      receipt.searchTranslation = searchTranslation;
      validateSearchQueryTranslation(receipt, searchTranslation.requestedQuery);
    }
    if (workspaceScopeError) {
      const compact = {
        ...(saved
          ? saved.compact
          : receipt.operation === 'permissions' || receipt.status === 'permission-required'
            ? compactOutput(receipt, 'permissions')
            : {}),
        status: 'stopped',
        operation: receipt.operation === 'permissions' ? 'permissions' : args[0],
        error: workspaceScopeError,
        next:
          receipt.next ??
          'Inspect current-workspace before another request; no command is replayed automatically.',
      };
      receipt.status = 'stopped';
      receipt.resolution = compact;
      process.exitCode = code || 1;
      const rendered = renderScopedOutput(compact, format, receipt);
      if (format === 'text') console.error(rendered);
      else console.log(rendered);
      reported = true;
    } else if (
      ['workspaces', 'current-workspace', 'switch-workspace'].includes(args[0]) &&
      receipt.operation !== 'permissions'
    ) {
      let compact;
      try {
        compact = compactWorkspaces(receipt, args[0], args[1]);
        process.exitCode = code || (compact.status === 'ok' ? 0 : 1);
      } catch (error) {
        compact = {
          schemaVersion: 1,
          operation: args[0],
          status: 'stopped',
          error: error.message,
          workspaceSwitchMayHaveBeenRequested:
            args[0] === 'switch-workspace' ? workspaceSwitchUncertainty : false,
          next: 'Inspect current-workspace before another switch; no action is replayed automatically.',
        };
        receipt.status = 'stopped';
        process.exitCode = code || 1;
      }
      receipt.resolution = compact;
      const rendered = renderScopedOutput(compact, format, receipt);
      if (process.exitCode && format === 'text') console.error(rendered);
      else console.log(rendered);
      reported = true;
    } else if (directoryOperations.has(args[0]) && receipt.operation !== 'permissions') {
      let compact;
      try {
        compact = compactDirectory(receipt, args[0]);
        process.exitCode = code || (compact.status === 'ok' ? 0 : 1);
      } catch (error) {
        compact = {
          schemaVersion: 1,
          operation: args[0],
          status: 'stopped',
          error: error.message,
          next: 'Inspect the current Slack view before another request; no input is replayed.',
        };
        receipt.status = 'stopped';
        process.exitCode = code || 1;
      }
      receipt.resolution = compact;
      const rendered = renderScopedOutput(compact, format, receipt);
      if (process.exitCode && format === 'text') console.error(rendered);
      else console.log(rendered);
      reported = true;
    } else if (args[0] === 'members' && receipt.operation !== 'permissions') {
      let compact;
      try {
        compact = compactMembers(receipt, args[1]);
        process.exitCode = code || (compact.status === 'ok' ? 0 : 1);
      } catch (error) {
        compact = {
          schemaVersion: 1,
          operation: 'members',
          status: 'stopped',
          requested: args[1],
          error: error.message,
          next: 'Inspect the current Slack view before another request; no input is replayed.',
        };
        receipt.status = 'stopped';
        process.exitCode = code || 1;
      }
      receipt.resolution = compact;
      const rendered = renderScopedOutput(compact, format, receipt);
      if (process.exitCode && format === 'text') console.error(rendered);
      else console.log(rendered);
      reported = true;
    } else if (args[0] === 'close-members' && receipt.operation !== 'permissions') {
      let compact;
      try {
        compact = compactMembersClose(receipt, { code });
        process.exitCode = code || (compact.status === 'ok' ? 0 : 1);
      } catch (error) {
        compact = stoppedMembersClose(receipt, error.message);
        receipt.status = 'stopped';
        process.exitCode = code || 1;
      }
      receipt.resolution = compact;
      const rendered = renderScopedOutput(compact, format, receipt);
      if (process.exitCode && format === 'text') console.error(rendered);
      else console.log(rendered);
      reported = true;
    } else if (COMPOSE_OPERATIONS.has(args[0]) && receipt.operation !== 'permissions') {
      let compact;
      try {
        compact = compactCompose(receipt, args[0], args[1]);
        process.exitCode = code || (compact.status === 'ok' ? 0 : 1);
      } catch (error) {
        compact = {
          schemaVersion: 1,
          operation: args[0],
          requested: args[1],
          status: 'stopped',
          error: error.message,
          actionMayHaveOccurred: null,
          next: 'Read the conversation before any retry; nothing is replayed automatically.',
        };
        receipt.status = 'stopped';
        process.exitCode = code || 1;
      }
      if (textTranslation?.substitutions.length) compact.textTranslation = textTranslation;
      receipt.resolution = compact;
      const rendered = renderScopedOutput(compact, format, receipt);
      if (process.exitCode && format === 'text') console.error(rendered);
      else console.log(rendered);
      reported = true;
    } else if (args[0] === 'close-thread' && receipt.operation !== 'permissions') {
      let compact;
      try {
        compact = compactThreadClose(receipt);
        process.exitCode = code || (compact.status === 'ok' ? 0 : 1);
      } catch (error) {
        compact = {
          schemaVersion: 1,
          operation: 'close-thread',
          status: 'stopped',
          error: error.message,
          closeMayHaveBeenRequested: null,
          next: 'Inspect the current Slack view before another request; no close is replayed.',
        };
        receipt.status = 'stopped';
        process.exitCode = code || 1;
      }
      receipt.resolution = compact;
      const rendered = renderScopedOutput(compact, format, receipt);
      if (process.exitCode && format === 'text') console.error(rendered);
      else console.log(rendered);
      reported = true;
    } else if (saved) {
      const rendered = renderScopedOutput(saved.compact, format, receipt);
      if (code !== 0 && format === 'text') console.error(rendered);
      else console.log(rendered);
      reported = true;
      process.exitCode = code;
    } else if (['read-media', 'read-transcript'].includes(args[0])) {
      let compact;
      try {
        if (
          args[0] === 'read-transcript' &&
          pages > 1 &&
          transcriptContext &&
          receipt.phase === 'result'
        ) {
          // A later native guard failure still carries independently verified
          // earlier pages. Validate those before rendering a partial result.
          compact = collectTranscriptPages(receipt, transcriptContext, pages);
          if (code !== 0 && compact.status === 'ok')
            throw new Error('Successful transcript collection conflicts with native exit status');
          if (compact.status === 'partial') process.exitCode = code || 1;
        } else if (code !== 0 || receipt.error) {
          compact = compactOutput(receipt, args[0], args[1]);
          process.exitCode = code || 1;
        } else if (args[0] === 'read-transcript') {
          if (pages > 1) throw new Error('Verified transcript collection receipt is missing');
          compact = transcriptOutput(receipt, transcriptContext);
        } else {
          if (
            receipt.operation !== 'read-media' ||
            receipt.requested !== args[1] ||
            !Array.isArray(receipt.observations) ||
            receipt.observations.length !== 2
          )
            throw new Error('Media capture does not match the requested reference');
          compact = resolveMedia(
            {
              ...receipt,
              observations: receipt.observations.map(mediaObservationOutput),
            },
            args[1],
            await loadMediaReferences(mediaCache)
          );
        }
      } catch (error) {
        compact = {
          status: 'stopped',
          operation: args[0],
          requested: args[1],
          error: error.message,
          next: 'Reread the source with read-channel, read-dm, read-thread or search, then follow its fresh media/transcript hint. Use inspect --ui for unexpected UI state.',
        };
        process.exitCode = code || 1;
      }
      receipt.resolution = compact;
      receipt.status = compact.status ?? 'ok';
      const output = renderScopedOutput(compact, format, receipt);
      if (process.exitCode && format === 'text') console.error(output);
      else console.log(output);
      reported = true;
    } else {
      // Remember only verified metadata digests, under the same activity lease.
      // Diagnostics remain available if the current UI has no semantic extractor.
      if (
        code === 0 &&
        ['inspect', 'channel', 'search', 'read-channel', 'read-dm', 'read-thread'].includes(args[0])
      ) {
        try {
          const frames = receipt.pages ?? [receipt];
          const compacts = frames.map((frame) =>
            compactOutput(
              frame,
              args[0],
              args[0] === 'read-thread' ? frame.target?.requestedURL : args[1]
            )
          );
          await rememberMediaReferences(mediaCache, compacts);
          receipt.mediaReferences = { status: 'remembered' };
        } catch (error) {
          receipt.mediaReferences = { status: 'unavailable', reason: error.message };
        }
      }
      const localSelection = args[0] === 'dms' && dmFilter !== undefined;
      const nativeSearch = args[0] === 'dms' && dmSearch !== undefined;
      if (format === 'full-json' && !localSelection && !nativeSearch) {
        // Diagnostics must remain available even when semantic extraction does not
        // recognize the current UI. Preserve the native receipt and exit status.
        console.log(renderScopedOutput(null, format, receipt));
        reported = true;
        process.exitCode = code;
      } else {
        let compact;
        try {
          if (ui && code === 0) {
            compact = compactUIOutput(receipt, ui);
          } else if (nativeSearch && dmSearch !== '' && receipt.searchPages?.length > 0) {
            compact = collectDMSearchPages(receipt, dmSearch, pages ?? 1);
          } else if (receipt.batch) {
            if (receipt.batch.requestedPages !== pages || receipt.operation !== args[0])
              throw new Error('Collection receipt does not match the requested command');
            compact =
              args[0] === 'search'
                ? collectSearchPages(receipt, args[1])
                : args[0] === 'channels'
                  ? collectChannelPages(receipt)
                  : args[0] === 'dms'
                    ? collectDMPages(receipt, { dmSearch })
                    : collectPages(receipt.pages, receipt.batch, receipt, (frame, index) => {
                        if (frame.operation !== args[0] || frame.pid !== receipt.pid)
                          throw new Error('Slack process or operation changed during collection');
                        const query =
                          index === 0
                            ? args[1]
                            : args[0] === 'read-thread'
                              ? frame.target?.requestedURL
                              : frame.target?.requested;
                        return {
                          compact: compactOutput(frame, args[0], query),
                          nativePage: frame.pagination,
                        };
                      });
          } else {
            compact = compactOutput(receipt, args[0], args[1], { dmSearch });
            if (code === 0 && receipt.pagination)
              compact = paginateOutput(compact, receipt.pagination);
          }
          if (localSelection && Array.isArray(compact.dms)) {
            if (receipt.operation !== 'dms')
              throw new Error('Local DM matching receipt operation changed');
            compact = applyDMFilter(compact, dmFilter);
          }
          compact = withMessageRange(compact);
          if (since !== undefined && Array.isArray(compact.messages))
            compact = applySince(compact, since);
          if (authorFilter !== undefined && Array.isArray(compact.messages))
            compact = applyAuthorFilter(compact, authorFilter);
          if (compact.status === 'partial') process.exitCode = 1;
          if (receipt.mediaReferences?.status === 'unavailable' && compact.coverage)
            compact.coverage.warnings = [
              ...(compact.coverage.warnings ?? []),
              'Media reference bindings could not be retained; reread the source before using positional read-media references.',
            ];
          if (nativeSearch && !compact.coverage?.search && code === 0)
            throw new Error('The requested Slack DMs search was not verified');
          if (
            nativeSearch &&
            dmSearch !== '' &&
            compact.dms &&
            compact.coverage?.source !== 'dms-search-autocomplete'
          )
            throw new Error('Nonempty DMs search did not return autocomplete suggestions');
        } catch (error) {
          compact = {
            status: 'stopped',
            operation: args[0],
            error: error.message,
            next: 'Inspect current Slack state with --format=full-json; no partial content returned. Do not replay navigation blindly.',
          };
          process.exitCode = 1;
        }
        if (nativeSearch) {
          receipt.searchVerification = {
            source: 'wrapper',
            requestedQuery: dmSearch,
            status: compact.coverage?.search
              ? compact.status === 'partial'
                ? 'partial'
                : 'verified'
              : 'unavailable',
            ...(compact.error ? { error: compact.error } : {}),
          };
        }
        if (localSelection) {
          const match = compact.coverage?.match;
          receipt.selection = match
            ? {
                source: 'wrapper',
                mode: 'local',
                status: compact.status === 'partial' ? 'partial' : 'ok',
                ...match,
                ...(compact.coverage?.source === 'dms-search-autocomplete'
                  ? { matchedKeys: compact.dms.map((dm) => dm.suggestionKey) }
                  : { matchedIds: compact.dms.map((dm) => dm.id) }),
              }
            : {
                source: 'wrapper',
                mode: 'local',
                status: 'unavailable',
                query: dmFilter,
                error: compact.error ?? 'No verified DM records were available for local matching',
              };
        }
        // After-error observations describe a later UI state, never the cause. An
        // invalid diagnostic cannot replace the original error or verified prefix.
        if (
          receipt.observation &&
          (code !== 0 || ['stopped', 'partial'].includes(compact.status))
        ) {
          try {
            compact.observation = compactUIObservation(receipt.observation);
          } catch {
            /* Keep the original result if optional diagnostics cannot verify. */
          }
        }
        if (searchTranslation) {
          compact.searchTranslation = searchTranslation;
          validateSearchQueryTranslation(compact, searchTranslation.requestedQuery);
        }
        const output =
          ui && code === 0 && compact.status !== 'stopped'
            ? formatUIOutput(compact, format, receipt)
            : renderScopedOutput(compact, format, receipt);
        if (format === 'text' && (code !== 0 || ['stopped', 'partial'].includes(compact.status)))
          console.error(output);
        else console.log(output);
        reported = true;
        if (code !== 0) process.exitCode = code;
      }
    }
  } finally {
    await lease.release();
  }
} catch (error) {
  const detail = error.message ?? String(error);
  const failure = {
    ...(requestedOperation === 'close-members'
      ? stoppedMembersClose(
          membersCloseReceipt ?? {
            closeMayHaveBeenRequested: membersCloseNativeStarted ? null : false,
          },
          detail
        )
      : { status: 'stopped', error: detail }),
    ...(interaction === 'foreground'
      ? { interaction: interactionReceipt ?? foregroundEvidence(null) }
      : {}),
    ...(error.lock ? { lock: error.lock } : {}),
    ...(error.next ? { next: error.next } : {}),
    ...(searchTranslation ? { searchTranslation } : {}),
    ...(workspaceOperation ? { operation: workspaceOperation } : {}),
    ...(workspaceOperation === 'switch-workspace' || workspaceTarget !== undefined
      ? { workspaceSwitchMayHaveBeenRequested: workspaceSwitchUncertainty }
      : {}),
  };
  if (!reported) {
    const output = renderScopedOutput(failure, format, failure);
    if (format === 'text') console.error(output);
    else console.log(output);
  } else console.error(renderScopedOutput(failure));
  process.exitCode = error.exitCode || 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
