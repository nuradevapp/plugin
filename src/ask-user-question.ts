import type { AskUserQuestion } from "./types.js"

export function shouldRouteToPhone(questions: AskUserQuestion[]): boolean {
  return Array.isArray(questions) && questions.length > 0
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
