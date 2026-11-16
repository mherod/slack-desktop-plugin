# Slack Desktop

[![CI](https://github.com/mherod/slack-desktop-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/mherod/slack-desktop-plugin/actions/workflows/ci.yml)

A plugin for **Codex / ChatGPT and Claude Code** that works with the **Slack desktop app on macOS** through the macOS accessibility API. It drives the app you are already signed in to, so it needs no Slack API token, bot or workspace admin approval. Both use the same skill and bundled helper.

With this plugin, your assistant can:

- list, inspect and switch between signed-in workspaces
- list channels and DMs, and read messages, threads and channel members
- browse the workspace's channel and people directories
- search messages, optionally filtered by author
- read a channel or DM since a given date, or only one author's messages
- inspect attachments and read transcripts that already exist on audio or video
- save an attachment through Slack's own Download control
- send, edit or delete **your own** messages when you ask it to

It works in the background by default and doesn't take focus from the app you're using. Foreground mode is used only when you allow it for a specific command.

> [!IMPORTANT]
> The plugin never reacts to messages, uploads files, plays media, changes Slack settings or changes channel membership.

## Requirements

- macOS with the Slack desktop app running and signed in
- [Bun](https://bun.sh)
- Xcode Command Line Tools (`xcode-select --install`), used to compile the bundled Swift helper on first use
- Accessibility and input-event permissions for the app that runs your assistant, such as ChatGPT, Terminal, iTerm or your IDE

## Install

### Codex and ChatGPT desktop

From a local clone, register the marketplace and install the plugin:

```sh
codex plugin marketplace add /absolute/path/to/slack-desktop-plugin
codex plugin add slack-desktop@slack-desktop-plugin
```

Restart ChatGPT desktop and select **Slack Desktop** as the source in the Plugins Directory to find the plugin. Start a new chat after installation. Once these files are pushed, you can register the repository remotely instead:

```sh
codex plugin marketplace add mherod/slack-desktop-plugin
codex plugin add slack-desktop@slack-desktop-plugin
```

The host must support local command execution on the Mac running Slack. A cloud-only session cannot run this helper. Grant Accessibility and input-event permissions to the host running your assistant, then run the permission check below.

The portable `plugin.json`, `.codex-plugin/plugin.json` compatibility manifest and `.agents/plugins/marketplace.json` share the same bundled skill. See [OpenAI’s packaging guide](https://developers.openai.com/plugins/build/plugins) for marketplace support. Repository installation is separate from public Plugins Directory submission; this repository does not claim a public listing.

### Claude Code

```text
/plugin marketplace add mherod/slack-desktop-plugin
/plugin install slack-desktop@slack-desktop-plugin
```

## Quickstart

In either app, ask your assistant something like *"What's new in #general on Slack?"* or *"Search Slack for the deploy checklist"*. The `slack-desktop` skill loads when it's relevant.

You don't need to run anything yourself: your assistant calls the helper for you. To try the helper directly from a clone:

```sh
git clone https://github.com/mherod/slack-desktop-plugin.git
cd slack-desktop-plugin
bun skills/slack-desktop/scripts/slack.mjs permissions          # read-only access check
bun skills/slack-desktop/scripts/slack.mjs current-workspace    # first run compiles the Swift helper
```

The first command should print `Slack permissions: ready.` The second prints the workspace Slack is showing, followed by a suggested next command.

## Permissions

The first time you use it, the skill runs a read-only check:

```sh
bun skills/slack-desktop/scripts/slack.mjs permissions
```

If that check reports missing access, run `permissions --request`. This opens **System Settings → Privacy & Security → Accessibility**. Grant access to the app that runs your assistant, then run the check again. The helper never grants permissions itself.

## Usage

All commands go through one entrypoint, `bun skills/slack-desktop/scripts/slack.mjs <command>`. Run it with `--help` for the full reference. The commands are grouped below.

| Area | Commands |
|---|---|
| Setup and diagnosis | `permissions [--request]`, `inspect`, `inspect --ui [--filter=TEXT] [--limit=N] [--depth=N]` |
| Workspaces | `workspaces`, `current-workspace`, `switch-workspace TARGET` |
| Conversations | `channels`, `dms [--filter=TEXT]`, `dms --search=TEXT --allow-clipboard`, `browse-channels`, `browse-people` |
| Reading | `read-channel NAME`, `read-dm NAME\|@HANDLE\|group:ID`, `read-thread REF`, `members NAME`, `close-thread`, `close-members` |
| Search | `search QUERY` (Slack query syntax such as `in:channel` and `"exact phrase"` works) |
| Attachments | `read-media REF`, `read-transcript REF`, `save-media REF --output=PATH [--original]` |
| Your messages | `send TARGET --text=TEXT`, `edit REF --text=TEXT`, `delete REF --confirm-delete` |

A few examples:

```sh
S=skills/slack-desktop/scripts/slack.mjs
bun $S channels --pages=3
bun $S read-channel 'general' --since=2026-01-31
bun $S read-channel 'general' --from='Alex Example'
bun $S search 'deploy checklist' --pages=3 --format=json
bun $S read-thread 'C012EXAMPLE:1700000000.000001'
bun $S save-media 'F012EXAMPLE' --output="$HOME/Downloads/attachment.pdf"
bun $S send '#general' --text='Hello from Slack Desktop'
```

Every read prints references, such as `thread:REF` and `--before=REF` hints, that you can pass to the next command. [`SKILL.md`](skills/slack-desktop/SKILL.md) has the complete command guide and safety rules. [`references/output-format.md`](skills/slack-desktop/references/output-format.md) describes the output, pagination and limits.

## Configuration

There are no config files. Behaviour is set per command with these flags:

| Flag | Applies to | Default | Description |
|---|---|---|---|
| `--format=text\|json\|full-json` | all | `text` | Trimmed plain text, full captured text as JSON, or JSON with the native accessibility receipt and diagnostics |
| `--interaction=background\|foreground` | navigation, listing, search, transcript and save commands | `background` | `foreground` may bring Slack to the front once. Use it only when you allow it for that command |
| `--workspace=REF` | conversation, search, read, attachment and directory commands | current workspace | Exact workspace name, `workspace:DOMAIN` or current context ID. The command stops if Slack is showing a different workspace |
| `--pages=N` | `channels`, `dms`, reads, `search`, `read-transcript`, `members` | `1` | Collect 1–10 pages, with duplicates removed |
| `--before=REF` / `--after=REF` | conversation and thread reads | — | Continue from a reference printed by an earlier read |
| `--since=DATE` | `read-channel`, `read-dm` | — | `YYYY-MM-DD` or an ISO date-time. Pages back up to 10 pages |
| `--from=NAME` | `read-channel`, `read-dm`, `search` | — | Keep only messages by this author. Scans 5 pages by default |
| `--allow-clipboard` | `dms --search`, `read-dm` | off | Allows temporary clipboard use, with best-effort restore. Needed for `dms --search` and `read-dm group-name:…`, and lets a name or handle `read-dm` fall back to DM search |
| `--lock-timeout=SECONDS` | all | `30` | How long to wait for another running helper command to finish |
| `--max-seconds=N` | `members` | — | Time budget for collecting a channel's member list |

| Environment variable | Required | Default | Description |
|---|---|---|---|
| `SLACK_AX_PROFILE` | No | unset | `1` prints one line of accessibility read counts to stderr on exit. `sites` also lists them by call site. It never prints labels, values or identifiers |

The compiled helper is cached in `~/.cache/slack-desktop`. Delete that folder to force a rebuild.

## How it works

- `skills/slack-desktop/SKILL.md` is the skill entrypoint. It describes the commands, safety checks and output formats.
- `skills/slack-desktop/scripts/slack.mjs` is the Bun command-line wrapper. On first use it compiles the Swift sources in `scripts/` into a helper cached at `~/.cache/slack-desktop`.
- `skills/slack-desktop/references/` holds the detailed output contract, implementation notes and investigation logs.

Each read checks the workspace, conversation and message it is looking at before acting, and stops rather than guessing when what it sees is ambiguous. Only one helper command drives Slack at a time; others wait for the lock. Commands return short plain text by default. Add `--format=json` for structured output.

## Privacy

The helper runs locally and returns captured Slack content to the assistant session that requested it. That content is processed under your assistant provider’s data policies; this plugin does not operate a separate backend. Options that use the clipboard, such as `--allow-clipboard`, must be given explicitly on each command, and the helper restores your clipboard afterwards on a best-effort basis. Keep saved output out of shared repositories.

## Development

```sh
bun run test              # unit and native-harness tests
bun run check:manifests   # manifest versions, catalog paths and bundled assets
bun run validate          # additional Claude Code packaging validation
```

There are no dependencies to install. The tests drive the Swift helper against stubbed accessibility trees, so they need macOS and the Xcode Command Line Tools but not Slack or any permissions. CI runs the manifest check and the test suite on a hosted macOS runner for every push to `main` and every pull request.

When you release, bump the version in `plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `package.json` together. Keep the OpenAI interface metadata in the portable and compatibility manifests identical.

## Contributing

Report bugs and suggest changes in [GitHub issues](https://github.com/mherod/slack-desktop-plugin/issues). Include the command, a redacted error and steps to reproduce. **Never paste message content, names, conversation IDs or raw receipts into a public issue.**

Pull requests are welcome. Before opening one, run `bun run test` and `bun run validate`. Use made-up fixtures, like the `C012EXAMPLE` and `Alex Example` values in the existing tests, and never captured Slack data.

## Limitations

- macOS only. The helper depends on the Slack desktop app's accessibility tree, so a Slack update can change it. When the layout doesn't match, the helper stops and suggests `inspect --ui` for diagnosis.
- Only content Slack currently shows can be read. Pagination is bounded, and anything outside what was collected is reported as unknown.

## Licence

[MIT](LICENSE). The emoji shortcode map comes from [iamcal/emoji-data](https://github.com/iamcal/emoji-data) under its own licence: see [`references/emoji-data-LICENSE.txt`](skills/slack-desktop/references/emoji-data-LICENSE.txt).

This project is not affiliated with or endorsed by Slack Technologies.
