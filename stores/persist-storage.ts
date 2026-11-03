/**
 * Shared zustand-persist storage factory.
 *
 * Every persisted store used to do `createJSONStorage(() => localStorage)`.
 * That relies on a bare `localStorage` reference THROWING outside the browser:
 * zustand wraps the getter in a try/catch and disables persistence when it
 * throws. Node >= 26 broke that assumption — it declares `localStorage` as a
 * real global that evaluates to `undefined` (with an ExperimentalWarning)
 * unless `--localstorage-file` is passed, so nothing throws, zustand keeps the
 * `undefined` storage, and the first `setState` dies with
 * `Cannot read properties of undefined (reading 'setItem')`.
 *
 * That hits every Node-side consumer of a persisted store — CLI, sidecar,
 * headless — not just tests. Resolve the storage explicitly instead of
 * leaning on a ReferenceError.
 */

import { createJSONStorage } from "zustand/middleware"
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware"

import { loggers } from "@cognia/logging"

/** Inert storage: persistence is simply skipped when there is no Web Storage. */
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}

/**
 * Resolve the browser's localStorage, or an inert stand-in when unavailable
 * (SSR, the static-export prerender, Node-side CLI/sidecar/headless runs, or a
 * browser that denies storage access).
 */
export function resolvePersistStorage(): StateStorage {
  if (typeof window === "undefined") return noopStorage
  try {
    return window.localStorage ?? noopStorage
  } catch {
    // Safari/Chrome throw on `window.localStorage` when cookies are blocked.
    return noopStorage
  }
}

/**
 * Drop-in replacement for `createJSONStorage(() => localStorage)` in a
 * `persist(...)` config. Behaves identically in the browser.
 */
export function persistLocalStorage() {
  return createJSONStorage(resolvePersistStorage)
}

// =============================================================================
// Coalesced writes
// =============================================================================

/** Default quiet period before a coalesced write lands. */
export const PERSIST_COALESCE_WAIT_MS = 250
/** Default ceiling: a write never waits longer than this behind a busy store. */
export const PERSIST_COALESCE_MAX_WAIT_MS = 1000

export interface CoalescedPersistOptions {
  /** Quiet period after the last change before the write lands. */
  waitMs?: number
  /** Longest a pending write may be held while changes keep arriving. */
  maxWaitMs?: number
}

/**
 * A persist storage whose writes are coalesced. `flush` writes what is pending
 * now (for one key or all of them); `cancel` drops a pending write without
 * writing it, for a key that is about to be deleted.
 */
export interface CoalescedPersistStorage<S> extends PersistStorage<S> {
  flush: (name?: string) => void
  cancel: (name: string) => void
  /** Whether a write for `name` (or any key) is still pending. */
  hasPending: (name?: string) => boolean
}

interface PendingWrite<S> {
  value: StorageValue<S>
  firstAt: number
  timer: ReturnType<typeof setTimeout>
}

const liveCoalescedStorages = new Set<{ flush: () => void }>()
let lifecycleInstalled = false

/**
 * Write every coalesced persist store's pending state now. Runs on its own when
 * the page is hidden or unloaded; call it before reading a coalesced key
 * straight out of localStorage.
 */
export function flushPendingPersistWrites(): void {
  for (const storage of liveCoalescedStorages) storage.flush()
}

function installLifecycleFlush(): void {
  if (lifecycleInstalled || typeof window === "undefined") return
  lifecycleInstalled = true
  // `pagehide` and a hidden document are the last moments a page (or a Tauri
  // webview being closed) reliably runs script; `beforeunload` covers the
  // engines that skip one of them.
  window.addEventListener("pagehide", flushPendingPersistWrites)
  window.addEventListener("beforeunload", flushPendingPersistWrites)
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushPendingPersistWrites()
    })
  }
}

/**
 * `persistLocalStorage()` with coalesced writes, for a store that changes in
 * bursts and persists a large snapshot.
 *
 * zustand's `persist` serializes and writes the whole partialized state on
 * EVERY `set()`. For a store that mutates dozens of times a second (the plugin
 * store while plugins activate) that is a synchronous `JSON.stringify` and a
 * synchronous localStorage write per change, on the main thread. Here the
 * latest value is held and written once the store has been quiet for `waitMs`
 * (or after `maxWaitMs` at most), so a burst costs one write. Serialization is
 * deferred too: the held value is the state object, not a string.
 *
 * Reads see pending values, so a rehydrate inside the window gets the latest
 * state. Pending writes are flushed when the page is hidden or unloaded.
 * Without a browser (SSR, CLI, sidecar) writes pass straight through to the
 * inert storage, so no timer is ever left running there.
 */
export function persistCoalescedLocalStorage<S>(
  options: CoalescedPersistOptions = {}
): CoalescedPersistStorage<S> {
  const waitMs = options.waitMs ?? PERSIST_COALESCE_WAIT_MS
  const maxWaitMs = Math.max(waitMs, options.maxWaitMs ?? PERSIST_COALESCE_MAX_WAIT_MS)
  // `resolvePersistStorage` never throws, so `createJSONStorage` always
  // returns a storage; the fallback only satisfies its `| undefined` type.
  const inner = createJSONStorage<S>(resolvePersistStorage) ?? {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  }
  const pending = new Map<string, PendingWrite<S>>()

  const writeNow = (name: string, value: StorageValue<S>) => {
    try {
      inner.setItem(name, value)
    } catch (error) {
      // A timer has no caller to throw to; a full or denied storage must not
      // become an uncaught error. The next change retries the write.
      loggers.store.warn("Coalesced persist write failed", {
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const flush = (name?: string) => {
    const names = name === undefined ? [...pending.keys()] : [name]
    for (const key of names) {
      const entry = pending.get(key)
      if (!entry) continue
      clearTimeout(entry.timer)
      pending.delete(key)
      writeNow(key, entry.value)
    }
  }

  const cancel = (name: string) => {
    const entry = pending.get(name)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(name)
  }

  const storage: CoalescedPersistStorage<S> = {
    getItem: (name) => pending.get(name)?.value ?? inner.getItem(name),
    setItem: (name, value) => {
      if (typeof window === "undefined") {
        inner.setItem(name, value)
        return
      }
      installLifecycleFlush()
      const now = Date.now()
      const previous = pending.get(name)
      if (previous) clearTimeout(previous.timer)
      const firstAt = previous?.firstAt ?? now
      const delay = Math.max(0, Math.min(waitMs, firstAt + maxWaitMs - now))
      pending.set(name, { value, firstAt, timer: setTimeout(() => flush(name), delay) })
    },
    removeItem: (name) => {
      cancel(name)
      inner.removeItem(name)
    },
    flush,
    cancel,
    hasPending: (name) => (name === undefined ? pending.size > 0 : pending.has(name)),
  }
  liveCoalescedStorages.add({ flush: () => flush() })
  return storage
}
