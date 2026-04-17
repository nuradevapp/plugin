import { connectRelay, setMessageHandler, setPermissionVerdictHandler, sendThinking } from "./relay.js"
import { mcp, connectMcp } from "./mcp.js"
import { randomUUID } from "crypto"

function generateChatId(): string {
  return randomUUID()
}

async function main() {
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
}

main()
