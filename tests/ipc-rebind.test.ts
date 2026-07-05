import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createRebindableServer, connectClient, type RebindableServer } from "../src/ipc"

// Regression: the plugin's phone socket is keyed by session id. When a new chat
// starts the session id changes, so the hook connects to a NEW socket path. If
// the server doesn't rebind to that path, every hook connection (AskUserQuestion
// routing AND text mirroring) silently fails with "Failed to connect".
describe("createRebindableServer — rebinds on session change", () => {
  let mgr: RebindableServer | null = null
  afterEach(async () => { await mgr?.stop(); mgr = null })

  const freshPath = () => join(mkdtempSync(join(tmpdir(), "nuradev-test-")), "plugin.sock")

  it("serves the current path after a rebind and drops the old one", async () => {
    const seen: any[] = []
    mgr = createRebindableServer((conn, msg) => {
      seen.push(msg)
      conn.send({ type: "ack" })
    })

    const pathA = freshPath()
    await mgr.rebind(pathA)
    expect(mgr.currentPath()).toBe(pathA)

    // A client reaches the server on path A.
    const a = await connectClient(pathA, 1000)
    a.close()

    // New session → new path. The server must follow.
    const pathB = freshPath()
    await mgr.rebind(pathB)
    expect(mgr.currentPath()).toBe(pathB)

    const b = await connectClient(pathB, 1000)
    b.close()

    // The old path is no longer served after rebind.
    await expect(connectClient(pathA, 500)).rejects.toThrow()
  })

  it("is a no-op when rebinding to the same path", async () => {
    mgr = createRebindableServer(() => {})
    const path = freshPath()
    await mgr.rebind(path)
    await mgr.rebind(path)
    expect(mgr.currentPath()).toBe(path)
    const c = await connectClient(path, 1000)
    c.close()
  })
})
