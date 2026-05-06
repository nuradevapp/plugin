import { homedir } from "os"
import { join } from "path"
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs"

const DIR = join(homedir(), ".hackerassist")
const FILE = join(DIR, "token.json")

interface TokenData {
  pluginToken: string
  pluginTokenId?: string
}

export function loadToken(): string | null {
  try {
    if (!existsSync(FILE)) return null
    const data = JSON.parse(readFileSync(FILE, "utf8")) as TokenData
    return data.pluginToken ?? null
  } catch {
    return null
  }
}

export function saveToken(pluginToken: string, pluginTokenId?: string): void {
  mkdirSync(DIR, { recursive: true })
  const payload: TokenData = { pluginToken, pluginTokenId }
  writeFileSync(FILE, JSON.stringify(payload, null, 2), { mode: 0o600 })
}

export function clearToken(): void {
  try {
    if (existsSync(FILE)) unlinkSync(FILE)
  } catch {
    // best effort
  }
}
