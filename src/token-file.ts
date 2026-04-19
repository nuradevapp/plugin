import { homedir } from "os"
import { join } from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs"

const DIR = join(homedir(), ".hackerassist")
const FILE = join(DIR, "plugin-token.json")

export function readToken(): { pluginToken: string; pluginTokenId: string } | null {
  if (!existsSync(FILE)) return null
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
