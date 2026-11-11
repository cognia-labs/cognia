import { act, render } from "@testing-library/react"
import { StrictMode } from "react"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { recoverEvalQueueOnStartup } from "@/lib/ai/eval/recovery"

jest.mock("@/lib/ai/eval/recovery", () => {
  const actual = jest.requireActual("@/lib/ai/eval/recovery")
  return { ...actual, recoverEvalQueueOnStartup: jest.fn(actual.recoverEvalQueueOnStartup) }
})

const unsubscribe = jest.fn()
const startMock = jest.fn().mockResolvedValue(unsubscribe)
jest.mock("@/lib/storage/retention", () => ({
  startStorageRetentionSweeper: (...a: unknown[]) => startMock(...a),
}))

import { StorageRetentionInitializer } from "./storage-retention-initializer"

beforeEach(() => {
  startMock.mockClear()
  unsubscribe.mockClear()
})

describe("StorageRetentionInitializer", () => {
  it("starts the sweeper once on mount and renders nothing", () => {
    const { container, rerender } = render(<StorageRetentionInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(startMock).toHaveBeenCalledTimes(1)
    rerender(<StorageRetentionInitializer />)
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<StorageRetentionInitializer />)
    // Let the start promise resolve so the unsubscribe handle is captured.
    await Promise.resolve()
    await Promise.resolve()
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("disposes a startup that resolves after unmount", async () => {
    let resolve!: (dispose: () => void) => void
    startMock.mockReturnValueOnce(
      new Promise((accept) => {
        resolve = accept
      })
    )
    const { unmount } = render(<StorageRetentionInitializer />)
    unmount()
    await act(async () => resolve(unsubscribe))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("keeps a live sweeper after StrictMode replays the effect", async () => {
    const first = jest.fn()
    const second = jest.fn()
    startMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const { unmount } = render(
      <StrictMode>
        <StorageRetentionInitializer />
      </StrictMode>
    )
    await act(async () => {})
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    unmount()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe("StorageRetentionInitializer with persisted evaluation recovery", () => {
  const fixture = createDbTestFixture()
  beforeAll(fixture.initialize)
  beforeEach(fixture.restore)
  afterAll(fixture.dispose)

  it("shares startup on replay and preserves interrupted work until the last consumer unmounts", async () => {
    const db = getDb()
    await db.evalExperiments.put({
      id: "interrupted-experiment",
      state: "running",
      reservedCost: 0.2,
      updatedAt: 1,
    } as never)
    await db.evalTasks.put({
      id: "ambiguous-task",
      experimentId: "interrupted-experiment",
      state: "running",
      reservedCost: 0.2,
      updatedAt: 1,
    } as never)
    const actual =
      jest.requireActual<typeof import("@/lib/storage/retention")>("@/lib/storage/retention")
    const recovery = jest.mocked(recoverEvalQueueOnStartup)
    recovery.mockClear()
    startMock.mockImplementation(actual.startStorageRetentionSweeper)
    const setTimer = jest.spyOn(globalThis, "setInterval")
    const clearTimer = jest.spyOn(globalThis, "clearInterval")
    const { unmount } = render(
      <StrictMode>
        <StorageRetentionInitializer />
        <StorageRetentionInitializer />
      </StrictMode>
    )
    try {
      await act(async () => {
        await Promise.all(startMock.mock.results.map(({ value }) => value))
      })
      expect(recovery).toHaveBeenCalledTimes(1)
      expect(await db.evalExperiments.get("interrupted-experiment")).toMatchObject({
        state: "interrupted",
        pauseReason: "recovery",
        reservedCost: 0,
      })
      expect(await db.evalTasks.get("ambiguous-task")).toMatchObject({
        state: "interrupted",
        interruptionSpendAmbiguous: true,
      })
      const timers = setTimer.mock.calls.flatMap((args, i) =>
        args[1] === actual.RETENTION_SWEEP_INTERVAL_MS ? [setTimer.mock.results[i]!.value] : []
      )
      expect(timers).toHaveLength(1)
      expect(clearTimer).not.toHaveBeenCalledWith(timers[0])
      unmount()
      expect(clearTimer.mock.calls.filter(([id]) => id === timers[0])).toHaveLength(1)
    } finally {
      unmount()
      setTimer.mockRestore()
      clearTimer.mockRestore()
      startMock.mockReset().mockResolvedValue(unsubscribe)
    }
  })
})
