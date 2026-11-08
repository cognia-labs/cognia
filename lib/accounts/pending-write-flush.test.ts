import {
  ACCOUNT_WRITE_FLUSH_TIMEOUT_MS,
  flushPendingAccountWrites,
  registerPendingAccountWriteFlusher,
  settlePendingAccountWrites,
} from "./pending-write-flush"

describe("pending account writes", () => {
  const unregister: Array<() => void> = []

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    unregister.splice(0).forEach((dispose) => dispose())
    jest.useRealTimers()
  })

  it("unregisters owners and leaves revocation synchronous when none remain", () => {
    const flush = jest.fn(async () => {})
    const dispose = registerPendingAccountWriteFlusher(flush)
    dispose()
    expect(flushPendingAccountWrites()).toBeUndefined()
    expect(flush).not.toHaveBeenCalled()
  })

  it("awaits every writer, including a slow writer after another throws", async () => {
    const error = new Error("disk full")
    let release!: () => void
    unregister.push(
      registerPendingAccountWriteFlusher(() => {
        throw error
      })
    )
    unregister.push(
      registerPendingAccountWriteFlusher(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
    )
    const result = flushPendingAccountWrites()!
    const failed = expect(result).rejects.toBe(error)
    let settled = false
    void result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await failed
    expect(jest.getTimerCount()).toBe(0)
  })

  it("bounds all writers together and signals retention on timeout", async () => {
    const aborts: string[] = []
    for (const id of ["artifacts", "other"]) {
      unregister.push(
        registerPendingAccountWriteFlusher((signal) => {
          signal.addEventListener("abort", () => aborts.push(id))
          return new Promise<void>(() => {})
        })
      )
    }
    const failed = expect(flushPendingAccountWrites()).rejects.toThrow("timed out")
    await jest.advanceTimersByTimeAsync(ACCOUNT_WRITE_FLUSH_TIMEOUT_MS)
    await failed
    expect(aborts).toEqual(["artifacts", "other"])
    expect(jest.getTimerCount()).toBe(0)
  })

  it("reports all failed writers", async () => {
    const errors = [new Error("first"), new Error("second")]
    for (const error of errors) {
      unregister.push(
        registerPendingAccountWriteFlusher(async () => {
          throw error
        })
      )
    }
    await expect(flushPendingAccountWrites()).rejects.toMatchObject({ errors })
  })

  it("settles a failed flush for switch paths without throwing", async () => {
    unregister.push(
      registerPendingAccountWriteFlusher(async () => {
        throw new Error("disk full")
      })
    )
    await expect(settlePendingAccountWrites()).resolves.toBeUndefined()
  })

  it("settles immediately when nothing is pending", async () => {
    await expect(settlePendingAccountWrites()).resolves.toBeUndefined()
  })
})
