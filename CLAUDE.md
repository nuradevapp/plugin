# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun start          # run the plugin
bun dev            # run with hot reload (bun --watch)
bun test           # run all tests
bun test tests/status.test.ts  # run a single test file
```

Set `HACKER_ASSIST_RELAY_URL=wss://your-relay.example.com` to point at a self-hosted relay instead of the default `wss://relay.hackerassist.com`.

## Architecture

This is a **Claude Code channel plugin** that bridges voice commands from a phone (via hackerassist.com) into Claude Code sessions. There are three parties in the system:

```
Phone App  ←→  WebSocket Relay  ←→  This Plugin  ←→  Claude Code (MCP stdio)
```

### Two connection layers

**`relay.ts`** — WebSocket client connected to the relay server. Handles:
- Registration (sends `register_plugin`, receives `registered` with a `sessionId`)
- Pairing flow (requests pairing code, receives code/paired events)
- Inbound voice messages (`message` events → forwarded to MCP)
- Outbound replies (`reply`, `reply_with_detail`, `permission_request`, `thinking`)
- Exponential backoff reconnect (2s → 4s → 8s → 16s → 30s)

**`mcp.ts`** — MCP `Server` connected to Claude Code via `StdioServerTransport`. Exposes:
- Experimental capabilities `claude/channel` and `claude/channel/permission`
- A single `reply` tool (with optional `full_content` for TTS summary + card detail)
- Buffers channel events that arrive before MCP connects (`pendingChannelEvents`)

**`index.ts`** wires the two layers together: relay channel events (pairing box, paired, disconnect) are forwarded to MCP as `notifications/claude/channel`. Inbound voice messages are forwarded to MCP the same way with a `chat_id` in meta. Permission verdicts flow from relay → MCP as `notifications/claude/channel/permission`.

### Session ID & status hook

When the relay assigns a `sessionId`, it's written to `/tmp/hackerassist-session`.

**`status.ts`** is a standalone CLI invoked by Claude Code hooks (not imported by the main plugin). It reads the session ID from that file and sends `status` messages over a fresh WebSocket connection — this is how the phone shows real-time tool progress. It uses `/tmp/hackerassist-acked` (10-min TTL) to send "Got it, on it..." only once per session burst, then sends a human-readable tool status (e.g. `"Reading index.ts..."`).

Called with `--stop` to send `"Done."` and clear the ack file.

### Message types

All wire messages are typed in `types.ts`:
- `PluginMessage` — what the plugin sends to the relay
- `RelayMessage` — what the relay sends to the plugin

### Pairing display

`pairing.ts` owns terminal rendering (the box-drawing UI, countdown timer, cleared-on-pair). `relay.ts` also builds the same box as a string to send to Claude Code as a channel event (so Claude Code can display it in the conversation).
