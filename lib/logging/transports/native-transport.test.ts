/**
 * @jest-environment jsdom
 */

import type { StructuredLogEntry } from "@/types/logging"
import { NativeTransport, createNativeTransport } from "./native-transport"

// Mock isTauri to control whether the transport short-circuits or runs.
const mockIsTauri = jest.fn(() => true)
const mockForward = jest.fn(async (_entries: unknown[]) => true)

jest.mock("@/lib/tauri", () => ({
  __esModule: true,
  isTauri: () => mockIsTauri(),
}))

jest.mock("@/lib/native/native-logging", () => ({
  __esModule: true,
  forwardPlatformLoggingEntries: (entries: unknown[]) => mockForward(entries),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  mockIsTauri.mockReturnValue(true)
  mockForward.mockResolvedValue(true)
})

afterEach(() => {
  jest.useRealTimers()
})

function makeEntry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: overrides.id ?? "log-1",
    timestamp: overrides.timestamp ?? "2026-04-30T10:00:00.000Z",
    level: overrides.level ?? "warn",
    message: overrides.message ?? "hello",
    module: overrides.module ?? "test",
    ...overrides,
  }
}

describe("NativeTransport in Tauri runtime", () => {
  it("buffers + auto-flushes when batchSize hit", async () => {
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 2, flushInterval: 60_000 })
    t.log(makeEntry({ id: "a" }))
    t.log(makeEntry({ id: "b" })) // triggers auto flush
    // Drain microtasks for the void this.flush() in log().
    await Promise.resolve()
    await Promise.resolve()
    expect(mockForward).toHaveBeenCalled()
    const forwarded = mockForward.mock.calls[0][0] as unknown as { module: string }[]
    expect(forwarded).toHaveLength(2)
    await t.close()
  })

  it("filters logs below minLevel", async () => {
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 1, minLevel: "error", flushInterval: 60_000 })
    t.log(makeEntry({ level: "warn" }))
    await Promise.resolve()
    expect(mockForward).not.toHaveBeenCalled()
    await t.close()
  })

  it("flush returns early when buffer is empty", async () => {
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 99, flushInterval: 60_000 })
    await t.flush()
    expect(mockForward).not.toHaveBeenCalled()
    await t.close()
  })

  it("normalizes data + tags + runtime + origin into the forwarded payload", async () => {
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 1, flushInterval: 60_000 })
    t.log(
      makeEntry({
        data: { extra: 1 },
        stack: "Error: x",
        source: { file: "a.ts" },
        tags: ["a"],
        runtime: "tauri",
        origin: "tauri",
      })
    )
    await Promise.resolve()
    await Promise.resolve()
    const payload = mockForward.mock.calls[0][0] as unknown as Array<{
      data?: Record<string, unknown>
    }>
    expect(payload[0].data).toMatchObject({
      extra: 1,
      stack: "Error: x",
      source: { file: "a.ts" },
      tags: ["a"],
      runtime: "tauri",
      origin: "tauri",
    })
    await t.close()
  })

  it("getPendingCount + getHealth reflect buffered state", async () => {
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 99, flushInterval: 60_000 })
    t.log(makeEntry())
    t.log(makeEntry({ id: "b" }))
    expect(t.getPendingCount()).toBe(2)
    const health = t.getHealth()
    expect(health.transport).toBe("native")
    expect(health.queueDepth).toBe(2)
    await t.close()
  })

  it("re-queues entries and marks degraded when forward fails", async () => {
    mockForward.mockResolvedValueOnce(false)
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 1, flushInterval: 60_000 })
    t.log(makeEntry())
    await Promise.resolve()
    await Promise.resolve()
    expect(t.getHealth().status).toBe("degraded")
    expect(t.getHealth().retryCount).toBeGreaterThan(0)
    await t.close()
  })

  it("returns to healthy after a successful forward", async () => {
    mockForward.mockResolvedValueOnce(false)
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 1, flushInterval: 60_000 })
    t.log(makeEntry())
    await Promise.resolve()
    await Promise.resolve()
    // Now succeed. Buffer was repopulated, so flushing again should drain it.
    mockForward.mockResolvedValueOnce(true)
    await t.flush()
    expect(t.getHealth().status).toBe("healthy")
    await t.close()
  })

  it("keeps every entry across overlapping failed flushes and resends them in order", async () => {
    let failNext = true
    mockForward.mockImplementation(async () => {
      await Promise.resolve()
      return !failNext
    })
    const t = new NativeTransport({ batchSize: 2, flushInterval: 60_000 })
    t.log(makeEntry({ id: "a", message: "a" }))
    t.log(makeEntry({ id: "b", message: "b" })) // auto flush #1 starts
    t.log(makeEntry({ id: "c", message: "c" }))
    t.log(makeEntry({ id: "d", message: "d" })) // joins the flush in flight
    await t.flush()
    expect(t.getPendingCount()).toBe(4)
    // A second failure keeps all four (the old code kept one batch: 4 -> 2).
    await t.flush()
    expect(t.getPendingCount()).toBe(4)
    expect(t.getHealth().droppedEntries).toBe(0)

    failNext = false
    mockForward.mockClear()
    await t.flush()
    expect(t.getPendingCount()).toBe(0)
    const sent = mockForward.mock.calls.map((call) =>
      (call[0] as Array<{ message: string }>).map((entry) => entry.message)
    )
    expect(sent).toEqual([
      ["a", "b"],
      ["c", "d"],
    ])
    await t.close()
  })

  it("drops the oldest entries past maxQueueSize and counts them", async () => {
    mockForward.mockResolvedValue(false)
    const t = new NativeTransport({ batchSize: 100, maxQueueSize: 3, flushInterval: 60_000 })
    for (const id of ["a", "b", "c", "d", "e"]) t.log(makeEntry({ id, message: id }))
    expect(t.getPendingCount()).toBe(3)
    expect(t.getHealth().droppedEntries).toBe(2)
    await t.close()
  })

  it("forwards span, execution and request identity to the native log", async () => {
    const t = new NativeTransport({ batchSize: 1, flushInterval: 60_000 })
    t.log(
      makeEntry({
        traceId: "trace-1",
        spanId: "span-1",
        parentSpanId: "span-0",
        executionId: "exec-1",
        requestId: "req-1",
        sessionId: "session-1",
      })
    )
    await t.flush()
    expect(mockForward.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        traceId: "trace-1",
        spanId: "span-1",
        parentSpanId: "span-0",
        executionId: "exec-1",
        requestId: "req-1",
        sessionId: "session-1",
      }),
    ])
    await t.close()
  })

  it("flush timer fires periodically and drains the buffer", async () => {
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 99, flushInterval: 500 })
    t.log(makeEntry())
    jest.advanceTimersByTime(600)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockForward).toHaveBeenCalled()
    await t.close()
  })

  it("close() stops the flush timer and runs a final flush", async () => {
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 99, flushInterval: 60_000 })
    t.log(makeEntry())
    await t.close()
    expect(mockForward).toHaveBeenCalled()
  })
})

describe("NativeTransport outside Tauri runtime", () => {
  it("log() is a no-op when not in Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 1, flushInterval: 60_000 })
    t.log(makeEntry())
    expect(mockForward).not.toHaveBeenCalled()
    expect(t.getHealth().status).toBe("offline")
    await t.close()
  })

  it("flush() is a no-op when not in Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    // NativeTransport imported statically
    const t = new NativeTransport({ batchSize: 99, flushInterval: 60_000 })
    await t.flush()
    expect(mockForward).not.toHaveBeenCalled()
    await t.close()
  })
})

describe("createNativeTransport factory", () => {
  it("returns a NativeTransport instance with given options", async () => {
    // createNativeTransport and NativeTransport imported statically
    const t = createNativeTransport({ batchSize: 5 })
    expect(t).toBeInstanceOf(NativeTransport)
    await t.close()
  })

  it("supports default options", async () => {
    // createNativeTransport imported statically
    const t = createNativeTransport()
    expect(t.name).toBe("native")
    await t.close()
  })
})
