import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startServer, connectClient, getPluginSocketPath } from "../src/ipc"

function tmpSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nuradev-ipc-"))
  return join(dir, "p.sock")
}

describe("getPluginSocketPath", () => {
  it("returns a per-session path under /tmp", () => {
    expect(getPluginSocketPath("abc123")).toBe("/tmp/nuradev-plugin.abc123.sock")
  })
})

describe("ipc transport", () => {
  it("round-trips a message client → server", async () => {
    const path = tmpSocketPath()
    const received: any[] = []
    const server = await startServer(path, (_conn, msg) => { received.push(msg) })

    const client = await connectClient(path, 1000)
    client.send({ type: "hello", n: 1 })

    await new Promise((r) => setTimeout(r, 50))
    expect(received).toEqual([{ type: "hello", n: 1 }])

    client.close()
    await server.stop()
    rmSync(path, { force: true })
  })

  it("round-trips a message server → client", async () => {
    const path = tmpSocketPath()
    const got: any[] = []
    const server = await startServer(path, (conn, msg) => {
      if (msg.type === "ping") conn.send({ type: "pong", id: msg.id })
    })

    const client = await connectClient(path, 1000)
    client.onMessage((m) => got.push(m))
    client.send({ type: "ping", id: 7 })

    await new Promise((r) => setTimeout(r, 50))
    expect(got).toEqual([{ type: "pong", id: 7 }])

    client.close()
    await server.stop()
    rmSync(path, { force: true })
  })

  it("frames two back-to-back messages independently", async () => {
    const path = tmpSocketPath()
    const received: any[] = []
    const server = await startServer(path, (_conn, msg) => { received.push(msg) })

    const client = await connectClient(path, 1000)
    client.send({ a: 1 })
    client.send({ b: 2 })

    await new Promise((r) => setTimeout(r, 50))
    expect(received).toEqual([{ a: 1 }, { b: 2 }])

    client.close()
    await server.stop()
    rmSync(path, { force: true })
  })

  it("connectClient throws on a nonexistent socket path", async () => {
    await expect(connectClient("/tmp/nuradev-ipc-does-not-exist.sock", 200))
      .rejects.toThrow()
  })

  it("server unlinks a stale socket file on startup", async () => {
    const path = tmpSocketPath()
    const s1 = await startServer(path, () => {})
    await s1.stop()

    const received: any[] = []
    const s2 = await startServer(path, (_c, m) => { received.push(m) })
    const client = await connectClient(path, 1000)
    client.send({ ok: true })

    await new Promise((r) => setTimeout(r, 50))
    expect(received).toEqual([{ ok: true }])

    client.close()
    await s2.stop()
    rmSync(path, { force: true })
  })

  it("calls client onClose when the server stops", async () => {
    const path = tmpSocketPath()
    const server = await startServer(path, () => {})

    const client = await connectClient(path, 1000)
    let closed = false
    client.onClose(() => { closed = true })

    await server.stop()
    await new Promise((r) => setTimeout(r, 50))
    expect(closed).toBe(true)

    client.close()
    rmSync(path, { force: true })
  })

  it("closing one client doesn't affect others", async () => {
    const path = tmpSocketPath()
    const received: any[] = []
    const server = await startServer(path, (_conn, msg) => { received.push(msg) })

    const a = await connectClient(path, 1000)
    const b = await connectClient(path, 1000)

    a.close()
    await new Promise((r) => setTimeout(r, 30))

    b.send({ from: "b" })
    await new Promise((r) => setTimeout(r, 30))
    expect(received).toEqual([{ from: "b" }])

    b.close()
    await server.stop()
    rmSync(path, { force: true })
  })
})
