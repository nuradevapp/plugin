import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { sendReply, sendPermissionRequest } from "./relay.js"

export const mcp = new Server(
  { name: "hacker-assist", version: "1.0.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      'Messages from Hacker Assist arrive as <channel source="hacker-assist" chat_id="...">. ' +
      "Always reply using the reply tool with the exact chat_id from the tag. " +
      "Be concise — replies are read aloud to the user via text-to-speech.",
  }
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "reply",
    description: "Send a reply to the Hacker Assist mobile app (hackerassist.com)",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "chat_id from the inbound channel tag" },
        text:    { type: "string", description: "Reply — keep it concise, it will be read aloud" },
      },
      required: ["chat_id", "text"],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    sendReply(chat_id, text)
    return { content: [{ type: "text", text: "sent" }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id:    z.string(),
    tool_name:     z.string(),
    description:   z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  sendPermissionRequest(params)
})

export async function connectMcp() {
  await mcp.connect(new StdioServerTransport())
}
