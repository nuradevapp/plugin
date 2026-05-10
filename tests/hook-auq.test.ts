import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { startServer, type IpcConnection } from "../src/ipc"
import { handleAskUserQuestion } from "../src/hook"

function tmpSession(prefix: string): { sessionId: string; socketPath: string; cleanup: () => void } {
  const sessionId = prefix + "-" + Math.random().toString(36).slice(2, 10)
  const dir = mkdtempSync(join(tmpdir(), "nuradev-hookauq-"))
  return {
    sessionId,
    socketPath: join(dir, `nuradev-plugin.${sessionId}.sock`),
    cleanup() { try { rmSync(dir, { recursive: true, force: true }) } catch {} },
  }
}

const Q = [
  { question: "Pick one", header: "P", multiSelect: false, options: [{ label: "A", description: "" }] },
]

describe("handleAskUserQuestion (IPC)", () => {
  it("happy path: returns decision:block with the formatted reason", async () => {
    const t = tmpSession("happy")

    const server = await startServer(t.socketPath, (conn: IpcConnection, msg) => {
      if (msg.type === "ask_user_question") {
        conn.send({ type: "ask_user_question_verdict", request_id: msg.request_id, answers: { "Pick one": "A" } })
      }
    })

    const out = await handleAskUserQuestion(t.sessionId, { tool_input: { questions: Q } }, t.socketPath)
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!)
    expect(parsed.decision).toBe("block")
    expect(parsed.reason).toContain('"Pick one"="A"')

    await server.stop()
    t.cleanup()
  })

  it("multi-select: phone returns comma-joined string; reason renders it intact", async () => {
    const t = tmpSession("multi")
    const server = await startServer(t.socketPath, (conn, msg) => {
      if (msg.type === "ask_user_question") {
        conn.send({ type: "ask_user_question_verdict", request_id: msg.request_id, answers: { "Pick many": "A, B, C" } })
      }
    })

    const out = await handleAskUserQuestion(t.sessionId, { tool_input: { questions: [
      { question: "Pick many", header: "P", multiSelect: true, options: [{ label: "A", description: "" }] },
    ] } }, t.socketPath)

    expect(out).not.toBeNull()
    expect(JSON.parse(out!).reason).toContain('"Pick many"="A, B, C"')

    await server.stop()
    t.cleanup()
  })

  it("cancelled verdict produces the cancel reason text", async () => {
    const t = tmpSession("cancel")
    const server = await startServer(t.socketPath, (conn, msg) => {
      if (msg.type === "ask_user_question") {
        conn.send({ type: "ask_user_question_verdict", request_id: msg.request_id, cancelled: true })
      }
    })

    const out = await handleAskUserQuestion(t.sessionId, { tool_input: { questions: Q } }, t.socketPath)
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!)
    expect(parsed.decision).toBe("block")
    expect(parsed.reason).toMatch(/cancelled/i)

    await server.stop()
    t.cleanup()
  })

  it("returns null when no IPC server is running", async () => {
    const t = tmpSession("noserver")
    const out = await handleAskUserQuestion(t.sessionId, { tool_input: { questions: Q } }, t.socketPath)
    expect(out).toBeNull()
    t.cleanup()
  })

  it("returns null when the server closes before sending a verdict", async () => {
    const t = tmpSession("close")
    const server = await startServer(t.socketPath, (conn) => {
      // Accept the message but never respond; close the connection.
      setTimeout(() => conn.close(), 20)
    })

    const out = await handleAskUserQuestion(t.sessionId, { tool_input: { questions: Q } }, t.socketPath)
    expect(out).toBeNull()

    await server.stop()
    t.cleanup()
  })

  it("returns null when verdict has empty answers and is not cancelled", async () => {
    const t = tmpSession("empty")
    const server = await startServer(t.socketPath, (conn, msg) => {
      if (msg.type === "ask_user_question") {
        conn.send({ type: "ask_user_question_verdict", request_id: msg.request_id, answers: {} })
      }
    })

    const out = await handleAskUserQuestion(t.sessionId, { tool_input: { questions: Q } }, t.socketPath)
    expect(out).toBeNull()

    await server.stop()
    t.cleanup()
  })

  it("returns null when questions array is empty", async () => {
    const t = tmpSession("empty-q")
    const out = await handleAskUserQuestion(t.sessionId, { tool_input: { questions: [] } }, t.socketPath)
    expect(out).toBeNull()
    t.cleanup()
  })
})
