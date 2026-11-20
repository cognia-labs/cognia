const mockReconcile = jest.fn(async () => 0)
jest.mock("./settle", () => ({
  reconcileRoomHandoffs: () => mockReconcile(),
}))
const endListeners = new Set<(runId: string) => void>()
jest.mock("../squad/squad-lifecycle-runner", () => ({
  onSquadRunEnded: (listener: (runId: string) => void) => {
    endListeners.add(listener)
    return () => endListeners.delete(listener)
  },
}))

import { start } from "./runtime-reconcile"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  mockReconcile.mockReset()
  mockReconcile.mockResolvedValue(0)
  endListeners.clear()
})

describe("room hand-off reconcile runtime", () => {
  it("reports what a previous run of the host left owed before it is up (F05)", async () => {
    const stop = await start()
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    stop()
  })

  it("looks again whenever a Squad run ends here, and stops listening when stopped", async () => {
    const stop = await start()
    for (const listener of endListeners) listener("run-retry")
    await flush()
    expect(mockReconcile).toHaveBeenCalledTimes(2)
    stop()
    expect(endListeners.size).toBe(0)
  })

  it("never runs two scans at once, and a failed scan does not stop the next", async () => {
    let release!: () => void
    mockReconcile
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(0)
          })
      )
      .mockRejectedValueOnce(new Error("db closed"))
      .mockResolvedValue(1)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const starting = start()
    await flush()
    for (const listener of endListeners) listener("a")
    for (const listener of endListeners) listener("b")
    await flush()
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    release()
    const stop = await starting
    await flush()
    await flush()
    expect(mockReconcile).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith("room hand-off reconciliation failed", expect.any(Error))
    stop()
    warn.mockRestore()
  })
})
