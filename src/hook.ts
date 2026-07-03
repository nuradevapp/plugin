import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync } from "fs"
import { randomUUID } from "crypto"
import { formatActivity } from "./activity.js"
import {
  shouldRouteToPhone,
  formatAnswerReason,
  formatCancelReason,
} from "./ask-user-question.js"
import { connectClient, getPluginSocketPath } from "./ipc.js"
import { log } from "./log.js"
import type { PluginMessage, TaskSummary, AskUserQuestion } from "./types.js"

// Users can point the plugin at a self-hosted relay via the plugin's
// `relay_url` userConfig option, exported by Claude Code as an env var.
const RELAY_URL = process.env.CLAUDE_PLUGIN_OPTION_RELAY_URL || "wss://relay.nuradev.app"

function getSessionFile(): string {
  try {
    // Hook's parent is the shell spawned by Claude Code; grandparent is Claude Code itself.
    // Plugin's parent is Claude Code directly. Both resolve to the same Claude Code PID.
    const parentPpid = parseInt(
      readFileSync(`/proc/${process.ppid}/status`, "utf8").match(/PPid:\s+(\d+)/)?.[1] ?? "0"
    )
    if (parentPpid > 0) return `/tmp/nuradev-session.${parentPpid}`
  } catch { /* fall through */ }
  return "/tmp/nuradev-session"
}

const SESSION_FILE = getSessionFile()

export type HookPhase =
  | "start"          // PreToolUse
  | "end"            // PostToolUse
  | "failure"        // PostToolUseFailure
  | "stop"           // Stop
  | "stop-failure"   // StopFailure (turn ended with an API error)
  | "session-start"  // SessionStart
  | "session-end"    // SessionEnd
  | "message"        // MessageDisplay (assistant text block shown in terminal)
  | "notification"   // Notification

const HOOK_PHASES: HookPhase[] = [
  "start", "end", "failure", "stop", "stop-failure",
  "session-start", "session-end", "message", "notification",
]

const SESSION_START_INSTRUCTION = `The user is on their phone via the nuradev plugin, not at the terminal. Every text block you write is mirrored to their phone automatically as a chat message — write natural terminal narration and it reaches them; nothing extra is required. Do NOT call the \`reply\` tool to repeat or summarize text you already wrote — it would appear twice on the phone. Use \`reply\` only to attach an image (\`image_path\`, e.g. Playwright screenshots) or a file (\`file_path\` — specs, plans, docs the user should read), with a short caption in \`text\`. Narrate frequently: a brief, concrete text block every few tool calls keeps the user informed while away from the terminal.`

export interface HookPayload {
  tool_use_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: string
  timestamp?: number
  transcript_path?: string    // all events
  text?: string               // MessageDisplay (assembled full block — set by main from deltas)
  delta?: string              // MessageDisplay (wire format: text arrives as deltas)
  final?: boolean             // MessageDisplay
  message_id?: string         // MessageDisplay
  index?: number              // MessageDisplay
  reason?: string             // SessionEnd
  notification_type?: string  // Notification
  message?: string            // Notification
  error?: string              // PostToolUseFailure
  error_type?: string         // StopFailure
  error_message?: string      // StopFailure
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}

// MessageDisplay delivers a streamed text block as many delta events, each in
// its OWN hook process, possibly running concurrently. A read-modify-write
// buffer file loses chunks when those processes race, so deltas go to an
// append-only log instead — O_APPEND writes are atomic, and the final event
// re-reads the log to assemble the block.
export function appendDelta(logPath: string, key: string, delta: string): void {
  try {
    // A stream that never got its final event (interrupt, crash) would leave
    // the log growing forever; reset rather than cap per-key.
    if (statSync(logPath).size > 1_000_000) unlinkSync(logPath)
  } catch { /* no log yet */ }
  try {
    appendFileSync(logPath, JSON.stringify({ key, delta }) + "\n")
  } catch { /* best effort */ }
}

