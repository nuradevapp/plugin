# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun start          # run the plugin
bun dev            # run with hot reload (bun --watch)
bun test           # run all tests
bun test tests/activity.test.ts  # run a single test file
bun test tests/hook.test.ts
```

The relay URL is hardcoded to `wss://relay.nuradev.app`. Self-hosted relays are not supported — Nura Dev is a paid managed service.

## Architecture

This is a **Claude Code channel plugin** that bridges voice commands from a phone (via nuradev.app) into Claude Code sessions. There are three parties in the system:

```
Phone App  ←→  WebSocket Relay  ←→  This Plugin  ←→  Claude Code (MCP stdio)
```

### File map

| File | Role |
|------|------|
| `src/index.ts` | Entry point — wires relay ↔ MCP, handles shutdown |
| `src/relay.ts` | WebSocket client to the relay server |
| `src/mcp.ts` | MCP server connected to Claude Code via stdio |
| `src/hook.ts` | Standalone CLI invoked by Claude Code hooks (PreToolUse/PostToolUse/Stop) |
| `src/activity.ts` | Pure function: formats tool name + input → human-readable summary |
| `src/pairing.ts` | Terminal rendering of the pairing box, countdown timer, status lines |
| `src/token-file.ts` | Reads/writes `~/.nuradev/plugin-token.json` (mode 0o600) |
| `src/types.ts` | All wire message types (`PluginMessage`, `RelayMessage`, `TaskSummary`) |
| `tests/activity.test.ts` | Unit tests for `formatActivity` |
| `tests/hook.test.ts` | Unit tests for `buildEvents` |
| `manifest.json` | Plugin manifest — declares hooks and MCP entry point |

### Two connection layers

**`relay.ts`** — WebSocket client connected to the relay server. Handles:
- Registration: sends `register_plugin` (with optional `sessionId` for reconnect), receives `registered` with a `sessionId`
- Pairing flow: sends `request_pairing_code`, receives `pairing_code` / `paired` events
- Inbound voice messages: `message` events → forwarded to MCP as channel notifications
- Outbound: `reply`, `reply_with_detail`, `permission_request`, `thinking`, `status`, `task_update`, `activity_event`, `activity_clear`
- Exponential backoff reconnect: 2s → 4s → 8s → 16s → 30s (capped)
- Close code `4401` = unpaired; deletes token file and resets to unpaired state
- Plugin token stored in `~/.nuradev/plugin-token.json` and sent as `?pluginToken=…` query param on reconnect

**`mcp.ts`** — MCP `Server` connected to Claude Code via `StdioServerTransport`. Exposes:
- Experimental capabilities `claude/channel` and `claude/channel/permission`
- A single `reply` tool: `{ chat_id, text, full_content? }` — `text` is TTS (≤200 chars), `full_content` shown in card
- Buffers channel events that arrive before MCP connects (`pendingChannelEvents`)
- Handles `notifications/claude/channel/permission_request` to forward permission requests to the relay

**`index.ts`** wires the two layers together:
- Relay channel events (pairing box, paired, disconnect, reconnect) → MCP `notifications/claude/channel`
- Inbound voice messages → MCP `notifications/claude/channel` with `meta.chat_id`
- Permission verdicts → MCP `notifications/claude/channel/permission`
- On shutdown (`SIGINT`/`SIGTERM`): sends `activity_clear`, then closes relay

### Hook system (`hook.ts` + `manifest.json`)

Claude Code invokes `src/hook.ts` via three hooks declared in `manifest.json`:

| Hook | Flag | Behavior |
|------|------|----------|
| `PreToolUse` | `--phase=start` | Sends `status` (human summary) + `activity_event { phase: "start" }` |
| `PostToolUse` | `--phase=end` | Sends `activity_event { phase: "end" }` (no status) |
| `Stop` | `--phase=stop` | Sends `status "Done."` |

Additionally, for `TaskCreate` and `TaskUpdate` tool calls, `hook.ts` emits a `task_update` message alongside the activity event so the mobile app can maintain a persistent task board.

