import { describe, it, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { buildEvents, appendDelta, assembleFromLog, findBlockInTranscript, truncate } from "../src/hook"

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

describe("appendDelta + assembleFromLog", () => {
  const logPath = () => join(mkdtempSync(join(tmpdir(), "nuradev-test-")), "buf.log")

  it("assembles appended deltas in order", () => {
    const p = logPath()
    appendDelta(p, "m1:0", "The quick ")
    appendDelta(p, "m1:0", "brown ")
    appendDelta(p, "m1:0", "fox.")
    expect(assembleFromLog(p, "m1:0")).toBe("The quick brown fox.")
  })

  it("keeps other blocks' entries intact after assembling one", () => {
    const p = logPath()
    appendDelta(p, "m1:0", "first ")
    appendDelta(p, "m2:0", "second ")
    appendDelta(p, "m1:0", "block")
    expect(assembleFromLog(p, "m1:0")).toBe("first block")
    expect(assembleFromLog(p, "m2:0")).toBe("second ")
  })

  it("clears assembled entries so a repeated key starts fresh", () => {
    const p = logPath()
    appendDelta(p, "m1:0", "once")
    expect(assembleFromLog(p, "m1:0")).toBe("once")
    appendDelta(p, "m1:0", "twice")
    expect(assembleFromLog(p, "m1:0")).toBe("twice")
  })

  it("returns empty string when the log doesn't exist", () => {
    expect(assembleFromLog(join(tmpdir(), "nuradev-none.log"), "m1:0")).toBe("")
  })
})

describe("findBlockInTranscript", () => {
  const transcript = () => {
    const p = join(mkdtempSync(join(tmpdir(), "nuradev-test-")), "t.jsonl")
    const lines = [
      { type: "user", message: { content: "hi" } },
      { type: "assistant", uuid: "u1", message: { id: "msg_1", content: [{ type: "text", text: "Part one of the design.\n\nPart two looks good." }] } },
      { type: "assistant", uuid: "u2", message: { id: "msg_2", content: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "Running the tests now." }] } },
    ]
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    return p
  }

  it("recovers the full block from the final delta suffix", () => {
    expect(findBlockInTranscript(transcript(), "Part two looks good.")).toBe(
      "Part one of the design.\n\nPart two looks good.",
    )
  })

  it("matches newest-first and skips non-text content", () => {
    expect(findBlockInTranscript(transcript(), "the tests now.")).toBe("Running the tests now.")
  })

  it("returns null when nothing matches or the file is missing", () => {
    expect(findBlockInTranscript(transcript(), "no such tail")).toBeNull()
    expect(findBlockInTranscript(join(tmpdir(), "nuradev-none.jsonl"), "x")).toBeNull()
    expect(findBlockInTranscript(transcript(), "  ")).toBeNull()
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
