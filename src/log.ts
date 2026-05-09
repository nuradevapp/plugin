import { appendFileSync } from "fs"

const LOG_PATH = "/tmp/nuradev-plugin.log"

type Field = string | number | boolean | undefined | null

export function log(tag: string, fields: Record<string, Field> = {}) {
  const ts = new Date().toISOString()
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v === null ? "-" : v}`)
  const line = `${ts} [${tag}] ${parts.join(" ")}\n`
  try {
    appendFileSync(LOG_PATH, line)
  } catch {
    // ignore — disk full, perms, etc.
  }
}

export function len(v: unknown): number {
  return typeof v === "string" ? v.length : 0
}
