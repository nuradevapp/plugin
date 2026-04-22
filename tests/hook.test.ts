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

  it("emits task_update alongside status+activity for TaskCreate start", () => {
    const out = buildEvents("sess1", "start", {
      tool_use_id: "tu_9",
      tool_name: "TaskCreate",
      tool_input: { id: "t-1", title: "Ship it", status: "pending", description: "do a thing" },
      timestamp: 1,
    })
    const kinds = out.map((m) => m.type).sort()
    expect(kinds).toEqual(["activity_event", "status", "task_update"])
    const task = out.find((m) => m.type === "task_update") as any
    expect(task.task).toEqual({ id: "t-1", title: "Ship it", status: "pending", description: "do a thing" })
  })

  it("emits task_update alongside activity_event(end) for TaskUpdate end", () => {
    const out = buildEvents("sess1", "end", {
      tool_use_id: "tu_10",
      tool_name: "TaskUpdate",
      tool_input: { id: "t-1", title: "Ship it", status: "completed" },
      timestamp: 2,
    })
    const kinds = out.map((m) => m.type).sort()
    expect(kinds).toEqual(["activity_event", "task_update"])
    const task = out.find((m) => m.type === "task_update") as any
    expect(task.task.status).toBe("completed")
  })

  it("returns empty when tool_use_id is missing on a start phase", () => {
    const out = buildEvents("sess1", "start", { tool_name: "Read", tool_input: {}, timestamp: 1 } as any)
    expect(out).toEqual([])
  })
})
