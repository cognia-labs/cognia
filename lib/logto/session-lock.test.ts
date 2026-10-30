import "fake-indexeddb/auto"
import { withLogtoSessionLock } from "./session-lock"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { resolve, promise }
}

it("holds an IndexedDB mutex across an async task in a separate module realm", async () => {
  let other!: typeof import("./session-lock")
  await jest.isolateModulesAsync(async () => {
    other = await import("./session-lock")
  })
  const entered = deferred<void>()
  const release = deferred<void>()
  const order: string[] = []
  const first = withLogtoSessionLock(
    "cognia-logto-auth:shared",
    async (assertHeld) => {
      entered.resolve()
      await release.promise
      assertHeld()
      order.push("first")
    },
    { locks: null }
  )
  await entered.promise
  const second = other.withLogtoSessionLock(
    "cognia-logto-auth:shared",
    async () => {
      order.push("second")
    },
    { locks: null }
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(order).toEqual([])
  release.resolve()
  await Promise.all([first, second])
  expect(order).toEqual(["first", "second"])
})

it("bounds acquisition waiting without taking a lock away from a slow owner", async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  const first = withLogtoSessionLock(
    "cognia-logto-auth:slow",
    async (assertHeld) => {
      entered.resolve()
      await release.promise
      assertHeld()
    },
    { locks: null }
  )
  await entered.promise
  let ran = false
  await expect(
    withLogtoSessionLock(
      "cognia-logto-auth:slow",
      async () => {
        ran = true
      },
      {
        locks: null,
        waitMs: 10,
      }
    )
  ).rejects.toThrow("Timed out")
  expect(ran).toBe(false)
  release.resolve()
  await first
  await expect(
    withLogtoSessionLock("cognia-logto-auth:slow", async () => "recovered", { locks: null })
  ).resolves.toBe("recovered")
})

it("keeps refresh and nested auth commits on separate transaction stores", async () => {
  await expect(
    withLogtoSessionLock(
      "cognia-logto-refresh:nested",
      () => withLogtoSessionLock("cognia-logto-auth:nested", async () => "done", { locks: null }),
      { locks: null }
    )
  ).resolves.toBe("done")
})

it("releases the transaction after a rejected task", async () => {
  await expect(
    withLogtoSessionLock(
      "cognia-logto-auth:failure",
      async () => {
        throw new Error("task failed")
      },
      { locks: null }
    )
  ).rejects.toThrow("task failed")
  await expect(
    withLogtoSessionLock("cognia-logto-auth:failure", async () => "next", { locks: null })
  ).resolves.toBe("next")
})

it("invalidates a retained mutation guard once its transaction is released", async () => {
  let guard!: () => void
  await withLogtoSessionLock(
    "cognia-logto-auth:guard",
    async (assertHeld) => {
      guard = assertHeld
    },
    { locks: null }
  )
  expect(guard).toThrow("no longer held")
})

it("surfaces unavailable storage instead of silently dropping cross-context exclusion", async () => {
  const open = jest.spyOn(indexedDB, "open").mockImplementation(() => {
    throw new Error("database denied")
  })
  try {
    await expect(
      withLogtoSessionLock("cognia-logto-auth:denied", async () => "unsafe", { locks: null })
    ).rejects.toThrow("database denied")
  } finally {
    open.mockRestore()
  }
})
