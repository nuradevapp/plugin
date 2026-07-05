import {
  connectRelay,
  setMessageHandler,
  setCommandHandler,
  setPermissionVerdictHandler,
  setChannelEventHandler,
  setAskUserQuestionVerdictHandler,
  setSessionReadyHandler,
  getSessionId,
  sendReply,
  sendThinking,
  sendActivityClear,
  sendAskUserQuestion,
  sendCancelAskUserQuestion,
  destroyRelay,
} from "./relay.js"
import { mcp, connectMcp, sendChannelEvent } from "./mcp.js"
import { log } from "./log.js"
import { saveAttachment, formatAttachmentRef } from "./attachments.js"
import { createRebindableServer, getPluginSocketPath, type RebindableServer } from "./ipc.js"
import { createBroker, type Broker } from "./plugin-auq.js"
import type { PluginMessage } from "./types.js"

export function parseVoiceCommand(text: string): string | null {
  const lower = text.trim().toLowerCase()
  if (!lower.startsWith("slash ")) return null
  const commandName = lower.slice(6).trim()
  if (!commandName) return null
  return `/${commandName}`
}

export function handleCommand(
  command: string,
  activityClear: () => void = sendActivityClear,
  channelEvent: (cmd: string, meta?: Record<string, unknown>) => void = sendChannelEvent,
  getChatId: () => string | null = getSessionId,
) {
  if (command === "/clear") {
    activityClear()
    return
  }
  const chatId = getChatId()
  channelEvent(command, chatId ? { chat_id: chatId } : undefined)
}

async function main() {
  // Route relay channel events (pairing code, paired, disconnect, reconnect) to MCP
  setChannelEventHandler(sendChannelEvent)

  let ipcServer: RebindableServer | null = null
  let broker: Broker | null = null

  // Fires on first connect AND whenever the session id changes (new chat). The
  // IPC socket path is session-keyed, so it must follow the session — otherwise
  // the hook connects to a stale path and every AUQ/mirror hop fails silently.
  const startAuqBroker = async (sessionId: string) => {
    if (!broker) {
      broker = createBroker({
        sendToRelay: (msg: PluginMessage) => {
          if (msg.type === "ask_user_question") {
            sendAskUserQuestion(msg.session_id, msg.request_id, msg.questions)
          } else if (msg.type === "cancel_ask_user_question") {
            sendCancelAskUserQuestion(msg.session_id, msg.request_id)
          }
        },
      })
      setAskUserQuestionVerdictHandler((msg) => broker!.onRelayVerdict(msg))
    }
    if (!ipcServer) {
      ipcServer = createRebindableServer((conn, msg) => {
        // MessageDisplay hook forwards completed assistant text blocks here so
        // they ride the authenticated relay connection as persisted messages.
        if (msg?.type === "mirror_text" && typeof msg.text === "string") {
          sendReply(msg.text)
          conn.send({ type: "mirror_text_ack" })
          return
        }
        broker!.onIpcMessage(conn, msg)
      })
    }
    try {
      await ipcServer.rebind(getPluginSocketPath(sessionId))
      log("auq:ipc:bound", { sessionId, path: getPluginSocketPath(sessionId) })
    } catch (err) {
      log("auq:ipc:bind-failed", { sessionId, error: (err as Error).message })
    }
  }

  setSessionReadyHandler(startAuqBroker)

  // 1-3. Connect to relay, register, and request pairing code
  try {
    await connectRelay()
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exit(1)
  }

  // Wire up inbound message handler
  setMessageHandler(async (text, image, file) => {
    const command = parseVoiceCommand(text)
    if (command !== null) {
      handleCommand(command)
      return
    }
    sendThinking()
    let content: string = text
    if (image) {
      const path = saveAttachment(image.base64, image.media_type)
      content = formatAttachmentRef(text, "image", path)
      log("attachment:saved", { kind: "image", path, media_type: image.media_type, b64_len: image.base64.length })
    } else if (file) {
      const path = saveAttachment(file.base64, file.media_type, file.name)
      content = formatAttachmentRef(text, "file", path, file.name)
      log("attachment:saved", { kind: "file", path, name: file.name, media_type: file.media_type, b64_len: file.base64.length })
    }
    log("mcp:notify:pre", {
      content_type: "string",
      text_len: content.length,
      has_image: !!image,
      has_file: !!file,
      chat_id: getSessionId(),
    })
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content,
          meta: { chat_id: getSessionId() },
        },
      })
      log("mcp:notify:ok", { has_image: !!image, has_file: !!file })
    } catch (err) {
      log("mcp:notify:err", { error: (err as Error).message })
    }
  })

  // Wire up relay command handler (bare command name from relay → /command)
  setCommandHandler((command) => {
    handleCommand(`/${command}`)
  })

  // Wire up permission verdict handler
  setPermissionVerdictHandler(async (request_id, allow) => {
    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: {
        request_id,
        behavior: allow ? "allow" : "deny",
      },
    })
  })

  // 5. Connect MCP to Claude Code via stdio (after relay is ready)
  await connectMcp()

  const shutdown = async () => {
    try { sendActivityClear() } catch { /* ignore */ }
    try { broker?.shutdown() } catch { /* ignore */ }
    try { await ipcServer?.stop() } catch { /* ignore */ }
    destroyRelay()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main()
