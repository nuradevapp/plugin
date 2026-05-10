import { describe, it, expect } from "bun:test"
import { createBroker } from "../src/plugin-auq"
import type { IpcConnection } from "../src/ipc"
import type { PluginMessage } from "../src/types"

function fakeConn(): IpcConnection & { sent: any[]; closeFns: Array<() => void> } {
  const sent: any[] = []
  const closeFns: Array<() => void> = []
  return {
    sent,
    closeFns,
    send(obj) { sent.push(obj) },
    onMessage(_fn) { /* unused in broker */ },
    onClose(fn) { closeFns.push(fn) },
    close() { closeFns.forEach((fn) => fn()) },
  }
}

describe("plugin-auq broker", () => {
  it("forwards ask_user_question from IPC to relay", () => {
    const sentToRelay: PluginMessage[] = []
    const broker = createBroker({ sendToRelay: (m) => sentToRelay.push(m) })
    const conn = fakeConn()

    broker.onIpcMessage(conn, {
      type: "ask_user_question",
      request_id: "r1",
      session_id: "s1",
      questions: [{ question: "Q", header: "H", multiSelect: false, options: [] }],
    })

    expect(sentToRelay).toHaveLength(1)
    expect(sentToRelay[0]).toMatchObject({
      type: "ask_user_question",
      session_id: "s1",
      request_id: "r1",
    })
  })

  it("routes a verdict to the matching IPC connection and drops the entry", () => {
    const sentToRelay: PluginMessage[] = []
    const broker = createBroker({ sendToRelay: (m) => sentToRelay.push(m) })
    const conn = fakeConn()

    broker.onIpcMessage(conn, {
      type: "ask_user_question",
      request_id: "r1",
      session_id: "s1",
      questions: [],
    })

    broker.onRelayVerdict({ type: "ask_user_question_verdict", request_id: "r1", answers: { Q: "A" } })

    expect(conn.sent).toEqual([
      { type: "ask_user_question_verdict", request_id: "r1", answers: { Q: "A" } },
    ])

    // Second verdict for same request_id is a no-op (entry was removed).
    broker.onRelayVerdict({ type: "ask_user_question_verdict", request_id: "r1", answers: { Q: "B" } })
    expect(conn.sent).toHaveLength(1)
  })

  it("drops a verdict for an unknown request_id without throwing", () => {
    const broker = createBroker({ sendToRelay: () => {} })
    expect(() =>
      broker.onRelayVerdict({ type: "ask_user_question_verdict", request_id: "ghost", answers: {} })
    ).not.toThrow()
  })

  it("on IPC close before verdict, sends cancel_ask_user_question and removes entry", () => {
    const sentToRelay: PluginMessage[] = []
    const broker = createBroker({ sendToRelay: (m) => sentToRelay.push(m) })
    const conn = fakeConn()

    broker.onIpcMessage(conn, {
      type: "ask_user_question",
      request_id: "r1",
      session_id: "s1",
      questions: [],
    })

    // Simulate IPC close.
    conn.closeFns.forEach((fn) => fn())

    expect(sentToRelay).toEqual([
      expect.objectContaining({ type: "ask_user_question", request_id: "r1" }),
      { type: "cancel_ask_user_question", session_id: "s1", request_id: "r1" },
    ])

    // Late verdict for the closed request is dropped.
    broker.onRelayVerdict({ type: "ask_user_question_verdict", request_id: "r1", answers: { Q: "A" } })
    expect(conn.sent).toHaveLength(0)
  })

  it("routes concurrent requests independently", () => {
    const broker = createBroker({ sendToRelay: () => {} })
    const a = fakeConn()
    const b = fakeConn()

    broker.onIpcMessage(a, { type: "ask_user_question", request_id: "r1", session_id: "s1", questions: [] })
    broker.onIpcMessage(b, { type: "ask_user_question", request_id: "r2", session_id: "s1", questions: [] })

    broker.onRelayVerdict({ type: "ask_user_question_verdict", request_id: "r2", answers: { X: "Y" } })
    expect(b.sent).toHaveLength(1)
    expect(a.sent).toHaveLength(0)

    broker.onRelayVerdict({ type: "ask_user_question_verdict", request_id: "r1", cancelled: true })
    expect(a.sent).toHaveLength(1)
    expect(a.sent[0]).toMatchObject({ request_id: "r1", cancelled: true })
  })
})
