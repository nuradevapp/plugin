# Nura Dev

Voice control for Claude Code — from your phone.
https://nuradev.app

## Install

```
/plugin install nuradev@nuradevapp/plugin
```

This clones the marketplace, registers it, and installs the plugin in one step.

## Launch

```
claude --dangerously-load-development-channels plugin:nuradev@nuradev
```

A pairing code appears in your terminal. Open https://app.nuradev.app on your phone and enter the code.

The `--dangerously-load-development-channels` flag is required during the channels research preview until Nura Dev is added to Anthropic's allowlist. Requires Claude Code v2.1.81 or later.

## Versioning

Releases use [calver](https://calver.org) in `YYYY.MM.DD` format. The same string lives in three places (`manifest.json`, `package.json`, `.claude-plugin/marketplace.json`) and gets bumped together on each release.

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
