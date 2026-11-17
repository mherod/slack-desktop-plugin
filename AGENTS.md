# Agent guide

## Skill source of truth

`skills/slack-desktop` is exported one way from a private upstream copy of the skill. Never edit it here.

- **DO** make skill changes (scripts, tests, `SKILL.md`, references) in the upstream copy, run its tests there, then run `bun scripts/export-skill.mjs <upstream-skills-root>` here. The export copies the skill without upstream-only files, vendors `scripts/lib/`, runs `.redaction/redact.mjs` and records a content hash in `skill-export.json`.
- **DO** review the exported diff before committing: every export becomes public. Use `--dry-run` first to see which files would change.
- **DO** bump the patch version in all five manifests (`package.json`, `plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`) with every export that changes `skills/`, then run `bun run check:manifests`. Installed copies compare that version, so an unbumped export never reaches them.
- **DON'T** hand-edit anything under `skills/`. `bun run check:export` (also in CI) fails when the tree no longer matches `skill-export.json`. It proves nothing was edited here since the last export; it does not prove the skill is current with upstream.
- **Check:** after an export, `bun run check:export` passes and `bun test skills/slack-desktop/scripts --parallel=4` passes here.

## Public copy

Applies to the GitHub repo description, README intro, plugin manifest descriptions (`plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) and marketplace listings.

- **DO** lead with the main selling point: the plugin needs no approved access to the Slack workspace. It drives the Slack desktop app the user is already signed in to, so there is no bot, integration, API token or admin sign off.
- **DO** keep the tone loose and plain, with at most one emoji. Rewording the factual version is the goal, not adding jokes or metaphors.
- **DON'T** use dashes as punctuation (em dash `—`, en dash `–` or a spaced hyphen). Split the sentence or use a comma instead. Check with `gh repo view --json description --jq .description | grep -c '[-—–]'`, which must print `0`.
- **DON'T** write "no Slack app" or "no app to install". It reads as not needing the Slack desktop app, which is a hard requirement. Say "no bot" or "no integration" instead.
- **DON'T** imply the plugin acts on its own. It sends, edits or deletes the user's own messages only when asked, and never reacts, uploads, plays media, changes settings or changes channel membership.
