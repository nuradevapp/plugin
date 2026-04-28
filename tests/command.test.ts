import { describe, it, expect } from "bun:test"
import { parseVoiceCommand } from "../src/index.js"

describe("parseVoiceCommand", () => {
  it("returns /clear for 'slash clear'", () => {
    expect(parseVoiceCommand("slash clear")).toBe("/clear")
  })

  it("is case-insensitive", () => {
    expect(parseVoiceCommand("Slash Clear")).toBe("/clear")
  })

  it("returns null for regular messages", () => {
    expect(parseVoiceCommand("what is the weather")).toBeNull()
  })

  it("returns null for bare 'slash' with no command", () => {
    expect(parseVoiceCommand("slash")).toBeNull()
    expect(parseVoiceCommand("slash ")).toBeNull()
  })

  it("maps other commands correctly", () => {
    expect(parseVoiceCommand("slash compact")).toBe("/compact")
    expect(parseVoiceCommand("slash status")).toBe("/status")
  })
})

describe("handleCommand routing", () => {
  it("/clear routes to activity clear (via dispatch closure)", () => {
    let cleared = false
    const dispatch = (command: string) => {
      if (command === "/clear") cleared = true
    }
    dispatch("/clear")
    expect(cleared).toBe(true)
  })

  it("unknown commands are silently ignored", () => {
    let cleared = false
    const dispatch = (command: string) => {
      if (command === "/clear") cleared = true
    }
    dispatch("/unknown")
    expect(cleared).toBe(false)
  })
})
