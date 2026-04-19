import type { RelayMessage, PermissionRequestParams } from "./types.js"
import { showPairingCode, showPaired, showDisconnected, showReconnected, clearPairingBox } from "./pairing.js"

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

type MessageHandler = (chat_id: string, text: string) => void
type PermissionVerdictHandler = (request_id: string, allow: boolean) => void
type ChannelEventHandler = (content: string, meta?: Record<string, unknown>) => void

let ws: WebSocket | null = null
let sessionId: string | null = null
let paired = false
let reconnectAttempt = 0
let destroyed = false

let onMessage: MessageHandler = () => {}
let onPermissionVerdict: PermissionVerdictHandler = () => {}
let onChannelEvent: ChannelEventHandler = () => {}

function handleMessage(msg: RelayMessage) {
  switch (msg.type) {
    case "registered":
      sessionId = msg.sessionId
      if (!paired) {
        ws!.send(JSON.stringify({ type: "request_pairing_code" }))
      }
      break

    case "pairing_code":
      showPairingCode(msg.code, msg.expiresIn, () => {
        ws?.send(JSON.stringify({ type: "request_pairing_code" }))
      })
      onChannelEvent(pairingBoxText(msg.code, msg.expiresIn), { event: "pairing_code" })
      break

    case "paired":
      paired = true
      clearPairingBox()
      showPaired()
      onChannelEvent(
        "✓ Hacker Assist paired — ready\n" +
        "  Listening for voice commands from app.hackerassist.com",
        { event: "paired" }
      )
      break

    case "message":
      onMessage(msg.chat_id, msg.text)
      break

    case "permission_verdict":
      onPermissionVerdict(msg.request_id, msg.allow)
      break

    case "pwa_disconnected":
      showDisconnected()
      onChannelEvent(
        "○ Hacker Assist disconnected\n" +
        "  Waiting for reconnect from app.hackerassist.com...",
        { event: "pwa_disconnected" }
      )
      break

    case "pwa_reconnected":
      showReconnected()
      onChannelEvent("✓ Hacker Assist reconnected", { event: "pwa_reconnected" })
      break
  }
}

function scheduleReconnect() {
  const delay = BACKOFF_STEPS[Math.min(reconnectAttempt, BACKOFF_STEPS.length - 1)]
  reconnectAttempt++
  setTimeout(reconnect, delay)
}

function reconnect() {
  if (destroyed) return
  const url = `${RELAY_URL}?client=plugin`
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

  ws.addEventListener("close", () => {
    if (destroyed) return
    if (paired) showDisconnected()
    scheduleReconnect()
  })
}

export function sendReply(chat_id: string, text: string) {
  ws?.send(JSON.stringify({ type: "reply", chat_id, text }))
}

export function sendPermissionRequest(params: PermissionRequestParams) {
  ws?.send(JSON.stringify({ type: "permission_request", ...params }))
}

export function sendThinking() {
  ws?.send(JSON.stringify({ type: "thinking" }))
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
    const url = `${RELAY_URL}?client=plugin`
    ws = new WebSocket(url)

    const timeout = setTimeout(() => {
      ws?.close()
      reject(new Error(`Cannot reach relay at ${RELAY_URL}`))
    }, 10000)

    ws.addEventListener("open", () => {
      ws!.send(JSON.stringify({ type: "register_plugin" }))
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

        ws!.addEventListener("close", () => {
          if (destroyed) return
          if (paired) showDisconnected()
          scheduleReconnect()
        })
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
