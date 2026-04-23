import { homedir } from "os"
import { join } from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs"

const DIR = join(homedir(), ".hackerassist")
const FILE = join(DIR, "plugin-token.json")

export function readToken(): { pluginToken: string; pluginTokenId: string } | null {
  if (!existsSync(FILE)) {
    // One-time migration: fall back to the legacy token.json path used by older plugin versions.
    const legacy = join(DIR, "token.json")
    if (!existsSync(legacy)) return null
    try {
      const data = JSON.parse(readFileSync(legacy, "utf-8"))
      if (typeof data.pluginToken !== "string" || typeof data.pluginTokenId !== "string") return null
      writeToken(data.pluginToken, data.pluginTokenId)
      unlinkSync(legacy)
      process.stderr.write("hackerassist: migrated token file to plugin-token.json\n")
      return { pluginToken: data.pluginToken, pluginTokenId: data.pluginTokenId }
    } catch {
      return null
    }
  }
  try {
    const data = JSON.parse(readFileSync(FILE, "utf-8"))
    if (typeof data.pluginToken !== "string" || typeof data.pluginTokenId !== "string") return null
    return { pluginToken: data.pluginToken, pluginTokenId: data.pluginTokenId }
  } catch {
    return null
  }
}

export function writeToken(pluginToken: string, pluginTokenId: string): void {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(FILE, JSON.stringify({ pluginToken, pluginTokenId }), { mode: 0o600 })
    chmodSync(FILE, 0o600)
  } catch (err) {
    process.stderr.write(`warning: could not write plugin token file: ${(err as Error).message}\n`)
  }
}

export function deleteToken(): void {
  try { if (existsSync(FILE)) unlinkSync(FILE) } catch {}
}
