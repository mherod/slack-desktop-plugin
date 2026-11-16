# Agent guide

## Public copy

Applies to the GitHub repo description, README intro, plugin manifest descriptions (`plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) and marketplace listings.

- **DO** lead with the main selling point: the plugin needs no approved access to the Slack workspace. It drives the Slack desktop app the user is already signed in to, so there is no bot, integration, API token or admin sign off.
- **DO** keep the tone loose and plain, with at most one emoji. Rewording the factual version is the goal, not adding jokes or metaphors.
- **DON'T** use dashes as punctuation (em dash `—`, en dash `–` or a spaced hyphen). Split the sentence or use a comma instead. Check with `gh repo view --json description --jq .description | grep -c '[-—–]'`, which must print `0`.
- **DON'T** write "no Slack app" or "no app to install". It reads as not needing the Slack desktop app, which is a hard requirement. Say "no bot" or "no integration" instead.
- **DON'T** imply the plugin acts on its own. It sends, edits or deletes the user's own messages only when asked, and never reacts, uploads, plays media, changes settings or changes channel membership.
