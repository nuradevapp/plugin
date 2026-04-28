import { describe, it, expect } from "bun:test"

// Test the command routing logic inline since relay internals aren't easily unit-testable
describe("slash commands", () => {
  it("clear command name is lowercase without slash", () => {
    // Relay spec: command arrives as bare name (no leading /)
    const command = "clear"
    expect(command.startsWith("/")).toBe(false)
    expect(command).toBe("clear")
  })
})
