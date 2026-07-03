import { describe, it, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { buildEvents, shouldMirror, truncate } from "../src/hook"

describe("buildEvents — message phase (MessageDisplay)", () => {
  it("mirrors assistant text as a status message", () => {
    const out = buildEvents("sess1", "message", { text: "Found the bug in relay.ts, patching it now." })
    expect(out).toEqual([
      { type: "status", session_id: "sess1", text: "Found the bug in relay.ts, patching it now." },
    ])
  })

  it("truncates long text to 300 chars", () => {
    const out = buildEvents("sess1", "message", { text: "x".repeat(500) })
    expect((out[0] as any).text).toHaveLength(300)
    expect((out[0] as any).text.endsWith("…")).toBe(true)
  })

  it("drops empty or whitespace-only text", () => {
    expect(buildEvents("sess1", "message", { text: "  \n " })).toEqual([])
    expect(buildEvents("sess1", "message", {})).toEqual([])
  })
})

describe("buildEvents — session-end phase", () => {
  it("emits a session-ended status with reason", () => {
    const out = buildEvents("sess1", "session-end", { reason: "clear" })
    expect(out).toEqual([{ type: "status", session_id: "sess1", text: "○ Session ended (clear)" }])
  })

  it("emits a session-ended status without reason", () => {
    const out = buildEvents("sess1", "session-end", {})
    expect(out).toEqual([{ type: "status", session_id: "sess1", text: "○ Session ended" }])
  })
})

describe("buildEvents — notification phase", () => {
  it("forwards notification messages as status", () => {
    const out = buildEvents("sess1", "notification", {
      notification_type: "agent_needs_input",
      message: "Claude needs your input",
    })
    expect(out).toEqual([{ type: "status", session_id: "sess1", text: "🔔 Claude needs your input" }])
  })

  it("skips permission_prompt notifications — already relayed via channel permission relay", () => {
    const out = buildEvents("sess1", "notification", {
      notification_type: "permission_prompt",
      message: "Claude needs permission to use Bash",
    })
    expect(out).toEqual([])
  })

  it("drops empty messages", () => {
    expect(buildEvents("sess1", "notification", { notification_type: "idle_prompt" })).toEqual([])
  })
})

describe("buildEvents — stop-failure phase", () => {
  it("emits an API-error status with type and message", () => {
    const out = buildEvents("sess1", "stop-failure", {
      error_type: "rate_limit",
      error_message: "Rate limit exceeded",
    })
    expect(out).toEqual([
      { type: "status", session_id: "sess1", text: "⚠ Turn ended with API error (rate_limit): Rate limit exceeded" },
    ])
  })

  it("falls back to unknown error type", () => {
    const out = buildEvents("sess1", "stop-failure", {})
    expect(out).toEqual([{ type: "status", session_id: "sess1", text: "⚠ Turn ended with API error (unknown)" }])
  })
})

describe("buildEvents — failure phase (PostToolUseFailure)", () => {
  it("emits a failed status and closes the activity event as end", () => {
    const out = buildEvents("sess1", "failure", {
      tool_use_id: "tu_123",
      tool_name: "Read",
      tool_input: { file_path: "/a/config.ts" },
      timestamp: 1_700_000_000_000,
    })
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ type: "status", session_id: "sess1", text: "✗ Read config.ts — failed" })
    expect(out[1]).toMatchObject({
      type: "activity_event",
      session_id: "sess1",
      event: { id: "tu_123", phase: "end", tool: "Read", summary: "✗ Read config.ts — failed" },
    })
  })

  it("still hides our own plugin tools", () => {
    const out = buildEvents("sess1", "failure", {
      tool_use_id: "tu_1",
      tool_name: "mcp__plugin_nuradev_nuradev__reply",
      tool_input: {},
    })
    expect(out).toEqual([])
  })
})

describe("shouldMirror", () => {
  const statePath = () => join(mkdtempSync(join(tmpdir(), "nuradev-test-")), "state.json")

  it("sends the first text", () => {
    expect(shouldMirror("hello", statePath(), 1000)).toBe(true)
  })

  it("dedupes identical text", () => {
    const p = statePath()
    expect(shouldMirror("hello", p, 1000)).toBe(true)
    expect(shouldMirror("hello", p, 99999)).toBe(false)
  })

  it("throttles rapid-fire different text within 1s", () => {
    const p = statePath()
    expect(shouldMirror("chunk one", p, 1000)).toBe(true)
    expect(shouldMirror("chunk one two", p, 1500)).toBe(false)
    expect(shouldMirror("chunk one two three", p, 2100)).toBe(true)
  })
})

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("abc", 10)).toBe("abc")
  })

  it("cuts to max length with ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…")
    expect(truncate("abcdef", 4)).toHaveLength(4)
  })
})
