import { describe, it, expect } from "bun:test"
import { buildChannelContent } from "../src/index.js"

describe("buildChannelContent", () => {
  it("returns text string when no image", () => {
    const result = buildChannelContent("hello", undefined)
    expect(result).toBe("hello")
  })

  it("returns multimodal array when image present", () => {
    const image = { base64: "abc123", media_type: "image/jpeg" }
    const result = buildChannelContent("hello", image) as [{ type: string }, { type: string }]
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "abc123" },
    })
    expect(result[1]).toEqual({ type: "text", text: "hello" })
  })

  it("image block comes before text block", () => {
    const image = { base64: "data", media_type: "image/png" }
    const result = buildChannelContent("caption", image) as [{ type: string }, { type: string }]
    expect(result[0].type).toBe("image")
    expect(result[1].type).toBe("text")
  })
})
