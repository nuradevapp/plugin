# Nura Dev Plugin

Voice control for Claude Code — from your phone.
https://nuradev.app

## Install

```
/plugin marketplace add nuradevapp/marketplace
/plugin install nuradev@nuradevapp/marketplace
```

## Usage

```
claude --channels plugin:nuradev@nuradevapp/marketplace
```

A pairing code appears in your terminal.
Open https://app.nuradev.app on your phone and enter the code.

## Research preview

Until the plugin is on Anthropic's approved allowlist, customers must launch with:

```
claude --dangerously-load-development-channels plugin:nuradev@nuradevapp/marketplace
```

Requires Claude Code v2.1.81 or later.

## Manual hook installation

If your Claude Code version does not auto-load plugin hooks from the manifest, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "command": "bun run /full/path/to/nuradev-plugin/src/hook.ts --phase=start" }],
    "PostToolUse": [{ "matcher": "*", "command": "bun run /full/path/to/nuradev-plugin/src/hook.ts --phase=end" }],
    "Stop": [{ "command": "bun run /full/path/to/nuradev-plugin/src/hook.ts --phase=stop" }]
  }
}
```
