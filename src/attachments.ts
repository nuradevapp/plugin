import { mkdirSync, writeFileSync } from "fs"
import { randomUUID } from "crypto"
import { join } from "path"

export const ATTACH_DIR = "/tmp/nuradev-attachments"

const EXTS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/json": "json",
  "text/markdown": "md",
  "text/csv": "csv",
}

export function extFor(mediaType: string, fileName?: string): string {
  if (EXTS[mediaType]) return EXTS[mediaType]
  const m = fileName?.match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : "bin"
}

const MEDIA_BY_EXT: Record<string, string> = {
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  png:  "image/png",
  gif:  "image/gif",
  webp: "image/webp",
  pdf:  "application/pdf",
  txt:  "text/plain",
  md:   "text/markdown",
  csv:  "text/csv",
  json: "application/json",
  zip:  "application/zip",
}

function extOf(path: string): string {
  const m = path.match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : ""
}

export function mediaTypeFromPath(path: string): string {
  return MEDIA_BY_EXT[extOf(path)] ?? "application/octet-stream"
}

export function imageMediaTypeFromPath(path: string): string {
  return MEDIA_BY_EXT[extOf(path)] ?? "image/jpeg"
}

export function saveAttachment(base64: string, mediaType: string, fileName?: string): string {
  mkdirSync(ATTACH_DIR, { recursive: true })
  const ext = extFor(mediaType, fileName)
  const path = join(ATTACH_DIR, `${randomUUID()}.${ext}`)
  writeFileSync(path, Buffer.from(base64, "base64"))
  return path
}

export function formatAttachmentRef(
  text: string,
  kind: "image" | "file",
  path: string,
  name?: string
): string {
  const tag = kind === "image"
    ? `[image attached: ${path}]`
    : `[file attached: ${name ?? "unnamed"} → ${path}]`
  return text ? `${tag}\n${text}` : tag
}
