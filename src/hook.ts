import { existsSync, readFileSync } from "fs"
import { randomUUID } from "crypto"
import { formatActivity } from "./activity.js"
import {
  shouldRouteToPhone,
  formatAnswerReason,
  formatCancelReason,
} from "./ask-user-question.js"
import { connectClient, getPluginSocketPath } from "./ipc.js"
import { log } from "./log.js"

const RELAY_URL = "wss://relay.nuradev.app"
import type { PluginMessage, TaskSummary, AskUserQuestion } from "./types.js"

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

export type HookPhase = "start" | "end" | "stop" | "session-start"

const SESSION_START_INSTRUCTION = `The nuradev voice plugin mirrors all of your text output to the user's phone for TTS playback. Because of this, your text output is the user-facing voice channel — treat it that way:

- Skip conversational filler and acknowledgments. Do not write "On it!", "Sure!", "Let me…", "I'll start by…", "Got it!", "Working on that now", or similar preamble before tool calls. Just call the tool.
- Do not narrate what you're about to do, what you just did, or what you're thinking. The activity hook already shows the user every tool call in real time.
- Only produce text output when you have something substantive for the user: the final answer, a question that needs their input, a blocker, or a meaningful status they couldn't infer from the activity feed.
- Keep substantive output tight — every sentence is being spoken aloud.`

export interface HookPayload {
  tool_use_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: string
  timestamp?: number
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

  // AskUserQuestion is handled by the phone-routing path (handleAskUserQuestion in main)
  // or by the terminal menu. Either way, no activity feed entry.
  if (tool_name === "AskUserQuestion") return []

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
  if (phase !== "start" && phase !== "end" && phase !== "stop" && phase !== "session-start") {
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
