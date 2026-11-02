/** Realm callback adapter. Only allowlisted sync tags survive the Host boundary. */
import type { PluginSyncDriver } from "@cognia/plugin-contract/types/plugin/plugin-sync"
import {
  ExternalSyncCursorInvalid,
  ExternalSyncRateLimited,
  type ExternalSyncDriver,
} from "@/lib/external-services/sync/types"

export function mapSyncCallbackError(error: unknown): Error {
  const tag = error && typeof error === "object" ? (error as Record<string, unknown>) : {}
  if (tag.name === "ExternalSyncCursorInvalid" && tag.syncError === "cursor-invalid")
    return new ExternalSyncCursorInvalid()
  if (
    tag.name === "ExternalSyncRateLimited" &&
    tag.syncError === "rate-limited" &&
    typeof tag.retryAfterMs === "number"
  )
    return new ExternalSyncRateLimited(tag.retryAfterMs)
  return new Error("External sync callback failed")
}

function validString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 16 * 1024
  )
}
function ids(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((id) => !validString(id)))
    throw new Error("Invalid sync ids")
}

export function bridgeSyncDriver<Item>(
  input: PluginSyncDriver<Item>,
  options: {
    signal: AbortSignal
    check: () => void | Promise<void>
    timeoutMs?: number
  }
): ExternalSyncDriver<Item> {
  const driver = { ...input }
  if (
    [driver.itemId, driver.fetchPage, driver.applyPage].some((fn) => typeof fn !== "function") ||
    [driver.listKnownIds, driver.tombstone, driver.complete].some(
      (fn) => fn !== undefined && typeof fn !== "function"
    ) ||
    (driver.fullScanOnly !== undefined && typeof driver.fullScanOnly !== "boolean")
  )
    throw new Error("Invalid sync driver")
  let itemIds = new Map<Item, string>()
  async function invoke<T>(
    signal: AbortSignal,
    call: (signal: AbortSignal) => T | Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => controller.abort()
    const signals = [signal, options.signal]
    for (const source of signals) {
      source.addEventListener("abort", abort, { once: true })
      if (source.aborted) abort()
    }
    let rejectCancelled: (() => void) | undefined
    try {
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancelled = () => reject(new DOMException("Sync cancelled", "AbortError"))
        controller.signal.addEventListener("abort", rejectCancelled, { once: true })
        if (controller.signal.aborted) rejectCancelled()
      })
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Sync callback timed out"))
          controller.abort()
        }, options.timeoutMs ?? 30_000)
      })
      return await Promise.race([
        cancelled,
        timeout,
        Promise.resolve().then(async () => {
          controller.signal.throwIfAborted()
          await options.check()
          controller.signal.throwIfAborted()
          const result = await call(controller.signal)
          await options.check()
          controller.signal.throwIfAborted()
          return result
        }),
      ])
    } catch (error) {
      if (
        signals.some((source) => source.aborted) ||
        (error !== null &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "AbortError")
      )
        throw new DOMException("Sync cancelled", "AbortError")
      throw mapSyncCallbackError(error)
    } finally {
      clearTimeout(timer)
      for (const source of signals) source.removeEventListener("abort", abort)
      if (rejectCancelled) controller.signal.removeEventListener("abort", rejectCancelled)
    }
  }
  return {
    fullScanOnly: driver.fullScanOnly,
    itemId(item) {
      const id = itemIds.get(item)
      if (id === undefined) throw new Error("Invalid sync item id")
      return id
    },
    fetchPage: (context) =>
      invoke(context.signal, async (signal) => {
        const page = await driver.fetchPage({ ...context, signal })
        signal.throwIfAborted()
        if (
          !page ||
          !Array.isArray(page.items) ||
          page.items.length > 1000 ||
          (page.deleted !== undefined &&
            (!Array.isArray(page.deleted) || page.deleted.length > 1000)) ||
          [page.nextPage, page.cursor].some((token) => token !== undefined && !validString(token))
        )
          throw new Error("Invalid sync page")
        ids(page.deleted ?? [])
        const items = [...page.items]
        const nextIds = new Map<Item, string>()
        // Revived Node-target callbacks are asynchronous, including itemId.
        for (const item of items) {
          const id = await driver.itemId(item)
          signal.throwIfAborted()
          if (!validString(id)) throw new Error("Invalid sync item id")
          nextIds.set(item, id)
        }
        itemIds = nextIds
        return {
          items,
          deleted: [...(page.deleted ?? [])],
          nextPage: page.nextPage,
          cursor: page.cursor,
        }
      }),
    applyPage: (page, context) =>
      invoke(context.signal, (signal) => driver.applyPage(page, { ...context, signal })),
    ...(driver.listKnownIds
      ? {
          listKnownIds: (signal: AbortSignal) =>
            invoke(signal, async (inner) => {
              const known = await driver.listKnownIds!(inner)
              ids(known)
              return [...known]
            }),
        }
      : {}),
    ...(driver.tombstone
      ? {
          tombstone: (removed: string[], context: { generation: string; signal: AbortSignal }) =>
            invoke(context.signal, (signal) => driver.tombstone!(removed, { ...context, signal })),
        }
      : {}),
    complete: (context) => invoke(context.signal, (signal) => driver.complete?.({ signal })),
  }
}
