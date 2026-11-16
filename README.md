# Slack Desktop plugin for Claude Code

A Claude Code plugin for working with the **Slack desktop app on macOS** through the macOS accessibility API. It drives the app you are already signed in to, so it needs no Slack API token, bot or workspace admin approval.

With this plugin, Claude can:

- list, inspect and switch between signed-in workspaces
- list channels and DMs, and read messages, threads and channel members
- search messages, optionally filtered by author or date
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
- Accessibility and input-event permissions for the app that runs Claude Code, such as Terminal, iTerm or your IDE

## Install

```text
/plugin marketplace add mherod/slack-desktop-plugin
/plugin install slack-desktop@slack-desktop-plugin
```

Then ask Claude something like *"What's new in #general on Slack?"* or *"Search Slack for the deploy checklist"*. The `slack-desktop` skill loads when it's relevant.

## Permissions

The first time you use it, the skill runs a read-only check:

```sh
bun skills/slack-desktop/scripts/slack.mjs permissions
```

If that check reports missing access, run `permissions --request`. This opens **System Settings → Privacy & Security → Accessibility**. Grant access to the app that runs Claude Code, then run the check again. The helper never grants permissions itself.

## How it works

- `skills/slack-desktop/SKILL.md` is the skill entrypoint. It describes the commands, safety checks and output formats.
- `skills/slack-desktop/scripts/slack.mjs` is the Bun command-line wrapper. On first use it compiles the Swift sources in `scripts/` into a helper cached at `~/.cache/slack-desktop`.
- `skills/slack-desktop/references/` holds the detailed output contract, implementation notes and investigation logs.

Each read checks the workspace, conversation and message it is looking at before acting, and stops rather than guessing when what it sees is ambiguous. Commands return short plain text by default. Add `--format=json` for structured output.

## Privacy

Message content stays on your machine and is returned only to the Claude session that asked for it. Options that use the clipboard, such as `--allow-clipboard`, must be given explicitly on each command, and the helper restores your clipboard afterwards. Keep saved output out of shared repositories.

## Development

```sh
bun test skills/slack-desktop/scripts
claude plugin validate .
```

Some native tests need the same accessibility permissions as the helper.

## Limitations

- macOS only. The helper depends on the Slack desktop app's accessibility tree, so a Slack update can change it. When the layout doesn't match, the helper stops and suggests `inspect --ui` for diagnosis.
- Only content Slack currently shows can be read. Pagination is bounded, and anything outside what was collected is reported as unknown.

## Licence

[MIT](LICENSE). The emoji shortcode map comes from [iamcal/emoji-data](https://github.com/iamcal/emoji-data) under its own licence: see [`references/emoji-data-LICENSE.txt`](skills/slack-desktop/references/emoji-data-LICENSE.txt).

This project is not affiliated with or endorsed by Slack Technologies.
