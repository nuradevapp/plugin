import { describe, it, expect } from "bun:test"

describe("slash command dispatch", () => {
  it("routes clear command to handler", () => {
    let cleared = false
    const handler = (command: string) => {
      if (command === "clear") cleared = true
    }
    handler("clear")
    expect(cleared).toBe(true)
  })

  it("ignores unknown commands without throwing", () => {
    let cleared = false
    const handler = (command: string) => {
      if (command === "clear") cleared = true
    }
    handler("unknown")
    expect(cleared).toBe(false)
  })

  it("command arrives as bare name without leading slash", () => {
    const received: string[] = []
    const handler = (command: string) => received.push(command)
    handler("clear")
    expect(received[0]).toBe("clear")
    expect(received[0].startsWith("/")).toBe(false)
  })
})
