import { describe, it, expect } from "bun:test"
import { toolNameToStatus } from "../src/status"

describe("toolNameToStatus", () => {
  it("maps Read without path", () => {
    expect(toolNameToStatus("Read", {})).toBe("Reading file...")
  })

  it("maps Read with file_path to filename", () => {
    expect(toolNameToStatus("Read", { file_path: "/src/index.ts" })).toBe("Reading index.ts...")
  })

  it("maps Edit with file_path", () => {
    expect(toolNameToStatus("Edit", { file_path: "/src/mcp.ts" })).toBe("Editing mcp.ts...")
  })

  it("maps Write with file_path", () => {
    expect(toolNameToStatus("Write", { file_path: "/src/foo.ts" })).toBe("Editing foo.ts...")
  })

  it("maps Glob", () => {
    expect(toolNameToStatus("Glob", {})).toBe("Searching files...")
  })

  it("maps Grep", () => {
    expect(toolNameToStatus("Grep", {})).toBe("Searching code...")
  })

  it("maps Bash", () => {
    expect(toolNameToStatus("Bash", {})).toBe("Running command...")
  })

  it("maps Agent", () => {
    expect(toolNameToStatus("Agent", {})).toBe("Spawning agent...")
  })

  it("maps WebSearch", () => {
    expect(toolNameToStatus("WebSearch", {})).toBe("Searching web...")
  })

  it("maps WebFetch", () => {
    expect(toolNameToStatus("WebFetch", {})).toBe("Searching web...")
  })

  it("maps TaskCreate with title", () => {
    expect(toolNameToStatus("TaskCreate", { title: "Research auth options" })).toBe("Task: Research auth options")
  })

  it("maps TaskCreate without title", () => {
    expect(toolNameToStatus("TaskCreate", {})).toBe("Creating task...")
  })

  it("maps TaskUpdate with title and status", () => {
    expect(toolNameToStatus("TaskUpdate", { title: "Research auth options", status: "completed" })).toBe("Task completed: Research auth options")
  })

  it("maps TaskUpdate with title only", () => {
    expect(toolNameToStatus("TaskUpdate", { title: "Research auth options" })).toBe("Updating: Research auth options")
  })

  it("maps TaskUpdate without title", () => {
    expect(toolNameToStatus("TaskUpdate", {})).toBe("Updating task...")
  })

  it("maps TaskList", () => {
    expect(toolNameToStatus("TaskList", {})).toBe("Checking tasks...")
  })

  it("falls back for unknown tool", () => {
    expect(toolNameToStatus("SomethingUnknown", {})).toBe("Working...")
  })
})
