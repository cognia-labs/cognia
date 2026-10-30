/** Test-only native boundary substitute; adapters and transports stay real. */
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import WebSocket, { WebSocketServer } from "ws"
import { setConnectorListen, type ConnectorListenFn } from "@/lib/connectors/events"
import {
  connectorsHttpRequest,
  setConnectorCommandInvoker,
  type ConnectorCommandInvoker,
  type TauriHttpRequest,
  type TauriHttpResponse,
} from "@/lib/connectors/tauri/commands"
import type { AdapterContext } from "@/types/connectors/adapter"
import { NativeConnectorBridge } from "./connector-native"

export interface WireRequest {
  method: string
  url: URL
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  raw: string
  bytes: Buffer
}
export interface WireResponse {
  status?: number
  body: unknown
  rawBytes?: Buffer
}
export interface WireFrame {
  socket: WebSocket
  body: Record<string, unknown>
}

const fixtureOwner: { current?: ConnectorLoopback } = {}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export async function waitFor(check: () => boolean, label: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export class ConnectorLoopback {
  readonly reportPath = path.resolve(".cache/test-results/im-loopback", `wire-${randomUUID()}.json`)
  readonly requests: WireRequest[] = []
  readonly frames: WireFrame[] = []
  readonly connections: Array<{ socket: WebSocket; url: string }> = []
  readonly clients = new Map<string, WebSocket>()
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>()
  readonly commands: Array<{ name: string; args?: Record<string, unknown> }> = []
  readonly errors: Error[] = []
  httpInFlight = 0
  private readonly handlers = new Set<Promise<void>>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly openingSockets = new Set<WebSocket>()
  private cleanupPromise?: Promise<void>
  private readonly outgoing = new Set<ReturnType<typeof request>>()
  private closed = false
  onHttp: (request: WireRequest) => WireResponse | Promise<WireResponse> = () => ({
    status: 404,
    body: { error: "Unexpected fixture request" },
  })
  onFrame: (frame: WireFrame) => void = () => {}
  onBinary: (socket: WebSocket, data: Buffer) => void = () => {
    throw new Error("Unexpected binary fixture frame")
  }
  onConnection: (socket: WebSocket) => void = () => {}
  onCommand?: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  origin = ""
  wsUrl = ""
  native?: NativeConnectorBridge
  get activeSocketCount() {
    return this.native?.handles.size ?? this.clients.size
  }
  private previousInvoker?: ConnectorCommandInvoker
  private previousListen?: ConnectorListenFn
  private readonly server = createServer((req, res) => {
    const work = this.handleHttp(req, res)
    this.handlers.add(work)
    void work.finally(() => this.handlers.delete(work))
  })
  private readonly handleHttp = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const raw = bytes.toString("utf8")
      const entry = {
        method: req.method ?? "GET",
        url: new URL(req.url ?? "/", this.origin),
        headers: req.headers,
        raw,
        bytes,
        body:
          raw &&
          !String(req.headers["content-type"]).includes("xml") &&
          !String(req.headers["content-type"]).includes("octet-stream")
            ? JSON.parse(raw)
            : {},
      }
      this.requests.push(entry)
      const reply = await this.onHttp(entry)
      if (!res.destroyed) {
        res.writeHead(reply.status ?? 200, {
          "content-type": reply.rawBytes ? "application/octet-stream" : "application/json",
        })
        res.end(reply.rawBytes ?? JSON.stringify(reply.body))
      }
    } catch (error) {
      this.errors.push(error as Error)
      if (!res.destroyed) {
        res.writeHead(500)
        res.end("fixture failure")
      }
    }
  }
  private readonly wss = new WebSocketServer({ server: this.server, path: "/ws" })

  constructor(private readonly testName?: string) {
    this.wss.on("connection", (socket, req) => {
      this.connections.push({ socket, url: req.url ?? "" })
      socket.on("error", (error) => this.errors.push(error))
      socket.on("message", (data, binary) => {
        try {
          if (binary) {
            this.onBinary(socket, Buffer.from(data as Buffer))
            return
          }
          const entry = { socket, body: JSON.parse(data.toString()) as Record<string, unknown> }
          this.frames.push(entry)
          this.onFrame(entry)
        } catch (error) {
          this.errors.push(error as Error)
        }
      })
      this.onConnection(socket)
    })
  }

  async open() {
    if (this.closed || fixtureOwner.current)
      throw new Error("A connector loopback fixture is already active or closed")
    fixtureOwner.current = this
    this.server.listen(0, "127.0.0.1")
    try {
      await once(this.server, "listening")
    } catch (error) {
      if (fixtureOwner.current === this) fixtureOwner.current = undefined
      throw error
    }
    const address = this.server.address()
    if (!address || typeof address === "string") throw new Error("Missing loopback port")
    this.origin = `http://127.0.0.1:${address.port}`
    this.wsUrl = `ws://127.0.0.1:${address.port}/ws`
    const listen: ConnectorListenFn = async <T>(
      topic: string,
      handler: (event: { payload: T }) => void
    ) => {
      const wrapped = (payload: unknown) => handler({ payload: payload as T })
      const handlers = this.listeners.get(topic) ?? new Set()
      handlers.add(wrapped)
      this.listeners.set(topic, handlers)
      return () => {
        handlers.delete(wrapped)
        if (!handlers.size) this.listeners.delete(topic)
      }
    }
    this.previousListen = setConnectorListen(listen)
    this.previousInvoker = setConnectorCommandInvoker(this.invoke)
    if (process.env.COGNIA_IM_NATIVE === "1") {
      this.native = new NativeConnectorBridge(
        this.origin,
        (topic, payload) => this.emit(topic, payload),
        this.testName
      )
      try {
        await this.native.start()
      } catch (error) {
        await this.close()
        throw error
      }
    }
    return this
  }

  emit(topic: string, payload: unknown) {
    for (const handler of this.listeners.get(topic) ?? []) handler(payload)
  }

  async flush(socket: WebSocket) {
    const tag = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onPong!: (data: Buffer) => void
    try {
      await new Promise<void>((resolve, reject) => {
        onPong = (data) => {
          if (data.toString() === tag) resolve()
        }
        socket.on("pong", onPong)
        timer = setTimeout(() => reject(new Error("Loopback peer did not flush")), 1000)
        socket.ping(tag)
      })
    } finally {
      clearTimeout(timer)
      socket.off("pong", onPong)
    }
  }

  readonly http = async (req: TauriHttpRequest): Promise<TauriHttpResponse> => {
    if (this.closed) throw new Error("Loopback fixture is closed")
    const destination = new URL(req.url)
    if (
      destination.origin !== this.origin &&
      !["https://api.dingtalk.com"].includes(destination.origin)
    ) {
      throw new Error(`Fixture refused outbound origin: ${destination.origin}`)
    }
    if (destination.pathname.startsWith("//")) throw new Error("Fixture refused ambiguous URL path")
    const url = new URL(this.origin)
    url.pathname = destination.pathname
    url.search = destination.search
    this.httpInFlight++
    try {
      if (this.native)
        return await this.native.call<TauriHttpResponse>("connectors_http_request", {
          req: { ...req, url: url.toString(), timeoutMs: req.timeoutMs ?? 5000 },
        })
      return await new Promise((resolve, reject) => {
        const outgoing = request(url, { method: req.method, headers: req.headers }, (incoming) => {
          const chunks: Buffer[] = []
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
          incoming.on("error", reject)
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: {},
              body: Buffer.concat(chunks).toString("utf8"),
            })
          )
        })
        this.outgoing.add(outgoing)
        outgoing.on("close", () => this.outgoing.delete(outgoing))
        outgoing.on("error", reject)
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error("Loopback HTTP timeout")))
        if (req.body) outgoing.write(req.body)
        outgoing.end()
      })
    } finally {
      this.httpInFlight--
    }
  }

  private async track<T>(work: Promise<T>): Promise<T> {
    this.work.add(work)
    try {
      return await work
    } finally {
      this.work.delete(work)
    }
  }

  private readonly invoke: ConnectorCommandInvoker = <T>(
    name: string,
    args?: Record<string, unknown>
  ) => this.track(this.dispatch<T>(name, args))

  private readonly dispatch: ConnectorCommandInvoker = async <T>(
    name: string,
    args?: Record<string, unknown>
  ): Promise<T> => {
    if (this.closed) throw new Error("Loopback fixture is closed")
    this.commands.push({ name, args })
    if (name === "connectors_http_request")
      return (await this.http(args!.req as TauriHttpRequest)) as T
    if (name === "connectors_ws_open") {
      const url = new URL(String(args?.url))
      if (url.origin !== new URL(this.wsUrl).origin || url.pathname !== "/ws")
        throw new Error("Fixture refused external WebSocket")
      if (this.native) return await this.native.call<T>(name, args)
      const socket = new WebSocket(url)
      this.openingSockets.add(socket)
      try {
        await once(socket, "open")
      } finally {
        this.openingSockets.delete(socket)
      }
      if (this.closed) {
        socket.terminate()
        throw new Error("Loopback fixture is closed")
      }
      const handle = randomUUID()
      this.clients.set(handle, socket)
      socket.on("message", (data) =>
        this.emit(`connectors://ws/${handle}/message`, data.toString())
      )
      socket.on("close", () => {
        this.clients.delete(handle)
        this.emit(`connectors://ws/${handle}/close`, undefined)
      })
      socket.on("error", (error) => this.errors.push(error))
      return handle as T
    }
    if (name === "connectors_ws_send") {
      if (this.native) return await this.native.call<T>(name, args)
      const socket = this.clients.get(String(args?.handleId))
      if (!socket || socket.readyState !== WebSocket.OPEN)
        throw new Error("Fixture socket is closed")
      await new Promise<void>((resolve, reject) =>
        socket.send(String(args?.data), (error) => (error ? reject(error) : resolve()))
      )
      return undefined as T
    }
    if (name === "connectors_ws_close") {
      if (this.native) return await this.native.call<T>(name, args)
      const socket = this.clients.get(String(args?.handleId))
      if (socket) {
        const closed = once(socket, "close")
        socket.close()
        await closed
      }
      return undefined as T
    }
    if (this.onCommand) return (await this.onCommand(name, args)) as T
    if (this.native) return await this.native.call<T>(name, args)
    throw new Error(`Unexpected fixture command: ${name}`)
  }

  context(
    adapterId: string,
    emit: AdapterContext["emit"],
    signal = new AbortController().signal
  ): AdapterContext {
    const unsupported = async (): Promise<never> => {
      throw new Error("Unexpected fixture context capability")
    }
    return {
      adapterId,
      emit: (event, options) => this.track(emit(event, options)),
      signal,
      tauri: {
        httpRequest: connectorsHttpRequest,
        openWs: unsupported,
        fetchAttachment: unsupported,
        bindWebhookRoute: unsupported,
        unbindWebhookRoute: unsupported,
        publicBaseUrl: unsupported,
      },
      secrets: { get: unsupported, set: unsupported, delete: unsupported, list: unsupported },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    }
  }

  close(): Promise<void> {
    return (this.cleanupPromise ??= this.cleanup())
  }

  private async cleanup() {
    this.closed = true
    const report = {
      schema: "cognia.im-loopback/1",
      test: this.testName ?? expect.getState().currentTestName,
      boundary: this.native
        ? "Production TypeScript adapters and real Rust HTTP/WS commands/events; admission and JS journal/checkpoint stores remain fixtures"
        : "Production TypeScript adapters and real loopback HTTP/WS; native bridge, admission and stores are test substitutes",
      native: Boolean(this.native),
      realPlatform: false,
      requests: this.requests.map((req) => ({ method: req.method, pathname: req.url.pathname })),
      frames: this.frames.map((frame) => ({ cmd: frame.body.cmd, code: frame.body.code })),
      connections: this.connections.length,
      clientsBeforeFixtureCleanup: this.clients.size,
      listenersBeforeFixtureCleanup: this.listeners.size,
      httpBeforeFixtureCleanup: this.httpInFlight,
      handlersBeforeFixtureCleanup: this.handlers.size,
      workBeforeFixtureCleanup: this.work.size,
    }
    try {
      for (const outgoing of this.outgoing) outgoing.destroy(new Error("Loopback fixture closed"))
      for (const socket of this.clients.values()) socket.terminate()
      for (const socket of this.openingSockets) socket.terminate()
      for (const socket of this.wss.clients) socket.terminate()
      await new Promise<void>((resolve) => this.wss.close(() => resolve()))
      this.server.closeAllConnections()
      await new Promise<void>((resolve) => this.server.close(() => resolve()))
      await this.native?.dispose()
      this.clients.clear()
      this.listeners.clear()
      let cleanupError: Error | undefined
      try {
        await waitFor(
          () =>
            this.httpInFlight === 0 &&
            this.handlers.size === 0 &&
            this.work.size === 0 &&
            this.openingSockets.size === 0,
          "HTTP fixture settlement",
          1000
        )
      } catch (error) {
        cleanupError = error as Error
      }
      const directory = path.dirname(this.reportPath)
      await mkdir(directory, { recursive: true })
      await writeFile(
        this.reportPath,
        JSON.stringify(
          {
            ...report,
            requests: this.requests.map((req) => ({
              method: ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(req.method)
                ? req.method
                : "OTHER",
              pathname: [
                "/message",
                "/owner",
                "/held",
                "/inbound",
                "/v1.0/gateway/connections/open",
                "/v1.0/robot/oToMessages/batchSend",
                "/ilink/bot/getupdates",
                "/ilink/bot/sendmessage",
                "/cgi-bin/message/custom/send",
              ].includes(req.url.pathname)
                ? req.url.pathname
                : "other-path",
            })),
            frames: this.frames.map((frame) => ({
              cmd:
                typeof frame.body.cmd === "string" &&
                ["aibot_subscribe", "aibot_respond_msg", "aibot_send_msg", "ping"].includes(
                  frame.body.cmd
                )
                  ? frame.body.cmd
                  : "other-frame",
              code:
                typeof frame.body.code === "number" &&
                Number.isInteger(frame.body.code) &&
                frame.body.code >= 100 &&
                frame.body.code < 600
                  ? frame.body.code
                  : undefined,
            })),
            httpAfterCleanup: this.httpInFlight,
            handlersAfterCleanup: this.handlers.size,
            workAfterCleanup: this.work.size,
            cleanupError: cleanupError?.message,
          },
          null,
          2
        ) + "\n"
      )
      if (cleanupError) throw cleanupError
    } finally {
      if (this.previousInvoker) setConnectorCommandInvoker(this.previousInvoker)
      if (this.previousListen) setConnectorListen(this.previousListen)
      if (fixtureOwner.current === this) fixtureOwner.current = undefined
    }
  }
}
