import { describe, it, expect } from "bun:test"
import { formatActivity } from "../src/activity"

describe("formatActivity", () => {
  it("formats Read with basename", () => {
    expect(formatActivity("Read", { file_path: "/a/b/config.ts" }))
      .toEqual({ tool: "Read", summary: "Read config.ts" })
  })

  it("formats Read without path", () => {
    expect(formatActivity("Read", {}))
      .toEqual({ tool: "Read", summary: "Read" })
  })

  it("formats Edit as Edit <file>", () => {
    expect(formatActivity("Edit", { file_path: "/src/useTTS.ts" }))
      .toEqual({ tool: "Edit", summary: "Edit useTTS.ts" })
  })

  it("formats Write as Edit <file>", () => {
    expect(formatActivity("Write", { file_path: "/src/foo.ts" }))
      .toEqual({ tool: "Write", summary: "Edit foo.ts" })
  })

  it("formats Bash with truncated command", () => {
    const long = "x".repeat(80)
    const r = formatActivity("Bash", { command: long })
    expect(r.tool).toBe("Bash")
    expect(r.summary.startsWith("Bash: ")).toBe(true)
    expect(r.summary.length).toBeLessThanOrEqual(6 + 40 + 1)
    expect(r.summary.endsWith("…")).toBe(true)
  })

  it("formats Bash short command without ellipsis", () => {
    expect(formatActivity("Bash", { command: "bun test" }))
      .toEqual({ tool: "Bash", summary: "Bash: bun test" })
  })

  it("formats Grep with pattern", () => {
    expect(formatActivity("Grep", { pattern: "useRouter" }))
      .toEqual({ tool: "Grep", summary: 'Grep "useRouter"' })
  })

  it("formats Glob with pattern", () => {
    expect(formatActivity("Glob", { pattern: "**/*.tsx" }))
      .toEqual({ tool: "Glob", summary: "Glob **/*.tsx" })
  })

  it("formats Agent with subagent_type", () => {
    expect(formatActivity("Agent", { subagent_type: "Explore" }))
      .toEqual({ tool: "Agent", summary: "Agent: Explore" })
  })

  it("formats Agent without subagent_type", () => {
    expect(formatActivity("Agent", {}))
      .toEqual({ tool: "Agent", summary: "Agent" })
  })

  it("formats WebFetch with hostname", () => {
    expect(formatActivity("WebFetch", { url: "https://api.example.com/x" }))
      .toEqual({ tool: "WebFetch", summary: "Fetch api.example.com" })
  })

  it("formats WebSearch with query", () => {
    expect(formatActivity("WebSearch", { query: "claude hooks" }))
      .toEqual({ tool: "WebSearch", summary: 'Search "claude hooks"' })
  })

  it("formats TaskCreate with title", () => {
    expect(formatActivity("TaskCreate", { title: "Ship it" }))
      .toEqual({ tool: "TaskCreate", summary: "Task: Ship it" })
  })

  it("formats TaskUpdate with title and status", () => {
    expect(formatActivity("TaskUpdate", { title: "Ship it", status: "completed" }))
      .toEqual({ tool: "TaskUpdate", summary: "Task completed: Ship it" })
  })

  it("formats TaskList", () => {
    expect(formatActivity("TaskList", {}))
      .toEqual({ tool: "TaskList", summary: "Tasks" })
  })

  it("falls back to tool name for unknown tool", () => {
    expect(formatActivity("Quokka", {}))
      .toEqual({ tool: "Quokka", summary: "Quokka" })
  })
})
