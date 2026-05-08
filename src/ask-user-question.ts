import type { AskUserQuestion } from "./types.js"

export function shouldRouteToPhone(questions: AskUserQuestion[]): boolean {
  if (!Array.isArray(questions) || questions.length === 0) return false
  return questions.every((q) => {
    if (q.multiSelect === true) return false
    return (q.options ?? []).every((o) => {
      const preview = (o as { preview?: unknown }).preview
      return preview === undefined
    })
  })
}

function escapeQuotes(s: string): string {
  return s.replace(/"/g, '\\"')
}

export function formatAnswerReason(answers: Record<string, string>): string {
  const pairs = Object.entries(answers)
    .map(([q, a]) => `"${escapeQuotes(q)}"="${escapeQuotes(a)}"`)
    .join(", ")
  return `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`
}

export function formatCancelReason(): string {
  return "User cancelled the question without answering. Do not retry; ask differently or proceed without the answer."
}
