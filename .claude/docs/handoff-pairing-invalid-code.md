# Handoff: "Invalid code" when pairing iOS app with plugin

**Audience:** Claude session working on the **relay** codebase (`relay.hackerassist.com`).
**Written by:** Claude session working on the **plugin** (`/Users/simon/Workspace/hackerassist/plugin`).
**Date:** 2026-04-18.

---

## Symptom

User runs the plugin via:
```
claude --dangerously-load-development-channels server:hackerassist
```
The pairing code is displayed. User enters it into the iOS app (running in the simulator). App responds **"Invalid code"**.

This has not yet been narrowed to plugin, relay, or app — but plugin-side generation/display has been ruled out (see below). The relay is the most likely culprit or vantage point.

---

## System overview (as plugin sees it)

```
iOS PWA (simulator)  ──WS──▶  relay.hackerassist.com  ◀──WS──  Plugin (this repo)
                                                                    ▲
                                                                    │ MCP stdio
                                                                    ▼
                                                             Claude Code TUI
```

Plugin connects to `wss://relay.hackerassist.com?client=plugin`.
PWA presumably connects with a different query (`?client=pwa` or similar) — **relay Claude should verify the exact pairing-submission endpoint/message shape**.

### Plugin → Relay messages (from `src/types.ts`)

```ts
{ type: "register_plugin", sessionId?: string }
{ type: "request_pairing_code" }
{ type: "reply",              chat_id, text }
{ type: "permission_request", request_id, tool_name, description, input_preview }
{ type: "thinking" }
```

### Relay → Plugin messages

```ts
{ type: "registered",         sessionId }
{ type: "pairing_code",       code, expiresIn }
{ type: "paired",             deviceId }
{ type: "message",            chat_id, text }
{ type: "permission_verdict", request_id, allow }
{ type: "pwa_disconnected" }
{ type: "pwa_reconnected" }
```

