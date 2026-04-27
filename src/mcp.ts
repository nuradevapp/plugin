import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { sendReply, sendReplyWithDetail, sendPermissionRequest } from "./relay.js"

export const mcp = new Server(
  { name: "hackerassist", version: "1.0.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      'Messages from Hacker Assist arrive as <channel source="hackerassist" ...> tags. Two kinds:\n' +
      '1. Voice messages — the tag has a chat_id attribute. IMMEDIATELY call the reply tool with a brief acknowledgment (e.g. "On it!" or "Got it, working on it.") BEFORE doing any other work. Then do the work, and reply again when done.\n' +
      '   - Keep the `text` param concise (≤200 chars) — it is read aloud via text-to-speech.\n' +
      '   - If your reply is longer than 2 sentences, summarise it in `text` and put the full response in `full_content`.\n' +
      '2. System events — no chat_id attribute (pairing codes, connection status, tool status). Display the content verbatim (preserve line breaks and box drawing) and do NOT call the reply tool.',
  }
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "reply",
    description: "Send a reply to the Hacker Assist mobile app (hackerassist.com)",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Reply for text-to-speech — keep it concise, max ~200 chars",
        },
        full_content: {
          type: "string",
          description: "Full response shown when user taps the card. Use when reply is longer than 2 sentences.",
        },
        image_base64: {
          type: "string",
          description: "Base64-encoded image to display in the app alongside the text reply.",
        },
        image_media_type: {
          type: "string",
          description: "MIME type of the image (e.g. image/jpeg, image/png). Defaults to image/jpeg.",
        },
      },
      required: ["text"],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { text, full_content, image_base64, image_media_type } = req.params.arguments as {
      text: string
      full_content?: string
      image_base64?: string
      image_media_type?: string
    }
    const image = image_base64
      ? { base64: image_base64, media_type: image_media_type ?? "image/jpeg" }
      : undefined
    if (full_content) {
      sendReplyWithDetail(text, full_content, image)
    } else {
      sendReply(text, image)
    }
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

let mcpConnected = false
const pendingChannelEvents: Array<{ content: string; meta?: Record<string, unknown> }> = []

async function emitChannelEvent(content: string, meta?: Record<string, unknown>) {
  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content, meta: meta ?? {} },
  })
}

export function sendChannelEvent(content: string, meta?: Record<string, unknown>) {
  if (!mcpConnected) {
    pendingChannelEvents.push({ content, meta })
    return
  }
  emitChannelEvent(content, meta).catch(() => {})
}

export async function connectMcp() {
  await mcp.connect(new StdioServerTransport())
  mcpConnected = true
  while (pendingChannelEvents.length > 0) {
    const evt = pendingChannelEvents.shift()!
    await emitChannelEvent(evt.content, evt.meta)
  }
}
