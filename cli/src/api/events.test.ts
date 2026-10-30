import { directEvents, channelMatches } from "./events"
import type { WorkerWebSocket } from "../worker/worker-connect"

function socket() {
  const handlers = new Map<string, (event: { data?: unknown }) => void>()
  const value: WorkerWebSocket & { frame: (value: unknown) => void; emit: (type: string) => void } =
    {
      send: jest.fn(),
      close: jest.fn(),
      addEventListener: (type, callback) => {
        handlers.set(type, callback)
      },
      frame: (data) => handlers.get("message")?.({ data: JSON.stringify(data) }),
      emit: (type) => handlers.get(type)?.({}),
    }
  return value
}

describe("authenticated non-TUI events", () => {
  it("subscribes before replay, deduplicates batches and stops at a bound", async () => {
    const ws = socket()
    const urls: string[] = []
    const frames: unknown[] = []
    const result = directEvents(
      {
        endpoint: "https://host.test",
        serviceToken: "synthetic",
        socket: (url) => {
          urls.push(url)
          queueMicrotask(() => {
            ws.frame({
              type: "event_batch",
              frames: [
                { type: "a", seq: 2, payload: 1 },
                { type: "a", seq: 2, payload: 1 },
                { type: "a", seq: 3, payload: 2 },
              ],
            })
          })
          return ws
        },
      },
      {
        channels: ["a"],
        since: 1,
        maxEvents: 2,
        onEvent: (event) => frames.push(event),
        timeoutMs: 1000,
      }
    )
    await expect(result).resolves.toEqual({ ok: true, result: { cursor: 3, count: 2 } })
    expect(new URL(urls[0]).searchParams.get("channels")).toBe("a")
    expect(new URL(urls[0]).searchParams.get("since")).toBe("1")
    expect(frames).toHaveLength(2)
    expect(ws.close).toHaveBeenCalled()
  })
  it("surfaces an event retention gap without advancing the checkpoint", async () => {
    const ws = socket()
    const onEvent = jest.fn()
    const result = directEvents(
      {
        endpoint: "https://host.test",
        serviceToken: "synthetic",
        socket: () => {
          queueMicrotask(() => ws.frame({ type: "resync_required", cursor: 9 }))
          return ws
        },
      },
      { channels: ["a"], since: 1, onEvent, timeoutMs: 1000 }
    )
    await expect(result).resolves.toMatchObject({ ok: false, code: "resync_required" })
    expect(onEvent).not.toHaveBeenCalled()
  })
  it("never opens a socket when a device ticket is refused", async () => {
    const open = jest.fn()
    await expect(
      directEvents(
        {
          endpoint: "https://host.test",
          ticket: async () => ({ ok: false, cause: "auth", message: "revoked" }),
          socket: open,
        },
        { channels: ["a"], onEvent: () => {}, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({ ok: false, cause: "auth" })
    expect(open).not.toHaveBeenCalled()
  })
  it("aborts a pending stream and closes its socket", async () => {
    const ws = socket()
    const controller = new AbortController()
    const pending = directEvents(
      { endpoint: "https://host.test", serviceToken: "synthetic", socket: () => ws },
      { channels: ["a"], onEvent: () => {}, signal: controller.signal, timeoutMs: 1000 }
    )
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, cause: "timeout" })
    expect(ws.close).toHaveBeenCalled()
  })
})

it("reconnects from the stream-ready boundary even if no prior event matched", async () => {
  const first = socket(),
    second = socket(),
    urls: string[] = []
  const result = directEvents(
    {
      endpoint: "https://host.test",
      serviceToken: "synthetic",
      socket: (url) => {
        urls.push(url)
        const current = urls.length === 1 ? first : second
        queueMicrotask(() => {
          current.emit("open")
          if (urls.length === 1) {
            current.frame({ type: "stream_ready", cursor: 10 })
            current.emit("close")
          } else current.frame({ type: "a", seq: 11, payload: 1 })
        })
        return current
      },
    },
    { channels: ["a"], maxEvents: 1, reconnects: 1, onEvent: () => {}, timeoutMs: 1500 }
  )
  await expect(result).resolves.toMatchObject({ ok: true, result: { cursor: 11 } })
  expect(new URL(urls[1]).searchParams.get("since")).toBe("10")
  expect(first.send).toHaveBeenCalledWith(
    JSON.stringify({ type: "subscribe", mode: "replace", channels: ["a"] })
  )
})

it("matches the Host catalog wildcard family without broadening exact subscriptions", () => {
  expect(channelMatches("connectors://*", "connectors://webhook/adapter-a")).toBe(true)
  expect(channelMatches("connectors://webhook/a", "connectors://webhook/b")).toBe(false)
})
