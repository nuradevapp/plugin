import { existsSync, readFileSync } from "fs"
import { randomUUID } from "crypto"
import { formatActivity } from "./activity.js"
import { readToken } from "./token-file.js"
import {
  shouldRouteToPhone,
  formatAnswerReason,
  formatCancelReason,
} from "./ask-user-question.js"
import type { PluginMessage, TaskSummary, AskUserQuestion } from "./types.js"

const RELAY_URL = "wss://relay.nuradev.app"

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

const QUESTION_WS_URL = "wss://relay.nuradev.app"
const OPEN_TIMEOUT_MS = 3000

interface Verdict {
  request_id: string
  answers?: Record<string, string>
  cancelled?: boolean
}

export async function handleAskUserQuestion(
  sessionId: string,
  payload: HookPayload,
  cwd: string = process.cwd()
): Promise<string | null> {
  const questions = payload.tool_input?.questions as AskUserQuestion[] | undefined
  if (!questions || !shouldRouteToPhone(questions)) return null

  const token = readToken(cwd)
  if (!token) return null

  const request_id = randomUUID()
  const verdict = await connectAndAwait(token.pluginToken, sessionId, request_id, questions, true)
  if (!verdict) return null

  const reason = verdict.cancelled
    ? formatCancelReason()
    : formatAnswerReason(verdict.answers ?? {})

  return JSON.stringify({ decision: "block", reason })
}

async function connectAndAwait(
  pluginToken: string,
  sessionId: string,
  request_id: string,
  questions: AskUserQuestion[],
  allowReconnect: boolean
): Promise<Verdict | null> {
  const url = `${QUESTION_WS_URL}?client=question&pluginToken=${encodeURIComponent(pluginToken)}`

  return new Promise<Verdict | null>((resolve) => {
    let ws: WebSocket | null = null
    let openTimer: ReturnType<typeof setTimeout> | null = null
    let resolved = false

    const finish = (v: Verdict | null) => {
      if (resolved) return
      resolved = true
      if (openTimer) clearTimeout(openTimer)
      try { ws?.close() } catch { /* ignore */ }
      resolve(v)
    }

    try {
      ws = new WebSocket(url)
    } catch {
      finish(null)
      return
    }

    openTimer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS)

    ws.addEventListener("open", () => {
      if (openTimer) { clearTimeout(openTimer); openTimer = null }
      ws!.send(JSON.stringify({
        type: "ask_user_question",
        session_id: sessionId,
        request_id,
        questions,
      }))
    })

    ws.addEventListener("message", (ev) => {
      let data: { type?: string; request_id?: string; answers?: Record<string, string>; cancelled?: boolean }
      try { data = JSON.parse(ev.data as string) } catch { return }
      if (data?.type === "ask_user_question_verdict" && data.request_id === request_id) {
        finish({ request_id, answers: data.answers, cancelled: data.cancelled })
      }
    })

    ws.addEventListener("error", () => finish(null))
    ws.addEventListener("close", () => {
      if (resolved) return
      // Connection dropped before verdict arrived — try one reconnect with the same request_id.
      // The relay holds the verdict for ~30s for this case (see relay-side spec).
      if (allowReconnect) {
        connectAndAwait(pluginToken, sessionId, request_id, questions, false).then(finish)
      } else {
        finish(null)
      }
    })
  })
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
