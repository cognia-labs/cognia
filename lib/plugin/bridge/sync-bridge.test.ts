import { bridgeSyncDriver, mapSyncCallbackError } from "./sync-bridge"
import { syncRateLimited, syncCursorInvalid } from "@cognia/plugin-sdk"
import {
  ExternalSyncCursorInvalid,
  ExternalSyncRateLimited,
} from "@/lib/external-services/sync/types"

it("round-trips SDK errors as serialized tags and sanitizes arbitrary realm errors", () => {
  for (const [thrower, Type] of [
    [() => syncRateLimited(1234), ExternalSyncRateLimited],
    [syncCursorInvalid, ExternalSyncCursorInvalid],
  ] as const) {
    try {
      thrower()
    } catch (error) {
      expect(mapSyncCallbackError(JSON.parse(JSON.stringify(error)))).toBeInstanceOf(Type)
    }
  }
  expect(mapSyncCallbackError(new Error("private remote response")).message).toBe(
    "External sync callback failed"
  )
  expect(
    mapSyncCallbackError({ name: "ExternalSyncCursorInvalid", message: "remote body" })
  ).not.toBeInstanceOf(ExternalSyncCursorInvalid)
})

it("awaits revived itemId callbacks and propagates cancellation to a callback signal", async () => {
  const controller = new AbortController()
  let received: AbortSignal | undefined
  let release!: (value: { items: string[]; cursor: string }) => void
  const driver = bridgeSyncDriver(
    {
      itemId: (async (id: string) => id) as unknown as (id: string) => string,
      fetchPage: async ({ signal }) => {
        received = signal
        return new Promise((resolve) => {
          release = resolve
        })
      },
      applyPage: async () => {},
    },
    { signal: controller.signal, check: () => {} }
  )
  const promise = driver.fetchPage({ mode: "full", signal: new AbortController().signal })
  await Promise.resolve()
  await Promise.resolve()
  controller.abort()
  await expect(promise).rejects.toMatchObject({ name: "AbortError" })
  expect(received?.aborted).toBe(true)
  release({ items: ["late"], cursor: "late" })
})

it("aborts timed-out callbacks and rejects their late result", async () => {
  let received: AbortSignal | undefined
  const driver = bridgeSyncDriver<string>(
    {
      itemId: String,
      fetchPage: ({ signal }) => {
        received = signal
        return new Promise(() => {})
      },
      applyPage: async () => {},
    },
    { signal: new AbortController().signal, check: () => {}, timeoutMs: 5 }
  )
  await expect(
    driver.fetchPage({ mode: "full", signal: new AbortController().signal })
  ).rejects.toThrow("External sync callback failed")
  expect(received?.aborted).toBe(true)
})

it("resolves revived asynchronous item ids before handing a page to the synchronous core", async () => {
  const signal = new AbortController().signal
  const driver = bridgeSyncDriver(
    {
      itemId: (async (id: string) => id) as unknown as (id: string) => string,
      fetchPage: async () => ({ items: ["one"], cursor: "next" }),
      applyPage: async () => {},
    },
    { signal, check: () => {} }
  )
  const page = await driver.fetchPage({ mode: "full", signal })
  expect(driver.itemId(page.items[0])).toBe("one")
})
