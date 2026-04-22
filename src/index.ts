import {
  connectRelay,
  setMessageHandler,
  setPermissionVerdictHandler,
  setChannelEventHandler,
  sendThinking,
  sendActivityClear,
  destroyRelay,
} from "./relay.js"
import { mcp, connectMcp, sendChannelEvent } from "./mcp.js"
import { randomUUID } from "crypto"

function generateChatId(): string {
  return randomUUID()
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
  setMessageHandler(async (chat_id, text) => {
    const id = generateChatId()
    sendThinking()
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: text,
        meta: { chat_id: id },
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
