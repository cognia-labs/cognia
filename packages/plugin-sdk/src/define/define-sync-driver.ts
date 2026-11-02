import type { PluginSyncDriver } from "@cognia/plugin-contract/types/plugin/plugin-sync"

export function defineSyncDriver<Item>(driver: PluginSyncDriver<Item>): PluginSyncDriver<Item> {
  return driver
}

/** Throw a serializable tag; never attach a remote response body. */
export function syncRateLimited(retryAfterMs: number): never {
  throw Object.assign(new Error("External sync rate limited"), {
    name: "ExternalSyncRateLimited",
    syncError: "rate-limited",
    retryAfterMs,
  })
}

export function syncCursorInvalid(): never {
  throw Object.assign(new Error("External sync cursor invalid"), {
    name: "ExternalSyncCursorInvalid",
    syncError: "cursor-invalid",
  })
}
