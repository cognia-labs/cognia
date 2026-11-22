import { isAbortError, useFilesTransferStore } from "./files-transfer-store"

beforeEach(() => {
  useFilesTransferStore.getState().reset()
})

describe("useFilesTransferStore", () => {
  it("tracks per-file progress, aborts running transfers, retries failed ones, and clears finished tasks", async () => {
    const controller = new AbortController()
    const retryFn = jest.fn(async () => {
      useFilesTransferStore.getState().markCompleted(id)
    })

    const id = useFilesTransferStore.getState().enqueueTask({
      kind: "upload",
      name: "report.pdf",
      totalBytes: 1_000,
      status: "running",
      abortController: controller,
      retryFn,
    })

    expect(useFilesTransferStore.getState().open).toBe(true)
    useFilesTransferStore.getState().updateProgress(id, 450)
    expect(useFilesTransferStore.getState().tasks[0]).toMatchObject({
      id,
      status: "running",
      loadedBytes: 450,
      totalBytes: 1_000,
    })

    useFilesTransferStore.getState().cancelTask(id)
    expect(controller.signal.aborted).toBe(true)
    expect(useFilesTransferStore.getState().tasks[0]?.status).toBe("cancelled")

    // Retry from cancelled or failed state invokes the session-scoped retry callback.
    await useFilesTransferStore.getState().retryTask(id)
    expect(retryFn).toHaveBeenCalledTimes(1)
    expect(useFilesTransferStore.getState().tasks[0]).toMatchObject({
      status: "completed",
      loadedBytes: 1_000,
    })

    const failedId = useFilesTransferStore.getState().enqueueTask({
      kind: "export-zip",
      name: "files.zip",
      totalBytes: 500,
    })
    useFilesTransferStore.getState().markFailed(failedId, "Network dropped")

    useFilesTransferStore.getState().clearFinished()
    expect(useFilesTransferStore.getState().tasks.map((t) => t.id)).toEqual([failedId])
  })

  it("identifies DOMException AbortError instances cleanly", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true)
    expect(isAbortError(new Error("boom"))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})
