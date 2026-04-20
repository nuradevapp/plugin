import { existsSync, statSync, unlinkSync, writeFileSync } from "fs"
import { basename } from "path"

const RELAY_URL = process.env.HACKER_ASSIST_RELAY_URL ?? "wss://relay.hackerassist.com"
const SESSION_FILE = "/tmp/hackerassist-session"
const ACK_FILE = "/tmp/hackerassist-acked"
const ACK_TTL_MS = 10 * 60 * 1000

export function toolNameToStatus(toolName: string, toolInput: Record<string, unknown>): string {
  const file = toolInput.file_path ? basename(toolInput.file_path as string) : null
  switch (toolName) {
    case "Read":     return file ? `Reading ${file}...`  : "Reading file..."
    case "Edit":     return file ? `Editing ${file}...`  : "Editing file..."
    case "Write":    return file ? `Editing ${file}...`  : "Editing file..."
    case "Glob":     return "Searching files..."
    case "Grep":     return "Searching code..."
    case "Bash":     return "Running command..."
    case "Agent":    return "Spawning agent..."
    case "WebSearch":
    case "WebFetch": return "Searching web..."
    default:         return "Working..."
  }
}

function isAckStale(): boolean {
  if (!existsSync(ACK_FILE)) return true
  return Date.now() - statSync(ACK_FILE).mtimeMs > ACK_TTL_MS
}

async function sendMessages(sessionId: string, messages: string[]) {
  const ws = new WebSocket(`${RELAY_URL}?client=status`)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("timeout")) }, 5000)
    ws.addEventListener("open", () => {
      for (const text of messages) {
        ws.send(JSON.stringify({ type: "status", session_id: sessionId, text }))
      }
      ws.close()
    })
    ws.addEventListener("close", () => { clearTimeout(timer); resolve() })
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e) })
  })
}

async function main() {
  const isStop = process.argv.includes("--stop")

  if (!existsSync(SESSION_FILE)) process.exit(0)
  const sessionId = (await Bun.file(SESSION_FILE).text()).trim()
  if (!sessionId) process.exit(0)

  const messages: string[] = []

  if (isStop) {
    messages.push("Done.")
    if (existsSync(ACK_FILE)) unlinkSync(ACK_FILE)
  } else {
    const raw = await Bun.stdin.text()
    let payload: { tool_name?: string; tool_input?: Record<string, unknown> } = {}
    try { payload = JSON.parse(raw) } catch { /* ignore malformed input */ }

    if (isAckStale()) {
      writeFileSync(ACK_FILE, Date.now().toString())
      messages.push("Got it, on it...")
    }
    messages.push(toolNameToStatus(payload.tool_name ?? "", payload.tool_input ?? {}))
  }

  await sendMessages(sessionId, messages)
}

if (import.meta.path === Bun.main) {
  main().catch(() => process.exit(0))
}
