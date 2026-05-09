import { describe, it, expect } from "bun:test"
import { buildEvents } from "../src/hook"

const baseHook = {
  tool_use_id: "tu_123",
  tool_name: "Read",
  tool_input: { file_path: "/a/config.ts" },
  timestamp: 1_700_000_000_000,
}

describe("buildEvents", () => {
  it("emits status + activity_event(start) for PreToolUse", () => {
    const out = buildEvents("sess1", "start", baseHook)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ type: "status", session_id: "sess1", text: "Read config.ts" })
    expect(out[1]).toMatchObject({
      type: "activity_event",
      session_id: "sess1",
      event: { id: "tu_123", phase: "start", tool: "Read", summary: "Read config.ts", timestamp: 1_700_000_000_000 },
    })
  })

  it("emits activity_event(end) only for PostToolUse", () => {
    const out = buildEvents("sess1", "end", baseHook)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: "activity_event",
      event: { id: "tu_123", phase: "end", tool: "Read" },
    })
  })

  it("emits only a Done status on stop phase", () => {
    const out = buildEvents("sess1", "stop", {} as any)
    expect(out).toEqual([{ type: "status", session_id: "sess1", text: "Done." }])
  })

  it("emits only status+activity for TaskCreate start — ID not yet assigned", () => {
    const out = buildEvents("sess1", "start", {
      tool_use_id: "tu_9",
      tool_name: "TaskCreate",
      tool_input: { subject: "Ship it", description: "do a thing" },
      timestamp: 1,
    })
    const kinds = out.map((m) => m.type).sort()
    expect(kinds).toEqual(["activity_event", "status"])
  })

  it("emits task_update on TaskCreate end by parsing ID from tool_response", () => {
    const out = buildEvents("sess1", "end", {
      tool_use_id: "tu_9",
      tool_name: "TaskCreate",
      tool_input: { subject: "Ship it", description: "do a thing" },
      tool_response: "Task #42 created successfully: Ship it",
      timestamp: 1,
    })
    const kinds = out.map((m) => m.type).sort()
    expect(kinds).toEqual(["activity_event", "task_update"])
    const task = out.find((m) => m.type === "task_update") as any
    expect(task.task).toEqual({ id: "42", title: "Ship it", status: "pending", description: "do a thing" })
  })

  it("emits task_update alongside activity_event(end) for TaskUpdate with subject", () => {
    const out = buildEvents("sess1", "end", {
      tool_use_id: "tu_10",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "t-1", subject: "Ship it", status: "completed" },
      timestamp: 2,
    })
    const kinds = out.map((m) => m.type).sort()
    expect(kinds).toEqual(["activity_event", "task_update"])
    const task = out.find((m) => m.type === "task_update") as any
    expect(task.task.status).toBe("completed")
    expect(task.task.id).toBe("t-1")
  })

  it("emits task_update for TaskUpdate with status-only (no subject)", () => {
    const out = buildEvents("sess1", "end", {
      tool_use_id: "tu_11",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "t-2", status: "in_progress" },
      timestamp: 3,
    })
    const kinds = out.map((m) => m.type).sort()
    expect(kinds).toEqual(["activity_event", "task_update"])
    const task = out.find((m) => m.type === "task_update") as any
    expect(task.task).toEqual({ id: "t-2", status: "in_progress" })
  })

  it("returns empty when tool_use_id is missing on a start phase", () => {
    const out = buildEvents("sess1", "start", { tool_name: "Read", tool_input: {}, timestamp: 1 } as any)
    expect(out).toEqual([])
  })

  it("returns empty for AskUserQuestion on start phase", () => {
    expect(
      buildEvents("s1", "start", {
        tool_use_id: "tu_q",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [] },
        timestamp: 1,
      })
    ).toEqual([])
  })

  it("returns empty for AskUserQuestion on end phase", () => {
    expect(
      buildEvents("s1", "end", {
        tool_use_id: "tu_q",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [] },
        timestamp: 1,
      })
    ).toEqual([])
  })
})
