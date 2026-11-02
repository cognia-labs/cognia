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
  requestExternalSync("test", "poll")
  requestExternalSync("test", "push")
  requestExternalSync("test", "poll")
  await jest.advanceTimersByTimeAsync(1999)
  expect(runExternalSync).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
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
