/**
 * @jest-environment jsdom
 */
// The coalesced storage only holds writes when a browser is present, so these
// run under jsdom; the no-window pass-through lives in persist-storage.test.ts.
import { loggers } from "@cognia/logging"

import {
  PERSIST_COALESCE_MAX_WAIT_MS,
  PERSIST_COALESCE_WAIT_MS,
  flushPendingPersistWrites,
  persistCoalescedLocalStorage,
} from "./persist-storage"

type Snapshot = { count: number }

const value = (count: number) => ({ state: { count }, version: 1 })
const stored = (name: string) => JSON.parse(window.localStorage.getItem(name) ?? "null")

describe("persistCoalescedLocalStorage", () => {
  let setItem: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers()
    window.localStorage.clear()
    setItem = jest.spyOn(Storage.prototype, "setItem")
  })

  afterEach(() => {
    flushPendingPersistWrites()
    setItem.mockRestore()
    jest.useRealTimers()
  })

  it("writes a burst of changes once, with the last value, after the quiet period", () => {
    const storage = persistCoalescedLocalStorage<Snapshot>()
    for (let count = 1; count <= 50; count += 1) storage.setItem("burst", value(count))

    expect(setItem).not.toHaveBeenCalled()
    expect(storage.hasPending("burst")).toBe(true)

    jest.advanceTimersByTime(PERSIST_COALESCE_WAIT_MS)

    expect(setItem).toHaveBeenCalledTimes(1)
    expect(stored("burst")).toEqual(value(50))
    expect(storage.hasPending()).toBe(false)
  })

  it("never holds a write past the max wait while changes keep arriving", () => {
    const storage = persistCoalescedLocalStorage<Snapshot>({ waitMs: 100, maxWaitMs: 300 })
    let count = 0
    // A change every 50ms keeps resetting the quiet period.
    for (let elapsed = 0; elapsed < 300; elapsed += 50) {
      storage.setItem("busy", value((count += 1)))
      jest.advanceTimersByTime(50)
    }
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(stored("busy").state.count).toBeGreaterThanOrEqual(5)
  })

  it("defaults to a quiet period shorter than its ceiling", () => {
    expect(PERSIST_COALESCE_WAIT_MS).toBeLessThan(PERSIST_COALESCE_MAX_WAIT_MS)
  })

  it("reads the pending value, so a rehydrate inside the window sees the latest state", () => {
    const storage = persistCoalescedLocalStorage<Snapshot>()
    window.localStorage.setItem("read", JSON.stringify(value(1)))
    setItem.mockClear()
    storage.setItem("read", value(2))

    expect(storage.getItem("read")).toEqual(value(2))
    expect(stored("read")).toEqual(value(1))
  })

  it("falls through to localStorage when nothing is pending", () => {
    const storage = persistCoalescedLocalStorage<Snapshot>()
    window.localStorage.setItem("disk", JSON.stringify(value(7)))
    expect(storage.getItem("disk")).toEqual(value(7))
    expect(storage.getItem("missing")).toBeNull()
  })

  it("flushes one key on demand and leaves the others pending", () => {
    const storage = persistCoalescedLocalStorage<Snapshot>()
    storage.setItem("a", value(1))
    storage.setItem("b", value(2))

    storage.flush("a")

    expect(stored("a")).toEqual(value(1))
    expect(window.localStorage.getItem("b")).toBeNull()
    expect(storage.hasPending("b")).toBe(true)
  })

  it("cancels a pending write so a deleted key is not resurrected", () => {
    const storage = persistCoalescedLocalStorage<Snapshot>()
    storage.setItem("gone", value(1))
    storage.cancel("gone")
    jest.advanceTimersByTime(PERSIST_COALESCE_MAX_WAIT_MS)

    expect(setItem).not.toHaveBeenCalled()
    expect(window.localStorage.getItem("gone")).toBeNull()
  })

  it("removeItem drops the pending write and deletes what is on disk", () => {
    const storage = persistCoalescedLocalStorage<Snapshot>()
    window.localStorage.setItem("both", JSON.stringify(value(1)))
    setItem.mockClear()
    storage.setItem("both", value(2))

    storage.removeItem("both")
    jest.advanceTimersByTime(PERSIST_COALESCE_MAX_WAIT_MS)

    expect(window.localStorage.getItem("both")).toBeNull()
    expect(setItem).not.toHaveBeenCalled()
  })

  it("flushes every coalesced store when the page is hidden or closed", () => {
    const first = persistCoalescedLocalStorage<Snapshot>()
    const second = persistCoalescedLocalStorage<Snapshot>()

    first.setItem("hidden-a", value(1))
    second.setItem("hidden-b", value(2))
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    expect(stored("hidden-a")).toEqual(value(1))
    expect(stored("hidden-b")).toEqual(value(2))

    first.setItem("closed", value(3))
    window.dispatchEvent(new Event("pagehide"))
    expect(stored("closed")).toEqual(value(3))

    first.setItem("unloaded", value(4))
    window.dispatchEvent(new Event("beforeunload"))
    expect(stored("unloaded")).toEqual(value(4))
  })

  it("does not flush when the page becomes visible", () => {
    const storage = persistCoalescedLocalStorage<Snapshot>()
    storage.setItem("visible", value(1))
    document.dispatchEvent(new Event("visibilitychange"))
    expect(storage.hasPending("visible")).toBe(true)
  })

  it("logs a failed write instead of throwing from the timer, and retries on the next change", () => {
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => undefined)
    const storage = persistCoalescedLocalStorage<Snapshot>()
    setItem.mockImplementationOnce(() => {
      throw new Error("QuotaExceededError")
    })

    storage.setItem("full", value(1))
    expect(() => jest.advanceTimersByTime(PERSIST_COALESCE_WAIT_MS)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      "Coalesced persist write failed",
      expect.objectContaining({ name: "full", error: "QuotaExceededError" })
    )

    storage.setItem("full", value(2))
    jest.advanceTimersByTime(PERSIST_COALESCE_WAIT_MS)
    expect(stored("full")).toEqual(value(2))
    warn.mockRestore()
  })
})
