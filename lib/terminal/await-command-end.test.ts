import { awaitCommandEnd, END_CHUNK_GRACE_MS, MAX_CAPTURED_CHARS } from "./await-command-end"
import type { IntegrationEvent } from "./types"

const C = "\u001b]633;C;n\u0007"
const D = (code = 0) => `\u001b]633;D;n;${code}\u0007`

function fakeSession() {
  const taps = new Set<(bytes: Uint8Array) => void>()
  const integrations = new Set<(event: IntegrationEvent) => void>()
  const exits = new Set<(code: number | null) => void>()
  return {
    tapData: jest.fn((cb: (bytes: Uint8Array) => void) => {
      taps.add(cb)
      return () => taps.delete(cb)
    }),
    onIntegration: jest.fn((cb: (event: IntegrationEvent) => void) => {
      integrations.add(cb)
      return () => integrations.delete(cb)
    }),
    onExit: jest.fn((cb: (code: number | null) => void) => {
      exits.add(cb)
      return () => exits.delete(cb)
    }),
    emit(text: string) {
      const bytes = new TextEncoder().encode(text)
      for (const cb of [...taps]) cb(bytes)
    },
    emitBytes(bytes: Uint8Array) {
      for (const cb of [...taps]) cb(bytes)
    },
    end(code: number | null) {
      for (const cb of [...integrations]) cb({ kind: "command_end", exit_code: code })
    },
    exit() {
      for (const cb of [...exits]) cb(null)
    },
    listenerCount: () => taps.size + integrations.size + exits.size,
  }
}

afterEach(() => {
  jest.useRealTimers()
})

describe("awaitCommandEnd", () => {
  it("attaches every listener before start runs", async () => {
    const session = fakeSession()
    const order: string[] = []
    const pending = awaitCommandEnd(session, {
      timeoutMs: 1000,
      start: () => {
        order.push(`start:${session.listenerCount()}`)
        // A command that finishes synchronously inside the write is still seen.
        session.emit(`${C}hi\r\n`)
        session.end(0)
        session.emit(`${D(0)}$ `)
      },
    })
    await expect(pending).resolves.toEqual({
      kind: "ended",
      exitCode: 0,
      output: "hi",
      truncated: false,
    })
    expect(order).toEqual(["start:3"])
    expect(session.listenerCount()).toBe(0)
  })

  it("waits for the chunk carrying the end marker after the integration event", async () => {
    const session = fakeSession()
    const pending = awaitCommandEnd(session, { timeoutMs: 1000 })
    session.emit(`${C}line one\r\n`)
    session.end(2)
    // Still in the chunk that follows the event.
    session.emit(`line two\r\n${D(2)}$ `)
    await expect(pending).resolves.toMatchObject({
      kind: "ended",
      exitCode: 2,
      output: "line one\nline two",
    })
  })

  it("settles at once when the end marker already arrived", async () => {
    const session = fakeSession()
    const pending = awaitCommandEnd(session, { timeoutMs: 1000 })
    session.emit(`${C}out\r\n${D(0)}`)
    session.end(0)
    await expect(pending).resolves.toMatchObject({ kind: "ended", output: "out" })
  })

  it("falls back to what it has when the end chunk never comes", async () => {
    jest.useFakeTimers()
    const session = fakeSession()
    const pending = awaitCommandEnd(session, { timeoutMs: 10_000 })
    session.emit(`${C}partial\r\n$ `)
    session.end(0)
    jest.advanceTimersByTime(END_CHUNK_GRACE_MS)
    await expect(pending).resolves.toMatchObject({ kind: "ended", output: "partial" })
  })

  it("decodes multi-byte characters split across chunks", async () => {
    const session = fakeSession()
    const pending = awaitCommandEnd(session, { timeoutMs: 1000 })
    const bytes = new TextEncoder().encode(`${C}你好\r\n`)
    // Split inside the three-byte encoding of 你.
    const cut = new TextEncoder().encode(C).length + 1
    session.emitBytes(bytes.slice(0, cut))
    session.emitBytes(bytes.slice(cut))
    session.end(0)
    session.emit(D(0))
    await expect(pending).resolves.toMatchObject({ output: "你好" })
  })

  it("keeps the newest output and flags truncation past the cap", async () => {
    const session = fakeSession()
    const pending = awaitCommandEnd(session, { timeoutMs: 1000 })
    session.emit(C)
    session.emit("x".repeat(MAX_CAPTURED_CHARS))
    session.emit("TAIL\r\n")
    session.end(0)
    session.emit(D(0))
    const result = await pending
    expect(result.kind).toBe("ended")
    if (result.kind !== "ended") return
    expect(result.truncated).toBe(true)
    expect(result.output.endsWith("TAIL")).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(MAX_CAPTURED_CHARS)
  })

  it("times out when no command_end arrives", async () => {
    jest.useFakeTimers()
    const session = fakeSession()
    const pending = awaitCommandEnd(session, { timeoutMs: 500 })
    jest.advanceTimersByTime(500)
    await expect(pending).resolves.toEqual({ kind: "timeout" })
    expect(session.listenerCount()).toBe(0)
  })

  it("reports a shell that exited before the command finished", async () => {
    const session = fakeSession()
    const pending = awaitCommandEnd(session, { timeoutMs: 1000 })
    session.exit()
    await expect(pending).resolves.toEqual({ kind: "exited" })
  })

  it("ignores a second command_end once one was taken", async () => {
    const session = fakeSession()
    const pending = awaitCommandEnd(session, { timeoutMs: 1000 })
    session.emit(`${C}first\r\n`)
    session.end(0)
    session.end(9)
    session.emit(D(0))
    await expect(pending).resolves.toMatchObject({ exitCode: 0, output: "first" })
  })
})
