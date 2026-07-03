import { homedir } from "os"
import { join } from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, copyFileSync } from "fs"

// Prefer Claude Code's per-plugin persistent data directory (survives plugin
// updates, cleaned up on uninstall). Fall back to the legacy ~/.nuradev
// location on hosts/versions that don't export CLAUDE_PLUGIN_DATA.
const LEGACY_DIR = join(homedir(), ".nuradev")
const DIR = process.env.CLAUDE_PLUGIN_DATA || LEGACY_DIR
const FILE = join(DIR, "plugin-token.json")
const LEGACY_FILE = join(LEGACY_DIR, "plugin-token.json")

function migrateLegacyFile(): void {
  if (FILE === LEGACY_FILE || existsSync(FILE) || !existsSync(LEGACY_FILE)) return
  try {
    mkdirSync(DIR, { recursive: true })
    copyFileSync(LEGACY_FILE, FILE)
    chmodSync(FILE, 0o600)
  } catch { /* keep reading from legacy on failure */ }
}

interface TokenEntry {
  directory: string
  pluginToken: string
  pluginTokenId: string
  sessionId: string
}

function isValidEntry(e: unknown): e is TokenEntry {
  return (
    typeof e === "object" && e !== null &&
    typeof (e as TokenEntry).directory === "string" &&
    typeof (e as TokenEntry).pluginToken === "string" &&
    typeof (e as TokenEntry).pluginTokenId === "string" &&
    typeof (e as TokenEntry).sessionId === "string"
  )
}

function readAll(): TokenEntry[] {
  migrateLegacyFile()
  const path = existsSync(FILE) ? FILE : LEGACY_FILE
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"))
    if (Array.isArray(data)) return data.filter(isValidEntry)
    return []
  } catch {
    return []
  }
}

function writeAll(entries: TokenEntry[]): void {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(FILE, JSON.stringify(entries, null, 2), { mode: 0o600 })
    chmodSync(FILE, 0o600)
  } catch (err) {
    process.stderr.write(`warning: could not write plugin token file: ${(err as Error).message}\n`)
  }
}

export function readToken(directory: string): { pluginToken: string; pluginTokenId: string; sessionId: string } | null {
  const entry = readAll().find(e => e.directory === directory)
  return entry ? { pluginToken: entry.pluginToken, pluginTokenId: entry.pluginTokenId, sessionId: entry.sessionId } : null
}

export function writeToken(directory: string, pluginToken: string, pluginTokenId: string, sessionId: string): void {
  const entries = readAll()
  const idx = entries.findIndex(e => e.directory === directory)
  const entry: TokenEntry = { directory, pluginToken, pluginTokenId, sessionId }
  if (idx >= 0) {
    entries[idx] = entry
  } else {
    entries.push(entry)
  }
  writeAll(entries)
}

export function updateSessionId(directory: string, sessionId: string): void {
  const entries = readAll()
  const idx = entries.findIndex(e => e.directory === directory)
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], sessionId }
    writeAll(entries)
  }
}

export function deleteToken(directory: string): void {
  const entries = readAll().filter(e => e.directory !== directory)
  writeAll(entries)
}
