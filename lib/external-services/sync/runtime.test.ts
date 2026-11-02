/** @jest-environment jsdom */
jest.mock("./core", () => ({
  runExternalSync: jest.fn(async () => ({ status: "completed" })),
  abortExternalSyncRuns: jest.fn(),
}))
jest.mock("@/lib/db/external-sync", () => ({
  listDeferredExternalSyncs: jest.fn(async () => [{ key: "test" }]),
}))
import { runExternalSync } from "./core"
import {
  registerExternalSync,
  requestExternalSync,
  installExternalSyncRuntime,
  unregisterExternalSyncTargets,
  hasExternalSyncRegistration,
  pendingExternalSyncKeys,
} from "./runtime"
import type { ExternalSyncDriver } from "./types"
const driver: ExternalSyncDriver<string> = {
  itemId: String,
  fetchPage: async () => ({ items: [], cursor: "cursor" }),
  applyPage: async () => {},
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
let dispose: () => void
beforeEach(() => {
  jest.useFakeTimers()
  jest.mocked(runExternalSync).mockClear()
  dispose = installExternalSyncRuntime()
})
afterEach(() => {
  dispose()
  jest.useRealTimers()
})

it("coalesces three requests and immediately runs manual full", async () => {
  registerExternalSync({ key: "test", owner: "host" }, () => driver)
  expect(hasExternalSyncRegistration("test")).toBe(true)
  requestExternalSync("test", "poll")
  expect(pendingExternalSyncKeys()).toEqual(["test"])
  requestExternalSync("test", "push")
  requestExternalSync("test", "poll")
  await jest.advanceTimersByTimeAsync(1999)
  expect(runExternalSync).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  expect(pendingExternalSyncKeys()).toEqual([])
  expect(runExternalSync).toHaveBeenCalledTimes(1)
  requestExternalSync("test", "poll")
  requestExternalSync("test", "manual", { full: true })
  await settle()
  expect(runExternalSync).toHaveBeenCalledTimes(2)
  expect(runExternalSync).toHaveBeenLastCalledWith(
    expect.anything(),
    driver,
    expect.objectContaining({ mode: "full" })
  )
  await jest.advanceTimersByTimeAsync(2000)
  expect(runExternalSync).toHaveBeenCalledTimes(2)
})

it("retains a poll's full request while coalescing subsequent requests", async () => {
  registerExternalSync({ key: "test", owner: "host" }, () => driver)
  requestExternalSync("test", "poll", { full: true })
  requestExternalSync("test", "poll")
  await jest.advanceTimersByTimeAsync(2000)
  expect(runExternalSync).toHaveBeenCalledTimes(1)
  expect(runExternalSync).toHaveBeenCalledWith(
    expect.anything(),
    driver,
    expect.objectContaining({ mode: "full" })
  )
})

it("freezes each resolved target after asynchronous credential preparation", async () => {
  const target = { key: "test", owner: "host" as const }
  let ref = "first"
  const resolved = { ...target, connectionRef: ref as never }
  registerExternalSync(target, async () => {
    await Promise.resolve()
    resolved.connectionRef = ref as never
    return { driver, target: resolved }
  })
  requestExternalSync("test", "manual")
  await settle()
  const first = jest.mocked(runExternalSync).mock.calls[0][0]
  expect(first).toEqual({ ...target, connectionRef: "first" })
  expect(Object.isFrozen(first)).toBe(true)
  ref = "second"
  requestExternalSync("test", "manual")
  await settle()
  expect(runExternalSync).toHaveBeenLastCalledWith(
    { ...target, connectionRef: "second" },
    driver,
    expect.anything()
  )
  expect(first.connectionRef).toBe("first")
})

it("keeps the registered binding when a wrapped driver supplies no target", async () => {
  const target = { key: "test", owner: "host" as const, connectionRef: "bound" as never }
  registerExternalSync(target, async () => ({ driver }))
  target.connectionRef = "mutated" as never
  requestExternalSync("test", "manual")
  await settle()
  expect(runExternalSync).toHaveBeenCalledWith(
    { key: "test", owner: "host", connectionRef: "bound" },
    driver,
    expect.anything()
  )
})

it("unregisters a resolved connection before its first cursor is persisted", async () => {
  jest.mocked(runExternalSync).mockImplementationOnce(async (_target, _driver, options) => {
    unregisterExternalSyncTargets((target) => target.connectionRef === "resolved")
    expect(options?.signal?.aborted).toBe(true)
    return { status: "cancelled", mode: "full", pages: 0, applied: 0, tombstoned: 0 }
  })
  registerExternalSync({ key: "test", owner: "host" }, async () => ({
    driver,
    target: { key: "test", owner: "host", connectionRef: "resolved" as never },
  }))
  requestExternalSync("test", "manual")
  await settle()
  expect(runExternalSync).toHaveBeenCalledTimes(1)
  expect(hasExternalSyncRegistration("test")).toBe(false)
})

it.each([
  { key: "other", owner: "host" as const },
  { key: "test", owner: "plugin:other" as const },
])("refuses a factory's replacement of the registered identity: %s", async (target) => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  try {
    registerExternalSync({ key: "test", owner: "host" }, async () => ({ driver, target }))
    requestExternalSync("test", "manual")
    await settle()
    expect(runExternalSync).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("External sync runtime failed")
  } finally {
    warn.mockRestore()
  }
})

