# Agent guide

## Skill source of truth

`skills/slack-desktop` here is a redacted copy of `slack-desktop` in the private `mherod/skills` repo (installed at `~/.claude/skills/slack-desktop`). Syncs pull from that copy into this repo, so a change made only here is overwritten by the next sync.

- **DO** land every script, test or SKILL.md change in both repos, then run `bun test slack-desktop/scripts --parallel=4` from the skills repo root and `bun test skills/slack-desktop/scripts --parallel=4` here.
- **DO** port with `git diff <base> <sha> -- skills/slack-desktop | git -C ~/.claude/skills apply -p2`, then copy back any formatting the skills repo pre-commit applies so both copies match.
- **Check:** `diff -rq ~/.claude/skills/slack-desktop/scripts skills/slack-desktop/scripts` lists only the redacted test fixtures (`slack-compose.test.mjs`, `slack-members-close.test.mjs`, `slack-save-runner.test.mjs`, `slack-workspace-cli.test.mjs`) and this repo's `lib/`.

## Public copy

Applies to the GitHub repo description, README intro, plugin manifest descriptions (`plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) and marketplace listings.

- **DO** lead with the main selling point: the plugin needs no approved access to the Slack workspace. It drives the Slack desktop app the user is already signed in to, so there is no bot, integration, API token or admin sign off.
- **DO** keep the tone loose and plain, with at most one emoji. Rewording the factual version is the goal, not adding jokes or metaphors.
- **DON'T** use dashes as punctuation (em dash `—`, en dash `–` or a spaced hyphen). Split the sentence or use a comma instead. Check with `gh repo view --json description --jq .description | grep -c '[-—–]'`, which must print `0`.
- **DON'T** write "no Slack app" or "no app to install". It reads as not needing the Slack desktop app, which is a hard requirement. Say "no bot" or "no integration" instead.
- **DON'T** imply the plugin acts on its own. It sends, edits or deletes the user's own messages only when asked, and never reacts, uploads, plays media, changes settings or changes channel membership.
