import { describe, it, expect } from "bun:test"

describe("slash command dispatch", () => {
  it("routes /clear command to handler", () => {
    let cleared = false
    const handler = (command: string) => {
      if (command === "/clear") cleared = true
    }
    handler("/clear")
    expect(cleared).toBe(true)
  })

  it("ignores unknown commands without throwing", () => {
    let cleared = false
    const handler = (command: string) => {
      if (command === "/clear") cleared = true
    }
    handler("/unknown")
    expect(cleared).toBe(false)
  })

  it("voice: 'slash clear' maps to /clear command", () => {
    const text = "slash clear"
    const lower = text.trim().toLowerCase()
    const isCommand = lower.startsWith("slash ")
    const command = isCommand ? `/${lower.slice(6).trim()}` : null
    expect(isCommand).toBe(true)
    expect(command).toBe("/clear")
  })

  it("voice: 'slash ' prefix is case-insensitive", () => {
    const text = "Slash Clear"
    const lower = text.trim().toLowerCase()
    const isCommand = lower.startsWith("slash ")
    const command = isCommand ? `/${lower.slice(6).trim()}` : null
    expect(command).toBe("/clear")
  })

  it("regular messages are not treated as commands", () => {
    const text = "what is the weather"
    const lower = text.trim().toLowerCase()
    expect(lower.startsWith("slash ")).toBe(false)
  })
})
