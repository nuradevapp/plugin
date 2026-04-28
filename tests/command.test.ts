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
  it("/clear clears activity but does NOT forward to Claude Code", () => {
    const cleared: number[] = []
    const channelCalls: Array<[string, Record<string, unknown> | undefined]> = []
    handleCommand("/clear", () => cleared.push(1), (cmd, meta) => channelCalls.push([cmd, meta]), () => "sess1")
    expect(cleared).toHaveLength(1)
    expect(channelCalls).toHaveLength(0)
  })

  it("skill commands are forwarded to Claude Code with chat_id set to session ID", () => {
    const cleared: number[] = []
    const channelCalls: Array<[string, Record<string, unknown> | undefined]> = []
    handleCommand("/reload-plugins", () => cleared.push(1), (cmd, meta) => channelCalls.push([cmd, meta]), () => "sess1")
    expect(cleared).toHaveLength(0)
    expect(channelCalls).toEqual([["/reload-plugins", { chat_id: "sess1" }]])
  })

  it("forwards without chat_id when session is not yet established", () => {
    const channelCalls: Array<[string, Record<string, unknown> | undefined]> = []
    handleCommand("/review", () => {}, (cmd, meta) => channelCalls.push([cmd, meta]), () => null)
    expect(channelCalls).toEqual([["/review", undefined]])
  })
})
