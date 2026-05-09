import {
  connectRelay,
  setMessageHandler,
  setCommandHandler,
  setPermissionVerdictHandler,
  setChannelEventHandler,
  getSessionId,
  sendThinking,
  sendActivityClear,
  destroyRelay,
} from "./relay.js"
import { mcp, connectMcp, sendChannelEvent } from "./mcp.js"
import { log } from "./log.js"
import { saveAttachment, formatAttachmentRef } from "./attachments.js"

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

  const shutdown = () => {
    try { sendActivityClear() } catch { /* ignore */ }
    destroyRelay()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main()
