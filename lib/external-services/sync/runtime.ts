import { listDeferredExternalSyncs } from "@/lib/db/external-sync"
import { abortExternalSyncRuns, runExternalSync } from "./core"
import type { ExternalSyncDriver, ExternalSyncTarget } from "./types"

interface Registration {
  target: ExternalSyncTarget
  factory: () => ExternalSyncDriver<unknown> | Promise<ExternalSyncDriver<unknown>>
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
  running?: Promise<void>
  rerun: boolean
  full: boolean
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
  driverFactory: () => ExternalSyncDriver<Item> | Promise<ExternalSyncDriver<Item>>
): () => void {
  if (registrations.has(target.key)) throw new Error("External sync key already registered")
  const entry: Registration = {
    target,
    factory: driverFactory as Registration["factory"],
    rerun: false,
    full: false,
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
  }
  abortExternalSyncRuns(key)
}

/** Include registrations that have not persisted their first generation yet. */
export function unregisterExternalSyncTargets(
  matches: (target: ExternalSyncTarget) => boolean
): void {
  for (const [key, entry] of registrations) {
    if (matches(entry.target)) unregisterExternalSync(key)
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
      const driver = await entry.factory()
      if (!controller.signal.aborted)
        await runExternalSync(entry.target, driver, {
          mode: full ? "full" : "auto",
          signal: controller.signal,
        })
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
  entry.full ||= reason === "manual" && options.full === true
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
