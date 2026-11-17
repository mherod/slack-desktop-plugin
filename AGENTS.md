# Agent guide

## Skill source of truth

`skills/slack-desktop` is the only copy of the skill. Edit it here directly; there is no upstream copy or export step.

- **DO** keep real Slack data out of the repo. Everything here is public, and no redaction runs before commit. Fixtures, docs, tests, commit messages and issues use example workspaces, channels, people, conversation IDs and message text, never ones observed in a live session.
- **DO** bump the patch version in all five manifests (`package.json`, `plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`) with every change under `skills/`, then run `bun run check:manifests`. Installed copies compare that version, so an unbumped change never reaches them.
- **Check:** `bun run check:manifests` and `bun test skills/slack-desktop/scripts --parallel=4` pass before every commit that touches `skills/`.

## Developing the skill

Paths below are relative to `skills/slack-desktop`.

### Layout variants

Slack ships different accessibility structures to different clients and workspaces at the same time. Observed pairs: picker options as `AXStaticText` or `AXMenuItem`; the DMs list under `c-scrollbar__hider` or directly under `p-recent_page`; the channel outline under `c-scrollbar__hider` or directly under `p-channel_sidebar`; the welcome row with `p-message_pane__foreword__avatars` or `p-new_im_foreword-entity__*` buttons; the workspace switcher as the `p-account_switcher` pop-up or the `p-team_sidebar__teams` rail.

- **DO** add each newly observed structure as an additional accepted shape beside the existing one. **DON'T** replace the old shape; another client still uses it.
- **DO** keep the ownership and identity checks around the relaxed shape (parent chain, canonical IDs, current markers). Accept a known alternative, never an arbitrary one.
- **DO** change both verification layers together: the native check in `scripts/slack.swift` or `scripts/native/*.swift`, and the independent JS check in `scripts/slack-output.mjs`, `scripts/slack-workspaces.mjs` or `scripts/slack-workspace-scope.mjs`. A one-sided change moves the stop message to the other layer.
- **DO** capture the live structure first with `bun scripts/slack.mjs inspect --ui --filter=CLASS --format=json`, and confirm the fix with the real command afterwards.
- **Check:** tests cover both shapes, and the `Passed N native Slack guard checks` count in `scripts/slack-native.test.mjs` matches the new total.

Activation varies too: some builds act on AXPress, while others return success and do nothing, or omit AXPress on sidebar rows, yet open on a focused Return. For navigation, use `activate(...)` in `scripts/slack.swift` with an after-state predicate, not a bare `press`. **DON'T** add the focus-Return fallback to Save, Delete or other content-changing controls without a separate design. `Send now` has one: `sendMessage` in `scripts/native/SlackCompose.swift` calls `focusReturnActivation` on the exact button only after AXPress leaves the composer full for 2 seconds, re-checks `sendFallbackBlocker` (same editor and button, exact text, no new row since the press, same window, no modal) immediately before the key, and clears its own unsent text on terminal failure.

A structure without an identifier stays without one: workspace rail entries have `domain: null` and no `workspace:DOMAIN` reference, are matched by exact unique name, and same-name entries stop as ambiguous.

### Accessibility read cost

Round trips to Slack are about 95% of a command's wall time; JS parsing and formatting is under 0.1 s. Measure with `SLACK_AX_PROFILE=1 bun scripts/slack.mjs COMMAND`, which prints one `ax-profile` line (counts and milliseconds only) to stderr.

- **DO** read several attributes of one element with `liveAttrs` (one round trip) instead of repeated `attr`/`string` calls. `contentSnapshot` reads each node once through `CaptureRead`.
- **DO** rely on the walk memo for `AXRole`, `AXDOMClassList` and `AXDOMIdentifier` in the filter that directly follows `tree(...)`: the walk already read them. Entries last 0.2 s and are dropped before any action, key input or wait.
- **DO** wait with `axPause(until:)` or `settle()`, and call `AXWalkMemo.invalidate()` before any new call that can change Slack. **DON'T** call `RunLoop.current.run` directly.
- **DO** use `liveAttr` where a check must observe Slack at that instant (re-reads named "fresh", parent comparisons). **DON'T** add `AXChildren`, values or labels to the memo: structure and content are always read live.
- **DO** find a subtree's owner from one walk with `Node.parent` (the index it was first reached from) instead of walking each candidate subtree again; walk a candidate on its own only when its first-reached chain does not decide it. `mainClient` does this, and reuses the proven client for the same 0.2 s quiet interval after a live role and URL check.
- **Check:** `walk`, `batch`, `read` and `memo` counts in the profile line before and after a change; `SLACK_AX_PROFILE=sites` adds one `ax-walk FILE:LINE walks=N nodes=N` line per `tree()` call site.

### Before committing

- **DO** build after every Swift edit: `bun scripts/slack.mjs permissions` compiles the helper, and `bun test scripts/slack-native.test.mjs` compiles the guard bundle. No pre-commit hook type-checks Swift here, so a compile error only shows up in CI or as `Build step exited 1` on every command.
- **DON'T** exercise a real workspace switch or open conversations as a routine check; both can change the user's view and unread state. Use an already-current target for a no-op switch.

## Public copy

Applies to the GitHub repo description, README intro, plugin manifest descriptions (`plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) and marketplace listings.

- **DO** lead with the main selling point: the plugin needs no approved access to the Slack workspace. It drives the Slack desktop app the user is already signed in to, so there is no bot, integration, API token or admin sign off.
- **DO** keep the tone loose and plain, with at most one emoji. Rewording the factual version is the goal, not adding jokes or metaphors.
- **DON'T** use dashes as punctuation (em dash `—`, en dash `–` or a spaced hyphen). Split the sentence or use a comma instead. Check with `gh repo view --json description --jq .description | grep -c '[-—–]'`, which must print `0`.
- **DON'T** write "no Slack app" or "no app to install". It reads as not needing the Slack desktop app, which is a hard requirement. Say "no bot" or "no integration" instead.
- **DON'T** imply the plugin acts on its own. It sends, edits or deletes the user's own messages only when asked, and never reacts, uploads, plays media, changes settings or changes channel membership.
