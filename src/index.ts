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

type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } }
type DocumentBlock = { type: "document"; source: { type: "base64"; media_type: string; data: string } }
type TextBlock = { type: "text"; text: string }

export function buildChannelContent(
  text: string,
  image?: { base64: string; media_type: string },
  file?: { base64: string; name: string; media_type: string }
): string | Array<ImageBlock | DocumentBlock | TextBlock> {
  if (image) {
    return [
      { type: "image", source: { type: "base64", media_type: image.media_type, data: image.base64 } },
      { type: "text", text },
    ]
  }
  if (file) {
    const fileBlock: DocumentBlock | TextBlock =
      file.media_type === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: file.media_type, data: file.base64 } }
        : file.media_type.startsWith("text/") || file.media_type === "application/json"
          ? { type: "text", text: `File: ${file.name}\n\n${Buffer.from(file.base64, "base64").toString("utf-8")}` }
          : { type: "text", text: `File: ${file.name} (${file.media_type}) — binary attachment` }
    return [fileBlock, { type: "text", text }]
  }
  return text
}

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
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: buildChannelContent(text, image, file),
        meta: { chat_id: getSessionId() },
      },
    })
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
