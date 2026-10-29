import type { UIMessage } from "ai"

import {
  clearAllHistoryPreviews,
  clearHistoryPreview,
  getHistoryPreview,
  setHistoryPreview,
  subscribeHistoryPreview,
  waitForFullHistory,
  whenFullHistory,
  type HistoryPreview,
} from "./history-preview"

const preview = (total = 100): HistoryPreview => ({
  messages: [{ id: "m1", role: "user", parts: [] } as UIMessage],
  total,
  activeBranchByGroup: {},
})

describe("history preview", () => {
  afterEach(() => clearAllHistoryPreviews())

  it("stores, reports and clears a preview per session", () => {
    const listener = jest.fn()
    subscribeHistoryPreview("s1", listener)
    setHistoryPreview("s1", preview())
    expect(getHistoryPreview("s1")?.total).toBe(100)
    expect(getHistoryPreview("s2")).toBeNull()
    expect(getHistoryPreview(null)).toBeNull()
    clearHistoryPreview("s1")
    expect(getHistoryPreview("s1")).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("lets a write proceed at once when no preview is showing", async () => {
    await expect(waitForFullHistory("s1")).resolves.toBeUndefined()
    await expect(waitForFullHistory(null)).resolves.toBeUndefined()
  })

  it("holds a write until the full history replaces the preview", async () => {
    setHistoryPreview("s1", preview())
    let released = false
    const wait = waitForFullHistory("s1").then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)
    clearHistoryPreview("s1")
    await wait
    expect(released).toBe(true)
  })

  it("releases every waiter when all previews are dropped", async () => {
    setHistoryPreview("s1", preview())
    setHistoryPreview("s2", preview())
    const waits = Promise.all([waitForFullHistory("s1"), waitForFullHistory("s2")])
    clearAllHistoryPreviews()
    await expect(waits).resolves.toEqual([undefined, undefined])
  })

  it("runs an action in the same call when no preview is up, otherwise after it", async () => {
    const now = jest.fn(() => "done")
    expect(whenFullHistory("s1", now)).toBe("done")
    expect(now).toHaveBeenCalledTimes(1)

    setHistoryPreview("s1", preview())
    const later = jest.fn(() => "later")
    const result = whenFullHistory("s1", later)
    expect(later).not.toHaveBeenCalled()
    clearHistoryPreview("s1")
    await expect(result).resolves.toBe("later")
  })
})
