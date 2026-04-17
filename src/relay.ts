import type { RelayMessage, PermissionRequestParams } from "./types.js"
import { showPairingCode, showPaired, showDisconnected, showReconnected, clearPairingBox } from "./pairing.js"

const RELAY_URL = process.env.HACKER_ASSIST_RELAY_URL ?? "wss://relay.hackerassist.com"
const BACKOFF_STEPS = [2000, 4000, 8000, 16000, 30000]

type MessageHandler = (chat_id: string, text: string) => void
type PermissionVerdictHandler = (request_id: string, allow: boolean) => void

let ws: WebSocket | null = null
let sessionId: string | null = null
let paired = false
let reconnectAttempt = 0
let destroyed = false

let onMessage: MessageHandler = () => {}
let onPermissionVerdict: PermissionVerdictHandler = () => {}

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
      break

    case "paired":
      paired = true
      clearPairingBox()
      showPaired()
      break

    case "message":
      onMessage(msg.chat_id, msg.text)
      break

    case "permission_verdict":
      onPermissionVerdict(msg.request_id, msg.allow)
      break

    case "pwa_disconnected":
      showDisconnected()
      break

    case "pwa_reconnected":
      showReconnected()
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
