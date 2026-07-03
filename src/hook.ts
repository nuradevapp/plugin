import { existsSync, readFileSync, writeFileSync } from "fs"
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

// MessageDisplay delivers text as deltas per (message_id, index) with a
// `final` flag on the last one — usually a single final event carrying the
// whole block, but streamed display can split it. Each hook invocation is a
// fresh process, so partial blocks accumulate in a small per-session tmp
// file. Returns the assembled block when this event completes it, else null.
export function accumulateDelta(
  statePath: string,
  messageId: string,
  index: number,
  delta: string,
  final: boolean,
): string | null {
  const key = `${messageId}:${index}`
  let buf: Record<string, string> = {}
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"))
    if (parsed && typeof parsed === "object") buf = parsed
  } catch { /* no state yet */ }

  const assembled = (buf[key] ?? "") + delta
  if (final) {
    delete buf[key]
    try { writeFileSync(statePath, JSON.stringify(buf)) } catch { /* best effort */ }
    return assembled
  }
  buf[key] = assembled
  // A crashed stream could leave orphaned partials behind; don't let the
  // buffer file grow without bound.
  const keys = Object.keys(buf)
  if (keys.length > 32) delete buf[keys[0]]
  try { writeFileSync(statePath, JSON.stringify(buf)) } catch { /* best effort */ }
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

  // MessageDisplay: assemble streamed deltas, then hand the completed block to
  // the plugin process over IPC so it reaches the phone as a persisted chat
  // message. Falls back to an ephemeral status line when the plugin process
  // isn't reachable (e.g. an older plugin build is still running).
  if (phase === "message") {
    const delta = payload.delta ?? payload.text ?? ""
    const full = accumulateDelta(
      `/tmp/nuradev-msgbuf.${sessionId}.json`,
      payload.message_id ?? "m",
      payload.index ?? 0,
      delta,
      payload.final ?? true,
    )
    if (full === null || !full.trim()) process.exit(0)
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
