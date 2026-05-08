import { describe, it, expect } from "bun:test"
import {
  shouldRouteToPhone,
  formatAnswerReason,
  formatCancelReason,
} from "../src/ask-user-question"

describe("shouldRouteToPhone", () => {
  it("returns true for a single single-select question with no preview", () => {
    expect(
      shouldRouteToPhone([
        {
          question: "Pick a color?",
          header: "Color",
          multiSelect: false,
          options: [
            { label: "Red", description: "warm" },
            { label: "Blue", description: "cool" },
          ],
        },
      ])
    ).toBe(true)
  })

  it("returns true when multiSelect is undefined (treated as false)", () => {
    expect(
      shouldRouteToPhone([
        {
          question: "Pick?",
          header: "Pick",
          options: [{ label: "A", description: "a" }],
        } as any,
      ])
    ).toBe(true)
  })

  it("returns true for 1-4 single-select questions", () => {
    const q = (n: number) => ({
      question: `Q${n}`,
      header: `H${n}`,
      multiSelect: false,
      options: [{ label: "x", description: "y" }],
    })
    expect(shouldRouteToPhone([q(1), q(2), q(3), q(4)])).toBe(true)
  })

  it("returns false when any question has multiSelect=true", () => {
    expect(
      shouldRouteToPhone([
        {
          question: "Q1",
          header: "H1",
          multiSelect: false,
          options: [{ label: "a", description: "" }],
        },
        {
          question: "Q2",
          header: "H2",
          multiSelect: true,
          options: [{ label: "x", description: "" }],
        },
      ])
    ).toBe(false)
  })

  it("returns false when any option has a preview field", () => {
    expect(
      shouldRouteToPhone([
        {
          question: "Q",
          header: "H",
          multiSelect: false,
          options: [{ label: "a", description: "", preview: "code" } as any],
        },
      ])
    ).toBe(false)
  })

  it("returns false on empty questions array", () => {
    expect(shouldRouteToPhone([])).toBe(false)
  })

  it("returns false when input is not an array", () => {
    expect(shouldRouteToPhone(undefined as any)).toBe(false)
    expect(shouldRouteToPhone(null as any)).toBe(false)
  })
})

describe("formatAnswerReason", () => {
  it("formats a single answer", () => {
    expect(formatAnswerReason({ "What color?": "Blue" })).toBe(
      'User has answered your questions: "What color?"="Blue". You can now continue with the user\'s answers in mind.'
    )
  })

  it("formats multiple answers comma-separated", () => {
    expect(formatAnswerReason({ Q1: "A1", Q2: "A2" })).toBe(
      'User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue with the user\'s answers in mind.'
    )
  })

  it("escapes embedded double quotes in the question or label", () => {
    expect(formatAnswerReason({ 'Pick "best"?': 'The "good" one' })).toBe(
      'User has answered your questions: "Pick \\"best\\"?"="The \\"good\\" one". You can now continue with the user\'s answers in mind.'
    )
  })
})

describe("formatCancelReason", () => {
  it("returns the canonical cancel string", () => {
    expect(formatCancelReason()).toBe(
      "User cancelled the question without answering. Do not retry; ask differently or proceed without the answer."
    )
  })
})