export function assembleFromLog(logPath: string, key: string): string {
  let lines: string[] = []
  try {
    lines = readFileSync(logPath, "utf8").split("\n")
  } catch {
    return ""
  }
  const parts: string[] = []
  const rest: string[] = []
  for (const line of lines) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as { key?: string; delta?: string }
      if (entry.key === key && typeof entry.delta === "string") {
        parts.push(entry.delta)
        continue
      }
    } catch { continue }
    rest.push(line)
  }
  // Drop this block's entries; best effort — a concurrent append for another
  // block can be lost here, but blocks stream sequentially in practice.
  try { writeFileSync(logPath, rest.length ? rest.join("\n") + "\n" : "") } catch { /* ignore */ }
  return parts.join("")
}

// The transcript JSONL is the canonical copy of every assistant text block,
// immune to delta-log races. The MessageDisplay message_id is a display-stream
// id that does NOT appear in the transcript, so the block is located by
// matching the final delta as a suffix of the block text, newest-first.
export function findBlockInTranscript(transcriptPath: string, tailDelta: string): string | null {
  const tail = tailDelta.trim()
  if (!tail) return null
  let raw: string
  try {
    raw = readFileSync(transcriptPath, "utf8")
  } catch {
    return null
  }
  const lines = raw.split("\n").slice(-200)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue
    let entry: any
    try { entry = JSON.parse(lines[i]) } catch { continue }
    if (entry?.type !== "assistant") continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim().endsWith(tail)) {
        return block.text
      }
    }
  }
  return null
}

const TRANSCRIPT_RETRIES = 5
const TRANSCRIPT_RETRY_DELAY_MS = 150

// The final display event can fire before the transcript line is flushed.
async function findBlockWithRetry(transcriptPath: string | undefined, tailDelta: string): Promise<string | null> {
  if (!transcriptPath) return null
  for (let attempt = 0; attempt < TRANSCRIPT_RETRIES; attempt++) {
    const found = findBlockInTranscript(transcriptPath, tailDelta)
    if (found !== null) return found
    await new Promise((r) => setTimeout(r, TRANSCRIPT_RETRY_DELAY_MS))
  }
  return null
}

function toTaskSummary(input: Record<string, unknown>, fallbackStatus: TaskSummary["status"]): TaskSummary | null {
  const id = (input.taskId ?? input.id) as string | undefined
  if (!id) return null
  const title = (input.subject ?? input.title) as string | undefined
  const status = (input.status as TaskSummary["status"] | undefined) ?? fallbackStatus
  const description = input.description as string | undefined
  const t: TaskSummary = { id, status }
  if (title) t.title = title
  if (description) t.description = description
  return t
}

// True when the tool is one of this plugin's own MCP tools. Claude Code exposes
// them to the agent namespaced as `mcp__<server>__<tool>` (the server segment
// contains "nuradev"), so match on that shape rather than a hard-coded prefix.
const OWN_PLUGIN_TOOLS = ["reply", "request_pairing_code"]
export function isOwnPluginTool(toolName: string): boolean {
  if (!toolName.startsWith("mcp__") || !toolName.toLowerCase().includes("nuradev")) {
    return false
  }
  const leaf = toolName.split("__").pop() ?? ""
  return OWN_PLUGIN_TOOLS.includes(leaf)
}

