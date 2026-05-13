import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { readFileSync } from "fs"
import { z } from "zod"
import { sendReply, sendReplyWithDetail, sendPermissionRequest, requestPairingCode } from "./relay.js"
import { imageMediaTypeFromPath } from "./attachments.js"

export const mcp = new Server(
  { name: "nuradev", version: "2026.05.09.3" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      'Messages from Nura Dev arrive as <channel source="nuradev" ...> tags.\n' +
      '\n' +
      'Pair-state tracking: Watch system events for these content markers:\n' +
      '- "Nura Dev paired", "Nura Dev connected", or "Nura Dev reconnected" → PAIRED state.\n' +
      '- "Nura Dev disconnected" → UNPAIRED state.\n' +
      'Treat the session as UNPAIRED until you see a paired/connected/reconnected marker.\n' +
      '\n' +
      'Rules by message kind:\n' +
      '1. System events (channel tag without a chat_id attribute — pairing codes, connection status, tool status): display the content verbatim (preserve line breaks and box drawing). Do NOT call the reply tool. Update your pair-state tracking based on the content as described above.\n' +
      '2. Voice messages (channel tag has a chat_id attribute): the user spoke this. IMMEDIATELY call the reply tool with a brief ack ("On it!", "Got it") BEFORE doing any other work, so the phone gets fast audio feedback. Then do the work, narrating progress per the cadence rule below.\n' +
      '   2a. Attachments: if the channel content begins with "[image attached: <path>]" or "[file attached: <name> → <path>]", IMMEDIATELY call the Read tool on that path so you can see the image/file content, then proceed with the user instruction that follows on the next line.\n' +
      '\n' +
      'When PAIRED, mirror everything: you MUST call the reply tool for EVERY user-facing text block you produce — preambles like "Let me check...", interim updates between tool calls, acknowledgments, and final responses. Each text block becomes one reply call, in the order it would appear in the terminal. This applies to both voice-initiated AND terminal-initiated work. When UNPAIRED, do not call the reply tool at all.\n' +
      '\n' +
      'Progress cadence (PAIRED only): in addition to mirroring every text block (above), if you find yourself running tool calls without producing user-facing text, you MUST still call reply at intervals — at least every 2-3 tool calls (roughly every 15 seconds of activity). Never let a long tool-heavy stretch pass in silence. Each interim reply MUST be substantive: state what you just found, decided, or are about to do next (e.g. "Found the auth bug in middleware.ts, patching it now", "Three tests fail — looking at the first", "Read the relay, now checking the hook"). Do NOT send filler replies like "still working", "still digging", "one moment", "let me think", "almost done", or "working on it" — a reply that does not tell the user something concrete is worse than no reply.\n' +
      '\n' +
      'reply tool params:\n' +
      '- `text`: TTS-friendly summary, ≤200 chars (it is read aloud).\n' +
      '- `full_content`: the complete response, when longer than ~2 sentences.\n' +
      '- `image_path`: absolute path to an image file to attach. STRONGLY PREFER this over `image_base64`. For screenshots (e.g. Playwright `browser_take_screenshot`), pass a `filename` so the file is saved to disk, then forward that path here. Never inline base64 unless you already have raw bytes with no path.',
  }
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply to the Nura Dev mobile app (nuradev.app)",
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
          image_path: {
            type: "string",
            description: "Absolute path to an image file on disk to attach. Preferred over image_base64 — avoids piping large base64 strings through the model context. For Playwright screenshots, pass a filename to browser_take_screenshot and forward the resulting path here.",
          },
          image_base64: {
            type: "string",
            description: "Base64-encoded image. Use only when you already have raw bytes and no file path is available; otherwise prefer image_path.",
          },
          image_media_type: {
            type: "string",
            description: "MIME type of image_base64 (e.g. image/jpeg, image/png). Defaults to image/jpeg. Ignored when image_path is set (media type is inferred from the file extension).",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "request_pairing_code",
      description: "Ask the Nura Dev relay for a fresh pairing code so the user can connect their phone. The code arrives moments later as a system channel event with a box-drawing display — show it verbatim.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { text, full_content, image_path, image_base64, image_media_type } = req.params.arguments as {
      text: string
      full_content?: string
      image_path?: string
      image_base64?: string
      image_media_type?: string
    }
    let image: { base64: string; media_type: string } | undefined
    if (image_path) {
      try {
        const bytes = readFileSync(image_path)
        image = { base64: bytes.toString("base64"), media_type: imageMediaTypeFromPath(image_path) }
      } catch (err) {
        return { content: [{ type: "text", text: `failed to read image_path ${image_path}: ${(err as Error).message}` }], isError: true }
      }
    } else if (image_base64) {
      image = { base64: image_base64, media_type: image_media_type ?? "image/jpeg" }
    }
    if (full_content) {
      sendReplyWithDetail(text, full_content, image)
    } else {
      sendReply(text, image)
    }
    return { content: [{ type: "text", text: "sent" }] }
  }
  if (req.params.name === "request_pairing_code") {
    requestPairingCode()
    return { content: [{ type: "text", text: "Pairing code requested. It will appear as a system channel event in a moment." }] }
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
