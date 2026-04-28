import { describe, it, expect } from "bun:test"
import { parseVoiceCommand, handleCommand } from "../src/index.js"

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
  it("/clear sends activity clear AND forwards /clear to Claude Code", () => {
    const cleared: number[] = []
    const channelEvents: string[] = []
    handleCommand("/clear", () => cleared.push(1), (cmd) => channelEvents.push(cmd))
    expect(cleared).toHaveLength(1)
    expect(channelEvents).toEqual(["/clear"])
  })

  it("unknown commands are forwarded to Claude Code but do not clear activity", () => {
    const cleared: number[] = []
    const channelEvents: string[] = []
    handleCommand("/compact", () => cleared.push(1), (cmd) => channelEvents.push(cmd))
    expect(cleared).toHaveLength(0)
    expect(channelEvents).toEqual(["/compact"])
  })
})