export function buildEvents(
  sessionId: string,
  phase: HookPhase,
  payload: HookPayload
): PluginMessage[] {
  if (phase === "stop") {
    return [{ type: "status", session_id: sessionId, text: "Done." }]
  }

  if (phase === "message") {
    const text = (payload.text ?? "").trim()
    if (!text) return []
    return [{ type: "status", session_id: sessionId, text: truncate(text, 300) }]
  }

  if (phase === "session-end") {
    const reason = payload.reason
    return [{
      type: "status",
      session_id: sessionId,
      text: reason ? `○ Session ended (${reason})` : "○ Session ended",
    }]
  }

  if (phase === "notification") {
    // Permission prompts already reach the phone via the channel permission relay.
    if (payload.notification_type === "permission_prompt") return []
    const message = (payload.message ?? "").trim()
    if (!message) return []
    return [{ type: "status", session_id: sessionId, text: truncate(`🔔 ${message}`, 300) }]
  }

  if (phase === "stop-failure") {
    const kind = payload.error_type ?? "unknown"
    const detail = (payload.error_message ?? "").trim()
    return [{
      type: "status",
      session_id: sessionId,
      text: truncate(`⚠ Turn ended with API error (${kind})${detail ? `: ${detail}` : ""}`, 300),
    }]
  }

  const { tool_use_id, tool_name, tool_input, timestamp } = payload
  if (!tool_use_id || !tool_name) return []

  // AskUserQuestion is handled by the phone-routing path (handleAskUserQuestion in main)
  // or by the terminal menu. Either way, no activity feed entry.
  if (tool_name === "AskUserQuestion") return []

  // Our own MCP tools (reply, request_pairing_code) are internal plumbing — the
  // agent calling them is how it talks to the phone, not work worth surfacing.
  // The agent sees them namespaced like `mcp__…nuradev…__reply`.
  if (isOwnPluginTool(tool_name)) return []

  const { tool, summary } = formatActivity(tool_name, tool_input ?? {})
  const ts = timestamp ?? Date.now()

  const out: PluginMessage[] = []

  if (phase === "start") {
    out.push({ type: "status", session_id: sessionId, text: summary })
  }

  if (phase === "failure") {
    // The app's activity feed only knows start/end phases, so a failed call
    // closes as "end" with a marked summary, plus a status line for visibility.
    const failedSummary = truncate(`✗ ${summary} — failed`, 300)
    out.push({ type: "status", session_id: sessionId, text: failedSummary })
    out.push({
      type: "activity_event",
      session_id: sessionId,
      event: { id: tool_use_id, phase: "end", tool, summary: failedSummary, timestamp: ts },
    })
    return out
  }

  out.push({
    type: "activity_event",
    session_id: sessionId,
    event: { id: tool_use_id, phase: phase === "start" ? "start" : "end", tool, summary, timestamp: ts },
  })

  if (tool_name === "TaskCreate" && phase === "end") {
    // ID is assigned by Claude Code after creation; parse from response text "Task #N created ..."
    const match = (payload.tool_response ?? "").match(/Task #(\w+)/)
    const taskId = match?.[1]
    const title = (tool_input?.subject ?? tool_input?.title) as string | undefined
    if (taskId) {
      const t: TaskSummary = { id: taskId, status: "pending" }
      if (title) t.title = title
      const desc = tool_input?.description as string | undefined
      if (desc) t.description = desc
      out.push({ type: "task_update", session_id: sessionId, task: t })
    }
  } else if (tool_name === "TaskUpdate") {
    const task = toTaskSummary(tool_input ?? {}, "in_progress")
    if (task) out.push({ type: "task_update", session_id: sessionId, task })
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

const IPC_CONNECT_TIMEOUT_MS = 1000
const MIRROR_ACK_TIMEOUT_MS = 2000

// Deliver a completed assistant text block to the plugin process, which sends
// it up its authenticated relay connection as a persisted `reply`. Returns
// false when the plugin process can't be reached or doesn't ack in time.
export async function sendMirrorText(sessionId: string, text: string, socketPathOverride?: string): Promise<boolean> {
  let client
  try {
    client = await connectClient(socketPathOverride ?? getPluginSocketPath(sessionId), IPC_CONNECT_TIMEOUT_MS)
  } catch (err) {
    log("hook:mirror:no-ipc", { error: (err as Error).message })
    return false
  }
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client!.close() } catch { /* ignore */ }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), MIRROR_ACK_TIMEOUT_MS)
    client!.onMessage((m: any) => {
      if (m?.type === "mirror_text_ack") finish(true)
    })
    client!.onClose(() => finish(false))
    client!.send({ type: "mirror_text", session_id: sessionId, text })
  })
}

interface Verdict {
  request_id: string
  answers?: Record<string, string>
  cancelled?: boolean
}

