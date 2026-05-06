# Voice Manager — Plugin Integration Brief

**Date:** 2026-04-27
**Audience:** Anyone (or any Claude) working on the `plugin` repo
**Source-of-truth specs (in the relay repo):**
- `relay/.claude/docs/specs/2026-04-27-voice-manager-design.md` — full design
- `relay/.claude/docs/specs/2026-04-27-user-sessions-autocreate-followup.md` — open follow-up

## TL;DR

The relay's voice channel is no longer a passthrough — it's a **manager**. Grok now decides whether to dispatch the founder's spoken instructions to one of their paired Claude Code plugin sessions, or just reply. **The plugin's wire contract did not change.** Messages from voice and from the app's text UI arrive on the plugin WS as the same `{type: "message", chat_id, text}` frame. No code changes are *required* in the plugin to remain functional.

There are, however, small things the plugin should get right for the manager UX to be useful.

## What the plugin already does correctly

- Sends `deviceName: hostname()` on the initial `request_pairing_code` (`src/relay.ts:68`). The relay stores this on the in-memory `PluginSession.name` and uses it as the label Grok hears in injected updates ("[update] simons-macbook replied: ...").
- Persists the plugin token + sessionId across restarts (`src/token-file.ts`, `register_plugin` reconnect).
- Emits the events the relay forwards to voice: `reply`, `reply_with_detail`, `permission_request`, `status`, `task_update`. (`thinking`, `activity_event`, `activity_clear` are intentionally suppressed by the relay before reaching Grok.)

## Small fixes worth doing

1. **Line `src/relay.ts:74` is missing `deviceName`** on the "pairing code expired, regenerate" path. The first request includes it; the regen drops it. Result: if a founder lets the code expire and regenerates, their session arrives at the relay nameless, and Grok says "developer" instead of the hostname. One-line fix:

   ```ts
   ws?.send(JSON.stringify({ type: "request_pairing_code", deviceName: hostname() }))
   ```

2. **Consider a richer `deviceName` than bare `hostname()`.** Hostnames like "simons-macbook" don't tell Grok which project you mean. A more useful default would be something like `${hostname()}:${path.basename(process.cwd())}` so Grok can address sessions by project ("switch to my-app", "tell my-app to ..."). This is a UX call, not a wire-level requirement — keep `hostname()` if you prefer.

## Things the plugin does NOT need to do

- **Don't differentiate voice-driven vs. app-driven messages.** They look identical on the wire and should be treated identically. If the plugin starts gating behavior on the source, the manager abstraction breaks.
- **Don't mock or work around tool calls.** Tool calls happen entirely between Grok and the relay; the plugin only sees the resulting `message` frame.
- **Don't ship a "voice mode" or special handling.** The relay handles all voice plumbing.

## Open follow-up that affects the plugin's UX

The relay's `list_sessions` and `switch_session` tools query the `user_sessions` DB table, **not** the in-memory `PluginSession.name`. Today, that table is only populated when the founder calls `PUT /v1/sessions/:name` from the app UI. Until the relay's auto-create follow-up ships (`relay/.claude/docs/specs/2026-04-27-user-sessions-autocreate-followup.md`), a freshly paired plugin is invisible to voice routing unless the founder manually names it via the app.

When that follow-up does ship, the relay will upsert a `user_sessions` row at pair time using whatever `deviceName` the plugin sent. **That is the only reason `deviceName` quality matters** — it becomes the name Grok uses to address the session. Until then, the plugin can ignore this entirely.

## Test plan when implementing the small fixes

- Pair flow with `hostname()`-only: existing tests should pass (no behavior change).
- Pair flow when regenerating after expiry: assert the second `request_pairing_code` carries `deviceName`.
- (Manual, post-deploy) Pair the plugin, then via voice say "list my sessions" — Grok should report the plugin under the deviceName.

## Out of scope for the plugin

- Tool schema, system prompt, voice routing logic. All in the relay.
- xAI Realtime protocol details. Plugin never talks to xAI.
- Founder-side UI for naming or muting sessions. App's domain.