it("notifies a registration lifetime exactly once on purge and keeps its replacement live", () => {
  const removed = jest.fn()
  const unregister = registerExternalSync({ key: "test", owner: "host" }, () => driver, {
    onUnregister: removed,
  })
  unregisterExternalSyncTargets(() => true)
  expect(removed).toHaveBeenCalledTimes(1)
  const replacementRemoved = jest.fn()
  registerExternalSync({ key: "test", owner: "host" }, () => driver, {
    onUnregister: replacementRemoved,
  })
  unregister()
  expect(hasExternalSyncRegistration("test")).toBe(true)
  expect(replacementRemoved).not.toHaveBeenCalled()
})

it("does not report a cancelled factory when its credential preparation finishes after unregister", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const unregister = registerExternalSync({ key: "test", owner: "host" }, async () => {
    await gate
    throw new Error("credential provider completed after removal")
  })
  try {
    requestExternalSync("test", "manual")
    await settle()
    unregister()
    release()
    await settle()
    expect(runExternalSync).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  } finally {
    release()
    warn.mockRestore()
  }
})

it("unregisters matching targets before their debounce fires and retains other owners", async () => {
  const removed = jest.fn(() => driver)
  registerExternalSync({ key: "test", owner: "plugin:removed" }, removed)
  registerExternalSync({ key: "kept", owner: "plugin:kept" }, () => driver)
  requestExternalSync("test", "poll")
  requestExternalSync("kept", "poll")
  unregisterExternalSyncTargets((target) => target.owner === "plugin:removed")
  requestExternalSync("test", "manual")
  await jest.advanceTimersByTimeAsync(2000)
  expect(removed).not.toHaveBeenCalled()
  expect(runExternalSync).toHaveBeenCalledTimes(1)
  expect(runExternalSync).toHaveBeenCalledWith(
    expect.objectContaining({ key: "kept" }),
    driver,
    expect.anything()
  )
})

it("buffers exactly one rerun and preserves a requested full scan", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  jest.mocked(runExternalSync).mockImplementationOnce(async () => {
    await gate
    return { status: "completed", mode: "full", pages: 0, applied: 0, tombstoned: 0 }
  })
  const unregister = registerExternalSync({ key: "test", owner: "host" }, () => driver)
  requestExternalSync("test", "manual")
  await settle()
  requestExternalSync("test", "push")
  requestExternalSync("test", "manual", { full: true })
  requestExternalSync("test", "poll")
  release()
  await settle()
  expect(runExternalSync).toHaveBeenCalledTimes(2)
  expect(runExternalSync).toHaveBeenLastCalledWith(
    expect.anything(),
    driver,
    expect.objectContaining({ mode: "full" })
  )
  unregister()
})

it("online requests deferred keys, unregister aborts, and disposal removes the event listener", async () => {
  registerExternalSync({ key: "test", owner: "host" }, () => driver)
  window.dispatchEvent(new Event("online"))
  await settle()
  await jest.advanceTimersByTimeAsync(2000)
  expect(runExternalSync).toHaveBeenCalledTimes(1)
  dispose()
  window.dispatchEvent(new Event("online"))
  await jest.advanceTimersByTimeAsync(2000)
  expect(runExternalSync).toHaveBeenCalledTimes(1)
  let signal!: AbortSignal
  jest.mocked(runExternalSync).mockImplementationOnce(async (_target, _driver, options) => {
    signal = options!.signal!
    return new Promise(() => {})
  })
  const unregister = registerExternalSync({ key: "other", owner: "host" }, () => driver)
  requestExternalSync("other", "manual")
  await settle()
  unregister()
  expect(signal.aborted).toBe(true)
})
