import { hostname } from "os"
import type { RelayMessage, PermissionRequestParams } from "./types.js"
import { showPairingCode, showPaired, showDisconnected, showReconnected, clearPairingBox } from "./pairing.js"
import { readToken, writeToken, updateSessionId, deleteToken } from "./token-file.js"

function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} - ${code.slice(3)}` : code
}

function formatExpiry(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

function pairingBoxText(code: string, expiresIn: number): string {
  const formatted = formatCode(code)
  const expiry = formatExpiry(expiresIn)
  return (
    "╔══════════════════════════════════════╗\n" +
    "║                                      ║\n" +
    "║   HACKER ASSIST                      ║\n" +
    "║   hackerassist.com                   ║\n" +
    "║                                      ║\n" +
    "║   Pairing code:                      ║\n" +
    "║                                      ║\n" +
    `║          ${formatted.padEnd(28)}║\n` +
    "║                                      ║\n" +
    "║   1. Open app.hackerassist.com       ║\n" +
    "║      on your phone                   ║\n" +
    "║   2. Tap  +  and enter this code     ║\n" +
    "║                                      ║\n" +
    `║   Expires in  ${expiry.padEnd(23)}║\n` +
    "║                                      ║\n" +
    "╚══════════════════════════════════════╝"
  )
}

const RELAY_URL = process.env.HACKER_ASSIST_RELAY_URL ?? "wss://relay.hackerassist.com"
const BACKOFF_STEPS = [2000, 4000, 8000, 16000, 30000]
const cwd = process.cwd()

function buildUrl(): string {
  const t = readToken(cwd)
  const base = `${RELAY_URL}?client=plugin`
  return t ? `${base}&pluginToken=${encodeURIComponent(t.pluginToken)}` : base
}

type MessageHandler = (text: string, image?: { base64: string; media_type: string }) => void
type PermissionVerdictHandler = (request_id: string, allow: boolean) => void
type ChannelEventHandler = (content: string, meta?: Record<string, unknown>) => void

let ws: WebSocket | null = null
let sessionId: string | null = null
let paired = readToken(cwd) !== null
let reconnectAttempt = 0
let destroyed = false

let onMessage: MessageHandler = () => {}
let onPermissionVerdict: PermissionVerdictHandler = () => {}
let onChannelEvent: ChannelEventHandler = () => {}

function handleMessage(msg: RelayMessage) {
  switch (msg.type) {
    case "registered": {
      const isFirstConnect = sessionId === null
      sessionId = msg.sessionId
      Bun.write(`/tmp/hackerassist-session.${process.ppid}`, msg.sessionId).catch(() => {})
      if (paired) updateSessionId(cwd, msg.sessionId)
      if (!isFirstConnect) {
        // WebSocket reconnect within the same session — skip re-pairing
        showReconnected()
        onChannelEvent("✓ Hacker Assist reconnected", { event: "app_reconnected" })
      } else if (!paired) {
        // New directory — request a pairing code
        ws!.send(JSON.stringify({ type: "request_pairing_code", deviceName: hostname() }))
      } else {
        // Known directory — connect directly, no re-pairing needed
        showPaired()
        onChannelEvent(
          "✓ Hacker Assist connected — ready\n" +
          "  Listening for voice commands from app.hackerassist.com",
          { event: "paired" }
        )
      }
      break
    }

    case "pairing_code":
      showPairingCode(msg.code, msg.expiresIn, () => {
        ws?.send(JSON.stringify({ type: "request_pairing_code" }))
      })
      onChannelEvent(pairingBoxText(msg.code, msg.expiresIn), { event: "pairing_code" })
      break

    case "paired":
      paired = true
      if ("pluginToken" in msg && "pluginTokenId" in msg) {
        writeToken(cwd, msg.pluginToken, msg.pluginTokenId, sessionId ?? "")
      }
      clearPairingBox()
      showPaired()
      onChannelEvent(
        "✓ Hacker Assist paired — ready\n" +
        "  Listening for voice commands from app.hackerassist.com",
        { event: "paired" }
      )
      break

    case "message": {
      const image = msg.image_base64 && msg.image_media_type
        ? { base64: msg.image_base64, media_type: msg.image_media_type }
        : undefined
      onMessage(msg.text, image)
      break
    }

    case "permission_verdict":
      onPermissionVerdict(msg.request_id, msg.allow)
      break

    case "app_disconnected":
      showDisconnected()
      onChannelEvent(
        "○ Hacker Assist disconnected\n" +
        "  Waiting for reconnect from app.hackerassist.com...",
        { event: "app_disconnected" }
      )
      break

    case "app_reconnected":
      showReconnected()
      onChannelEvent("✓ Hacker Assist reconnected", { event: "app_reconnected" })
      break
  }
}

function handleClose(ev: Event) {
  if (destroyed) return
  if ((ev as CloseEvent).code === 4401) {
    deleteToken(cwd)
    paired = false
    sessionId = null
    process.stderr.write("Hacker Assist: token invalid — re-pairing required.\n")
    onChannelEvent(
      "⚠ Hacker Assist: re-pairing required\n" +
      "  Your session token is no longer valid.\n" +
      "  A new pairing code will appear shortly.",
      { event: "repairing_required" }
    )
  }
  if (paired) showDisconnected()
  scheduleReconnect()
}

function scheduleReconnect() {
  const delay = BACKOFF_STEPS[Math.min(reconnectAttempt, BACKOFF_STEPS.length - 1)]
  reconnectAttempt++
  if (reconnectAttempt === 5) {
    process.stderr.write("Still unable to pair. Check your relay URL and network.\n")
  }
  setTimeout(reconnect, delay)
}

function reconnect() {
  if (destroyed) return
  const url = buildUrl()
  ws = new WebSocket(url)

  ws.addEventListener("open", () => {
    reconnectAttempt = 0
    const msg = sessionId
      ? { type: "register_plugin", sessionId }
      : { type: "register_plugin" }
    ws!.send(JSON.stringify(msg))
  })

  ws.addEventListener("message", (event) => {
    let data: RelayMessage
    try {
      data = JSON.parse(event.data as string) as RelayMessage
    } catch {
      return
    }
    handleMessage(data)
  })

  ws.addEventListener("close", handleClose)
}

export function getSessionId(): string | null {
  return sessionId
}

export function sendReply(text: string, image?: { base64: string; media_type: string }) {
  if (!sessionId) return
  ws?.send(JSON.stringify({
    type: "reply",
    session_id: sessionId,
    text,
    ...(image ? { image_base64: image.base64, image_media_type: image.media_type } : {}),
  }))
}

export function sendReplyWithDetail(message: string, full_content: string, image?: { base64: string; media_type: string }) {
  if (!sessionId) return
  ws?.send(JSON.stringify({
    type: "reply_with_detail",
    session_id: sessionId,
    message,
    full_content,
    ...(image ? { image_base64: image.base64, image_media_type: image.media_type } : {}),
  }))
}

export function sendPermissionRequest(params: PermissionRequestParams) {
  ws?.send(JSON.stringify({ type: "permission_request", ...params }))
}

export function sendThinking() {
  if (!sessionId) return
  ws?.send(JSON.stringify({ type: "thinking", session_id: sessionId }))
}

export function sendActivityClear() {
  if (!sessionId) return
  ws?.send(JSON.stringify({ type: "activity_clear", session_id: sessionId }))
}

export function setMessageHandler(handler: MessageHandler) {
  onMessage = handler
}

export function setPermissionVerdictHandler(handler: PermissionVerdictHandler) {
  onPermissionVerdict = handler
}

export function setChannelEventHandler(handler: ChannelEventHandler) {
  onChannelEvent = handler
}

export async function connectRelay(): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = buildUrl()
    ws = new WebSocket(url)

    const timeout = setTimeout(() => {
      ws?.close()
      reject(new Error(`Cannot reach relay at ${RELAY_URL}`))
    }, 10000)

    ws.addEventListener("open", () => {
      // Send stored sessionId so relay can restore the session for this directory
      const storedSessionId = readToken(cwd)?.sessionId
      const msg = storedSessionId
        ? { type: "register_plugin", sessionId: storedSessionId }
        : { type: "register_plugin" }
      ws!.send(JSON.stringify(msg))
    })

    ws.addEventListener("message", (event) => {
      let data: RelayMessage
      try {
        data = JSON.parse(event.data as string) as RelayMessage
      } catch {
        return
      }

      if (data.type === "registered" && !sessionId) {
        // First registration — resolve the promise and hand off to normal flow
        clearTimeout(timeout)
        handleMessage(data)
        resolve()

        // Wire up ongoing message handling and reconnect
        ws!.addEventListener("message", (e) => {
          let d: RelayMessage
          try {
            d = JSON.parse(e.data as string) as RelayMessage
          } catch {
            return
          }
          handleMessage(d)
        })

        ws!.addEventListener("close", handleClose)
      }
    })

    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error(`Cannot reach relay at ${RELAY_URL}`))
    })
  })
}

export function destroyRelay() {
  destroyed = true
  ws?.close()
}