`hook.ts` reads stdin as JSON (`HookPayload`: `tool_use_id`, `tool_name`, `tool_input`, `timestamp`) and the session ID from `/tmp/nuradev-session`. Opens a fresh WebSocket (`?client=status`) per invocation, sends all messages, then closes it. Fire-and-forget: exits 0 even on error.

### Activity formatting (`activity.ts`)

`formatActivity(toolName, toolInput)` returns `{ tool, summary }`. Known tools and their summaries:

| Tool | Summary |
|------|---------|
| `Read` | `Read <basename>` |
| `Edit` | `Edit <basename>` |
| `Write` | `Edit <basename>` (intentionally same label) |
| `Bash` | `Bash: <first 40 chars of command>…` |
| `Grep` | `Grep "<pattern>"` |
| `Glob` | `Glob <pattern>` |
| `Agent` | `Agent: <subagent_type>` |
| `WebFetch` | `Fetch <hostname>` |
| `WebSearch` | `Search "<query>"` |
| `TaskCreate` | `Task: <title>` |
| `TaskUpdate` | `Task <status>: <title>` |
| `TaskList` | `Tasks` |
| unknown | `<toolName>` |

### Session ID & status hook

When the relay assigns a `sessionId`, it's written to `/tmp/nuradev-session`. The hook reads this file to know which session to post status updates for. If the file is missing, the hook exits immediately (no relay is running).

### Message types (`types.ts`)

**Plugin → Relay (`PluginMessage`):**
- `register_plugin` — initial handshake, optional `sessionId` for reconnect
- `request_pairing_code` — asks relay for a new pairing code
- `reply` — short text reply to a voice message
- `reply_with_detail` — TTS summary (`message`) + card detail (`full_content`)
- `status` — one-line status text shown on the phone
- `task_update` — push a `TaskSummary` to the app's task board
- `activity_event` — individual tool start/end event with `{ id, phase, tool, summary, timestamp }`
- `activity_clear` — clears all activity and tasks on the app (sent on plugin shutdown)
- `permission_request` — asks the user to approve/deny a tool call
- `thinking` — signals Claude is processing (sent when a voice message arrives)

**Relay → Plugin (`RelayMessage`):**
- `registered` — contains `sessionId`
- `pairing_code` — contains `code` (6 chars) and `expiresIn` (seconds)
- `paired` — contains `deviceId`, `pluginToken`, `pluginTokenId`
- `message` — inbound voice message with `chat_id` and `text`
- `permission_verdict` — `{ request_id, allow }` response to a permission request
- `app_disconnected` — phone app disconnected from relay
- `app_reconnected` — phone app reconnected to relay

### Pairing display (`pairing.ts`)

Owns terminal rendering:
- `showPairingCode(code, expiresIn, onExpired)` — draws the box to stderr, starts a 1-second countdown interval; calls `onExpired()` when it hits zero to auto-request a new code
- `clearPairingBox()` — uses ANSI escape codes (`\x1b[1A\x1b[2K`) to erase the 16-line box
- `showPaired()` / `showDisconnected()` / `showReconnected()` — one-line status lines to stderr

The same box is also built as a string in `relay.ts` (`pairingBoxText`) and forwarded to Claude Code as a `pairing_code` channel event.

### Token persistence (`token-file.ts`)

Stores `{ pluginToken, pluginTokenId }` as JSON in `~/.nuradev/plugin-token.json` with mode `0o600`. On reconnect, `pluginToken` is appended to the WebSocket URL so the relay can re-authenticate the plugin without re-pairing. On close code `4401` (unpaired), the token file is deleted.

### Dependencies

- `@modelcontextprotocol/sdk` — MCP server + stdio transport
- `zod` — schema validation for permission request notifications
- `bun` runtime (not Node.js) — used for file I/O (`Bun.file`, `Bun.write`, `Bun.stdin`), WebSocket, and test runner

### Temporary files

| Path | Contents | Purpose |
|------|----------|---------|
| `/tmp/nuradev-session` | session ID string | Shared between plugin and hook CLI |
