import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { readFileSync } from "fs"
import { basename, join } from "path"
import { z } from "zod"
import { sendReply, sendReplyWithDetail, sendPermissionRequest, requestPairingCode } from "./relay.js"
import { imageMediaTypeFromPath, mediaTypeFromPath } from "./attachments.js"

// Keep the MCP server version in lockstep with the plugin manifest instead of
// a second hand-maintained string.
function manifestVersion(): string {
  try {
    const raw = readFileSync(join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8")
    const v = (JSON.parse(raw) as { version?: string }).version
    if (v) return v
  } catch { /* fall through */ }
  return "0.0.0"
}

export const mcp = new Server(
  { name: "nuradev", version: manifestVersion() },
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
      '2. User messages (channel tag has a chat_id attribute): the user typed or spoke this on their phone. Process it exactly like a terminal-initiated turn — just start working and narrate naturally in text blocks. Do NOT inject synthetic acks ("On it!", "Got it") that you would not otherwise produce in a terminal session.\n' +
      '   2a. Attachments: if the channel content begins with "[image attached: <path>]" or "[file attached: <name> → <path>]", IMMEDIATELY call the Read tool on that path so you can see the image/file content, then proceed with the user instruction that follows on the next line.\n' +
      '\n' +
      'Text mirroring is automatic: every text block you write in the terminal is mirrored to the phone as a chat message by the plugin itself — the user sees your words without you doing anything. Do NOT call the reply tool to repeat, summarize, or acknowledge text you already wrote; it would appear twice on the phone.\n' +
      '\n' +
      'Progress cadence: since text blocks mirror automatically, narrate the way you would for a teammate watching the terminal — a brief text block every 2-3 tool calls stating what you just found, decided, or are about to do next. Never let a long tool-heavy stretch pass in silence, and never write filler ("still working", "one moment") — say something concrete or nothing.\n' +
      '\n' +
      'reply tool — attachments only: call it exclusively to send a file or image to the phone.\n' +
      '- `text`: short caption for the attachment (1 sentence).\n' +
      '- `image_path`: absolute path to an image to attach. STRONGLY PREFER this over `image_base64`. For screenshots (e.g. Playwright `browser_take_screenshot`), pass a `filename` so the file is saved to disk, then forward that path here.\n' +
      '- `file_path`: absolute path to a non-image file to attach (PDF, JSON, markdown, text, CSV, archives, etc.). Plugin reads, encodes, names, and detects media type from the file. Mutually exclusive with `image_path` / `image_base64`.\n' +
      '\n' +
      'Attaching written documents: when you write a markdown document for the user to read (a spec, plan, design doc, summary, review notes, etc.), attach it via `file_path` rather than only stating the path — the phone renders the markdown so the user can read it in place. This applies to user-facing documents for review, not to code, configs, or other working artifacts.',
  }
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Attach an image or file to the Nura Dev chat on the user's phone (nuradev.app). Terminal text blocks are mirrored to the phone automatically — call this ONLY to send an attachment, never to repeat text you already wrote.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Short caption shown with the attachment (1 sentence)",
          },
          full_content: {
            type: "string",
            description: "Optional long-form body shown when the user taps the card. Rarely needed — text blocks mirror automatically.",
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
          file_path: {
            type: "string",
            description: "Absolute path to a non-image file to attach (PDF, JSON, markdown, text, CSV, archives, etc.). Plugin reads the bytes, derives the filename from the path's basename, and detects the media type from the extension. Mutually exclusive with image_path / image_base64.",
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
    const { text, full_content, image_path, image_base64, image_media_type, file_path } = req.params.arguments as {
      text: string
      full_content?: string
      image_path?: string
      image_base64?: string
      image_media_type?: string
      file_path?: string
    }
    const imageProvided = !!(image_path || image_base64)
    if (file_path && imageProvided) {
      return {
        content: [{ type: "text", text: "file_path is mutually exclusive with image_path / image_base64" }],
        isError: true,
      }
    }
    let image: { base64: string; media_type: string } | undefined
    let file:  { base64: string; name: string; media_type: string } | undefined
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
    if (file_path) {
      try {
        const bytes = readFileSync(file_path)
        file = { base64: bytes.toString("base64"), name: basename(file_path), media_type: mediaTypeFromPath(file_path) }
      } catch (err) {
        return { content: [{ type: "text", text: `failed to read file_path ${file_path}: ${(err as Error).message}` }], isError: true }
      }
    }
    if (full_content) {
      sendReplyWithDetail(text, full_content, image, file)
    } else {
      sendReply(text, image, file)
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
