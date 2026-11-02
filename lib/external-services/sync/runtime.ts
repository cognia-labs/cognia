import { listDeferredExternalSyncs } from "@/lib/db/external-sync"
import { abortExternalSyncRuns, runExternalSync } from "./core"
import type { ExternalSyncDriver, ExternalSyncTarget } from "./types"

type PreparedDriver<Item> =
  ExternalSyncDriver<Item> | { driver: ExternalSyncDriver<Item>; target?: ExternalSyncTarget }

interface Registration {
  target: ExternalSyncTarget
  resolvedTarget?: ExternalSyncTarget
  factory: () => PreparedDriver<unknown> | Promise<PreparedDriver<unknown>>
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
  running?: Promise<void>
  rerun: boolean
  full: boolean
  signal?: AbortSignal
  onUnregister?: () => void
}
const registrations = new Map<string, Registration>()
const DEBOUNCE_MS = 2000

export function hasExternalSyncRegistration(key: string): boolean {
  return registrations.has(key)
}

/** Pending target keys, so consumers need no private debounce state. */
export function pendingExternalSyncKeys(): string[] {
  return [...registrations]
    .filter(([, entry]) => entry.timer !== undefined || entry.running !== undefined)
    .map(([key]) => key)
}

export function registerExternalSync<Item>(
  target: ExternalSyncTarget,
  driverFactory: () => PreparedDriver<Item> | Promise<PreparedDriver<Item>>,
  options: { signal?: AbortSignal; onUnregister?: () => void } = {}
): () => void {
  if (registrations.has(target.key)) throw new Error("External sync key already registered")
  const entry: Registration = {
    target: { ...target },
    factory: driverFactory as Registration["factory"],
    rerun: false,
    full: false,
    ...options,
  }
  registrations.set(target.key, entry)
  return () => {
    if (registrations.get(target.key) === entry) unregisterExternalSync(target.key)
  }
}

export function unregisterExternalSync(key: string): void {
  const entry = registrations.get(key)
  if (entry) {
    registrations.delete(key)
    clearTimeout(entry.timer)
    entry.controller?.abort()
    entry.onUnregister?.()
  }
  abortExternalSyncRuns(key)
}

/** Include registrations that have not persisted their first generation yet. */
export function unregisterExternalSyncTargets(
  matches: (target: ExternalSyncTarget) => boolean
): void {
  for (const [key, entry] of registrations) {
    if (matches(entry.target) || (entry.resolvedTarget && matches(entry.resolvedTarget)))
      unregisterExternalSync(key)
  }
}

function start(entry: Registration): void {
  if (registrations.get(entry.target.key) !== entry) return
  entry.timer = undefined
  const full = entry.full
  entry.full = false
  entry.rerun = false
  const controller = new AbortController()
  entry.controller = controller
  entry.running = Promise.resolve()
    .then(async () => {
      const prepared = await entry.factory()
      if (
        !controller.signal.aborted &&
        !entry.signal?.aborted &&
        registrations.get(entry.target.key) === entry
      ) {
        const { driver, target = entry.target } =
          "driver" in prepared ? prepared : { driver: prepared }
        if (target.key !== entry.target.key || target.owner !== entry.target.owner)
          throw new Error("External sync factory changed target identity")
        // Host factories resolve credential identity asynchronously. Keep their
        // per-run snapshot separate from the registered binding (plugins use it as-is).
        entry.resolvedTarget = Object.freeze({ ...target })
        await runExternalSync(entry.resolvedTarget, driver, {
          mode: full ? "full" : "auto",
          signal: entry.signal
            ? AbortSignal.any([controller.signal, entry.signal])
            : controller.signal,
        })
      }
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError"))
        return
      // Factories and storage can fail before a run can return an outcome.
      // Never log provider errors, which may contain remote content.
      console.warn("External sync runtime failed")
    })
    .finally(() => {
      entry.running = undefined
      entry.controller = undefined
      if (entry.rerun && registrations.get(entry.target.key) === entry) start(entry)
    })
}

export function requestExternalSync(
  key: string,
  reason: "poll" | "push" | "manual" | "online",
  options: { full?: boolean } = {}
): void {
  const entry = registrations.get(key)
  if (!entry) return
  entry.full ||= options.full === true
  if (entry.running) {
    entry.rerun = true
    return
  }
  if (reason === "manual") {
    clearTimeout(entry.timer)
    start(entry)
  } else if (!entry.timer) entry.timer = setTimeout(() => start(entry), DEBOUNCE_MS)
}

export function installExternalSyncRuntime(): () => void {
  let disposed = false
  const online = () => {
    void listDeferredExternalSyncs()
      .then((rows) => {
        if (!disposed) for (const row of rows) requestExternalSync(row.key, "online")
      })
      .catch(() => console.warn("External sync online recovery failed"))
  }
  if (typeof window !== "undefined") window.addEventListener("online", online)
  return () => {
    disposed = true
    if (typeof window !== "undefined") window.removeEventListener("online", online)
    for (const key of [...registrations.keys()]) unregisterExternalSync(key)
  }
}
