import {
  connectRelay,
  setMessageHandler,
  setPermissionVerdictHandler,
  setChannelEventHandler,
  getSessionId,
  sendThinking,
  sendActivityClear,
  destroyRelay,
} from "./relay.js"
import { mcp, connectMcp, sendChannelEvent } from "./mcp.js"

export function buildChannelContent(
  text: string,
  image?: { base64: string; media_type: string }
): unknown {
  if (!image) return text
  return [
    { type: "image", source: { type: "base64", media_type: image.media_type, data: image.base64 } },
    { type: "text", text },
  ]
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
  setMessageHandler(async (text, image) => {
    sendThinking()
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: buildChannelContent(text, image),
        meta: { chat_id: getSessionId() },
      },
    })
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
