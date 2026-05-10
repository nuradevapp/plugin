import { existsSync, unlinkSync } from "fs"

export interface IpcConnection {
  send(obj: unknown): void
  onMessage(fn: (msg: any) => void): void
  onClose(fn: () => void): void
  close(): void
}

export interface IpcServer {
  stop(): Promise<void>
}

export type ServerMessageHandler = (conn: IpcConnection, msg: any) => void

export function getPluginSocketPath(sessionId: string): string {
  return `/tmp/nuradev-plugin.${sessionId}.sock`
}

interface FramerState {
  buffer: string
  emit: (msg: any) => void
}

function makeFramer(emit: (msg: any) => void): FramerState {
  return { buffer: "", emit }
}

function feed(state: FramerState, chunk: string) {
  state.buffer += chunk
  let idx: number
  while ((idx = state.buffer.indexOf("\n")) >= 0) {
    const line = state.buffer.slice(0, idx)
    state.buffer = state.buffer.slice(idx + 1)
    if (!line) continue
    try {
      state.emit(JSON.parse(line))
    } catch {
      // drop malformed frame
    }
  }
}

interface ConnData {
  framer: FramerState
  conn: IpcConnection
  closeFns: Array<() => void>
}

export async function startServer(
  socketPath: string,
  onMessage: ServerMessageHandler
): Promise<IpcServer> {
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath) } catch { /* ignore */ }
  }

  const decoder = new TextDecoder()

  const server = Bun.listen<ConnData>({
    unix: socketPath,
    socket: {
      open(socket) {
        const closeFns: Array<() => void> = []
        const conn: IpcConnection = {
          send(obj) { socket.write(JSON.stringify(obj) + "\n") },
          onMessage(_fn) { throw new Error("onMessage not available on server-side IpcConnection — use the startServer onMessage callback") },
          onClose(fn) { closeFns.push(fn) },
          close() { socket.end() },
        }
        const framer = makeFramer((msg) => onMessage(conn, msg))
        socket.data = { framer, conn, closeFns }
      },
      data(socket, buffer) {
        feed(socket.data.framer, decoder.decode(buffer))
      },
      close(socket) {
        socket.data?.closeFns.forEach((fn) => { try { fn() } catch { /* ignore */ } })
      },
      error(_socket, _err) { /* ignore */ },
    },
  })

  return {
    async stop() {
      server.stop(true)
    },
  }
}

export async function connectClient(
  socketPath: string,
  timeoutMs: number
): Promise<IpcConnection> {
  const decoder = new TextDecoder()
  let messageFn: ((m: any) => void) | null = null
  const closeFns: Array<() => void> = []

  const fireClose = () => closeFns.forEach((fn) => { try { fn() } catch { /* ignore */ } })

  const framer = makeFramer((msg) => { messageFn?.(msg) })

  const connectPromise = Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, buffer) { feed(framer, decoder.decode(buffer)) },
      close() { fireClose() },
      error() { fireClose() },
    },
  })

  let socket: Awaited<typeof connectPromise>
  try {
    socket = await Promise.race([
      connectPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`ipc connect timeout: ${socketPath}`)), timeoutMs),
      ),
    ])
  } catch (err) {
    // If the connect eventually resolves anyway, close the orphan.
    connectPromise.then((s) => { try { s.end() } catch { /* ignore */ } }).catch(() => {})
    throw err
  }

  return {
    send(obj) { socket.write(JSON.stringify(obj) + "\n") },
    onMessage(fn) { messageFn = fn },
    onClose(fn) { closeFns.push(fn) },
    close() { socket.end() },
  }
}
