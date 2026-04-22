import { existsSync } from "fs"
import { formatActivity } from "./activity.js"
import type { PluginMessage, TaskSummary } from "./types.js"

const RELAY_URL = process.env.HACKER_ASSIST_RELAY_URL ?? "wss://relay.hackerassist.com"
const SESSION_FILE = "/tmp/hackerassist-session"

export type HookPhase = "start" | "end" | "stop"

export interface HookPayload {
  tool_use_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  timestamp?: number
}

function toTaskSummary(input: Record<string, unknown>, fallbackStatus: TaskSummary["status"]): TaskSummary | null {
  const id = input.id as string | undefined
  const title = input.title as string | undefined
  if (!id || !title) return null
  const status = (input.status as TaskSummary["status"] | undefined) ?? fallbackStatus
  const description = input.description as string | undefined
  const t: TaskSummary = { id, title, status }
  if (description) t.description = description
  return t
}

export function buildEvents(
  sessionId: string,
  phase: HookPhase,
  payload: HookPayload
): PluginMessage[] {
  if (phase === "stop") {
    return [{ type: "status", session_id: sessionId, text: "Done." }]
  }

  const { tool_use_id, tool_name, tool_input, timestamp } = payload
  if (!tool_use_id || !tool_name) return []

  const { tool, summary } = formatActivity(tool_name, tool_input ?? {})
  const ts = timestamp ?? Date.now()

  const out: PluginMessage[] = []

  if (phase === "start") {
    out.push({ type: "status", session_id: sessionId, text: summary })
  }

  out.push({
    type: "activity_event",
    session_id: sessionId,
    event: { id: tool_use_id, phase, tool, summary, timestamp: ts },
  })

  if (tool_name === "TaskCreate" || tool_name === "TaskUpdate") {
    const fallback = tool_name === "TaskCreate" ? "pending" : "in_progress"
    const task = toTaskSummary(tool_input ?? {}, fallback)
    if (task) {
      out.push({ type: "task_update", session_id: sessionId, task })
    }
  }

  return out
}

async function sendMessages(messages: PluginMessage[]): Promise<void> {
  if (messages.length === 0) return
  const ws = new WebSocket(`${RELAY_URL}?client=status`)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("timeout")) }, 5000)
    ws.addEventListener("open", () => {
      for (const m of messages) ws.send(JSON.stringify(m))
      ws.close()
    })
    ws.addEventListener("close", () => { clearTimeout(timer); resolve() })
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e as unknown as Error) })
  })
}

async function main() {
  const phaseArg = process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1]
    ?? (process.argv.includes("--stop") ? "stop" : "start")
  const phase = (phaseArg as HookPhase)
  if (phase !== "start" && phase !== "end" && phase !== "stop") process.exit(0)

  if (!existsSync(SESSION_FILE)) process.exit(0)
  const sessionId = (await Bun.file(SESSION_FILE).text()).trim()
  if (!sessionId) process.exit(0)

  let payload: HookPayload = {}
  if (phase !== "stop") {
    const raw = await Bun.stdin.text()
    try { payload = JSON.parse(raw) as HookPayload } catch { /* ignore malformed input */ }
  }

  const events = buildEvents(sessionId, phase, payload)
  try { await sendMessages(events) } catch { /* fire-and-forget */ }
}

if (import.meta.path === Bun.main) {
  main().catch(() => process.exit(0))
}
