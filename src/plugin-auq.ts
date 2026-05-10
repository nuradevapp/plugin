import type { IpcConnection } from "./ipc.js"
import type { PluginMessage, RelayMessage } from "./types.js"
import { log } from "./log.js"

interface PendingEntry {
  conn: IpcConnection
  session_id: string
}

export interface Broker {
  onIpcMessage(conn: IpcConnection, msg: any): void
  onRelayVerdict(msg: Extract<RelayMessage, { type: "ask_user_question_verdict" }>): void
  shutdown(): void
}

export function createBroker(deps: { sendToRelay: (msg: PluginMessage) => void }): Broker {
  const pending = new Map<string, PendingEntry>()

  function register(conn: IpcConnection, request_id: string, session_id: string) {
    pending.set(request_id, { conn, session_id })
    conn.onClose(() => {
      const entry = pending.get(request_id)
      if (!entry) return
      pending.delete(request_id)
      log("auq:ipc:close-before-verdict", { request_id })
      deps.sendToRelay({ type: "cancel_ask_user_question", session_id, request_id })
    })
  }

  return {
    onIpcMessage(conn, msg) {
      if (msg?.type !== "ask_user_question") {
        log("auq:ipc:unknown-msg", { type: msg?.type })
        return
      }
      const { request_id, session_id, questions } = msg
      if (typeof request_id !== "string" || typeof session_id !== "string") {
        log("auq:ipc:bad-msg", { has_req_id: typeof request_id, has_sid: typeof session_id })
        return
      }
      register(conn, request_id, session_id)
      log("auq:ipc:received", { request_id, session_id, n_questions: Array.isArray(questions) ? questions.length : 0 })
      deps.sendToRelay({ type: "ask_user_question", session_id, request_id, questions })
    },

    onRelayVerdict(msg) {
      const entry = pending.get(msg.request_id)
      if (!entry) {
        log("auq:verdict:unknown", { request_id: msg.request_id })
        return
      }
      pending.delete(msg.request_id)
      log("auq:verdict:delivered", { request_id: msg.request_id, cancelled: msg.cancelled === true })
      entry.conn.send(msg)
    },

    shutdown() {
      for (const [, entry] of pending) entry.conn.close()
      pending.clear()
    },
  }
}
