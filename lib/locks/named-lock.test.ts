import "fake-indexeddb/auto"
import { NamedLockError, withNamedLock } from "./named-lock"

it("uses navigator locks and invalidates retained guards", async () => {
  const request = jest.fn(async (_name, run) => run())
  let guard!: () => void
  await expect(
    withNamedLock(
      "test",
      async (held) => {
        guard = held
        return 7
      },
      { locks: { request } }
    )
  ).resolves.toBe(7)
  expect(request).toHaveBeenCalledWith("test", expect.any(Function))
  expect(guard).toThrow(NamedLockError)
})

it.each(["indexeddb", "in-process"] as const)(
  "serializes %s holders and releases after failure",
  async (mode) => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const options = { mode, locks: null, databaseName: "named-lock-custom", storeName: "custom" }
    const order: string[] = []
    let guard!: () => void
    const first = withNamedLock(
      "shared",
      async (held) => {
        guard = held
        enter()
        await released
        held()
        order.push("first")
      },
      options
    )
    await entered
    const second = withNamedLock(
      "shared",
      async () => {
        order.push("second")
      },
      options
    )
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(order).toEqual([])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(["first", "second"])
    expect(guard).toThrow("no longer held")
    await expect(
      withNamedLock(
        "shared",
        async () => {
          throw new Error("failure")
        },
        options
      )
    ).rejects.toThrow("failure")
    await expect(withNamedLock("shared", async () => 1, options)).resolves.toBe(1)
  }
)

it("requires explicit permission to use a process mutex without browser primitives", async () => {
  const original = globalThis.indexedDB
  Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true })
  try {
    await expect(withNamedLock("headless", async () => 1, { locks: null })).rejects.toThrow(
      "unavailable"
    )
    await expect(
      withNamedLock("headless", async () => 1, { locks: null, allowInProcess: true })
    ).resolves.toBe(1)
  } finally {
    Object.defineProperty(globalThis, "indexedDB", { value: original, configurable: true })
  }
})

it("does not block another IndexedDB lock name behind a held lineage", async () => {
  let release!: () => void
  let enter!: () => void
  const started = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const options = { mode: "indexeddb" as const, databaseName: "independent-lineages", waitMs: 20 }
  const first = withNamedLock(
    "lineage-a",
    async () => {
      enter()
      await gate
    },
    options
  )
  await started
  try {
    await expect(withNamedLock("lineage-b", async () => "independent", options)).resolves.toBe(
      "independent"
    )
  } finally {
    release()
    await first
  }
})
