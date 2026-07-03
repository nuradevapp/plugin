import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { sendMirrorText } from "../src/hook"
import { startServer, type IpcServer } from "../src/ipc"

describe("sendMirrorText → IPC → plugin ack", () => {
  let server: IpcServer | null = null
  afterEach(async () => { await server?.stop(); server = null })

  const socketPath = () => join(mkdtempSync(join(tmpdir(), "nuradev-test-")), "plugin.sock")

  it("delivers the text and resolves true on ack", async () => {
    const path = socketPath()
    const received: any[] = []
    // Mirrors the index.ts IPC handler: reply upstream, then ack.
    server = await startServer(path, (conn, msg) => {
      received.push(msg)
      if (msg?.type === "mirror_text") conn.send({ type: "mirror_text_ack" })
    })
    const ok = await sendMirrorText("sess1", "Found the bug, patching now.", path)
    expect(ok).toBe(true)
    expect(received).toEqual([{ type: "mirror_text", session_id: "sess1", text: "Found the bug, patching now." }])
  })

  it("resolves false when no plugin process is listening", async () => {
    const ok = await sendMirrorText("sess1", "hello", join(tmpdir(), "nuradev-nonexistent.sock"))
    expect(ok).toBe(false)
  })

  it("resolves false when the server never acks", async () => {
    const path = socketPath()
    server = await startServer(path, () => { /* swallow silently */ })
    const ok = await sendMirrorText("sess1", "hello", path)
    expect(ok).toBe(false)
  }, 5000)
})