Plugin startup sequence:
1. WS connect → `register_plugin` (no sessionId on first connect).
2. Relay replies `registered` with `sessionId`.
3. Plugin sends `request_pairing_code`.
4. Relay replies `pairing_code` with `code` (appears to be a 6-character string based on plugin's formatter) and `expiresIn` (seconds).
5. Plugin displays code to user via MCP channel event (`notifications/claude/channel`).
6. When PWA submits matching code, relay sends `paired` to plugin.

**What the plugin does NOT know** (relay Claude should confirm from relay code):
- The exact message shape the PWA uses to submit a pairing code.
- The format the code is stored in (digits? alphanumeric? case-sensitive?).
- The TTL enforcement policy for codes.
- Whether codes are bound to a specific `sessionId`, or globally redeemable.

---

## Plugin-side findings (already verified)

- `src/relay.ts` forwards the `msg.code` value from the relay straight through — no transformation before display.
- Formatter (`formatCode` in `src/relay.ts:4`) splits a 6-char code cosmetically as `XXX - YYY` for display. The raw code going to the PWA for entry is **the 6 chars without separator**.
- The plugin does not cache old codes; each `pairing_code` message from relay replaces the previous display.
- Plugin typechecks cleanly (`bunx tsc --noEmit`).
- Plugin currently logs nothing about the code over stdout/stderr that the user can verify against — only Claude's rendered output.

---

## Hypotheses — ordered by plugin-side plausibility

### H1. PWA submits code with `" - "` separator; relay does strict equality

The plugin displays `XK7 - 492` (space-dash-space) but the actual code is `XK7492`. If the user types the separator characters (likely — they see them) and the PWA forwards input verbatim without stripping, the relay would get 9 chars where it stored 6 — rejected.

**Relay Claude: check**
- The exact code-check handler in relay source.
- Whether it normalizes input (strip whitespace, strip `-`, uppercase) before comparison.
- Add a log line for received-code-vs-stored-code if not already present.

If the relay is strict, the fix is on the **PWA** side (strip separator before submission) OR on the **plugin** side (display raw code without separator). Plugin can change the displayed format — cheap fix if needed.

### H2. TTL mismatch

`expiresIn` comes from the relay. Plugin displays countdown; on expiry it auto-requests a new code. If the relay expires codes faster than `expiresIn` suggests (clock drift, off-by-one, or eager cleanup), the app might submit a code that's already been deleted server-side.

**Relay Claude: check**
- Actual storage TTL vs. the `expiresIn` value returned in the `pairing_code` message.
- Timezone / monotonic clock usage.
- Cleanup job frequency if codes are swept.

### H3. PWA hits wrong relay instance

User mentioned **iOS simulator**. Simulator shares the Mac's network, so `relay.hackerassist.com` should resolve the same. But:
- If the user has a local/staging relay running (env vars, `/etc/hosts`, DNS), plugin and PWA might be hitting **different** relays. Every code the plugin generates would be "invalid" from the PWA's relay.
- Check `HACKER_ASSIST_RELAY_URL` env var on plugin side — it defaults to prod but can be overridden.
- Check the PWA's configured relay URL — does it match?

**Relay Claude: check**
- Is there a local/dev relay running? (Look for local WS listeners on common dev ports.)
- What relay URL is baked into the PWA build that's running in the simulator?

### H4. `sessionId` binding mismatch

If the relay binds a `pairing_code` to the plugin's `sessionId` and requires the PWA's submission to match (or to pick a plugin to pair with via the code), a stale plugin session could mean the code points to a dead session. Rapid plugin restarts could leave multiple sessions with the same code (unlikely — codes should be unique) or dead sessions with live codes.

**Relay Claude: check**
- Is there a cleanup of sessions whose WS has closed? Does that cleanup cascade to pairing codes?
- Could there be a race where the PWA's lookup happens during plugin reconnect?

### H5. Case sensitivity / character set drift

If codes contain letters, case matters. The plugin displays whatever the relay sends — if the relay generates `XK7492` but stores `xk7492` (or vice versa), entry fails.

**Relay Claude: check**
- Code-generation function: character set, case.
- Code-comparison function: case-sensitive?

### H6. Redis/store key format drift (if applicable)

If codes are stored in Redis or similar, a key-prefix change or serialization change in a recent relay deploy could cause reads to miss. Check recent commits on the relay repo for anything touching pairing storage.

---

## Concrete investigation checklist for relay Claude

1. [ ] Locate the pairing-code submission handler (the handler that receives the PWA's submission and replies with success/`paired` or an "Invalid code" error).
2. [ ] Grep for the error string the PWA surfaces as "Invalid code" — trace it to the branch in relay code that emits it.
3. [ ] At that branch, determine which of the following triggered it:
   - code not found
   - code expired
   - code mismatch after normalization
   - sessionId mismatch
   - something else
4. [ ] Add (or confirm) a log line capturing:
   - the raw code string the PWA sent
   - the stored code string (or that no such code was found)
   - time since code creation vs. TTL
5. [ ] Ask the human user to run one end-to-end attempt with relay logs captured, then inspect which branch fired.
6. [ ] Report back: which hypothesis (H1–H6 above, or new) is the actual cause.

---

## What to tell the plugin-side Claude if you need changes on this side

The plugin is at `/Users/simon/Workspace/hackerassist/plugin`. Probable plugin-side changes that might come out of this:

- **Display the raw 6-char code** instead of `XK7 - 492` (remove the cosmetic separator in `formatCode` at `src/relay.ts:4`). Cheap.
- **Include code in a more copyable format** for the user (e.g., on its own line).
- **Surface the relay URL** in the pairing event so the user can confirm plugin and PWA are talking to the same relay.

None of these are worth doing until the relay-side root cause is known.

---

## Files the relay Claude does NOT need to read

These are plugin-side only, already vetted:

- `src/index.ts`, `src/mcp.ts`, `src/relay.ts`, `src/pairing.ts`, `src/types.ts`
- `hackerassist-plugin-spec.md`
- `manifest.json`, `package.json`

Only relevant plugin file for cross-reference: the message types in `src/types.ts` (reproduced above).