export async function handleAskUserQuestion(
  sessionId: string,
  payload: HookPayload,
  socketPathOverride?: string,
): Promise<string | null> {
  const questions = payload.tool_input?.questions as AskUserQuestion[] | undefined
  if (!questions || !shouldRouteToPhone(questions)) {
    log("hook:auq:skip:gate", { has_questions: !!questions, n: questions?.length ?? 0 })
    return null
  }

  const socketPath = socketPathOverride ?? getPluginSocketPath(sessionId)
  const request_id = randomUUID()

  let client
  try {
    client = await connectClient(socketPath, IPC_CONNECT_TIMEOUT_MS)
  } catch (err) {
    log("hook:auq:skip:no-ipc", { socketPath, error: (err as Error).message })
    return null
  }

  const verdict = await new Promise<Verdict | null>((resolve) => {
    let settled = false
    const finish = (v: Verdict | null) => {
      if (settled) return
      settled = true
      try { client!.close() } catch { /* ignore */ }
      resolve(v)
    }
    client!.onMessage((m: any) => {
      if (m?.type === "ask_user_question_verdict" && m.request_id === request_id) {
        finish({ request_id, answers: m.answers, cancelled: m.cancelled })
      }
    })
    client!.onClose(() => finish(null))
    client!.send({ type: "ask_user_question", request_id, session_id: sessionId, questions })
  })

  if (!verdict) {
    log("hook:auq:skip:no-verdict", { request_id })
    return null
  }
  if (!verdict.cancelled && (!verdict.answers || Object.keys(verdict.answers).length === 0)) {
    log("hook:auq:skip:empty-verdict", { request_id })
    return null
  }

  const reason = verdict.cancelled
    ? formatCancelReason()
    : formatAnswerReason(verdict.answers ?? {})

  return JSON.stringify({ decision: "block", reason })
}

async function main() {
  const phaseArg = process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1]
    ?? (process.argv.includes("--stop") ? "stop" : "start")
  const phase = (phaseArg as HookPhase)
  if (!HOOK_PHASES.includes(phase)) {
    process.exit(0)
  }

  if (phase === "session-start") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: SESSION_START_INSTRUCTION,
      },
    }))
    process.exit(0)
  }

  if (!existsSync(SESSION_FILE)) process.exit(0)
  const sessionId = (await Bun.file(SESSION_FILE).text()).trim()
  if (!sessionId) process.exit(0)

  let payload: HookPayload = {}
  if (phase !== "stop") {
    const raw = await Bun.stdin.text()
    try { payload = JSON.parse(raw) as HookPayload } catch { /* ignore malformed input */ }
  }

  // MessageDisplay: buffer streamed deltas; on the final one, prefer the
  // complete block from the transcript (canonical), fall back to the
  // assembled deltas, and hand the result to the plugin process over IPC so
  // it reaches the phone as a persisted chat message. Falls back to an
  // ephemeral status line when the plugin process isn't reachable.
  if (phase === "message") {
    const delta = payload.delta ?? payload.text ?? ""
    const logPath = `/tmp/nuradev-msgbuf.${sessionId}.log`
    const key = `${payload.message_id ?? "m"}:${payload.index ?? 0}`
    const final = payload.final ?? true
    if (!final) {
      if (delta) appendDelta(logPath, key, delta)
      process.exit(0)
    }
    if (delta) appendDelta(logPath, key, delta)
    const assembled = assembleFromLog(logPath, key)
    const full = (await findBlockWithRetry(payload.transcript_path, delta || assembled)) ?? assembled
    if (!full.trim()) process.exit(0)
    if (await sendMirrorText(sessionId, full)) process.exit(0)
    payload.text = full // IPC unavailable — fall through to the status fallback
  }

  // AskUserQuestion mobile routing — only on start phase, only when paired and supported.
  if (phase === "start" && payload.tool_name === "AskUserQuestion") {
    const json = await handleAskUserQuestion(sessionId, payload)
    if (json) {
      process.stdout.write(json)
      process.exit(0)
    }
    // null → fall through to terminal (buildEvents returns [] for AUQ anyway, see Task 3)
  }

  const events = buildEvents(sessionId, phase, payload)
  try { await sendMessages(events) } catch { /* fire-and-forget */ }
}

if (import.meta.path === Bun.main) {
  main().catch(() => process.exit(0))
}
