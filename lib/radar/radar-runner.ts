/**
 * Attention Radar runner — orchestrates collect → generate → persist.
 *
 * Guards (mirroring OpenWiki): skip when fewer than `RADAR_MIN_ITEMS` items are
 * available, or when the last report is newer than `intervalDays` (unless
 * `force`). Reads settings + resolves the utility LLM client the same way the
 * conversation-title generator does.
 */

import { registerPendingAccountWriteFlusher } from "@/lib/accounts/pending-write-flush"
import { activeDatabaseEpoch, activeDatabaseName, onActiveDatabaseChange } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { collectRadarItems, computeHeatmap } from "./collect"
import { generateRadarReport } from "./generate"
import {
  getLatestRadarReport,
  saveRadarReport,
  pruneRadarReports,
  RadarAccountChangedError,
} from "@/lib/db/radar-reports"
import { DEFAULT_RADAR_SETTINGS, RADAR_MIN_ITEMS, type RadarReport } from "@/types/radar"

const DAY_MS = 86_400_000

/** Thrown when no renderer-side LLM key resolves for the radar. */
export class NoRadarModelError extends Error {
  constructor(message = "No LLM API key configured for the attention radar.") {
    super(message)
    this.name = "NoRadarModelError"
  }
}

export interface RunRadarOptions {
  /** Bypass the interval + skip guards (the "Run now" button). */
  force?: boolean
  /**
   * Supersede any in-flight generation for the active account instead of
   * joining it (the "Force regenerate" action, B3).
   */
  fresh?: boolean
  /** Injected clock for tests. */
  now?: number
  /** Cancellation signal from scheduler or UI lifecycle. */
  signal?: AbortSignal
}

interface InFlightRadarRun {
  promise: Promise<RadarReport | null>
  controller: AbortController
  subscribers: Set<{ aborted: boolean }>
  superseded: boolean
}

const inFlightByScope = new Map<string, InFlightRadarRun>()

function newReportId(now: number): string {
  return `radar_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const err = new Error(
    typeof signal.reason === "string" && signal.reason ? signal.reason : "Radar report cancelled"
  )
  err.name = "AbortError"
  throw err
}

function awaitWithCallerSignal(
  flight: InFlightRadarRun,
  callerSignal?: AbortSignal
): Promise<RadarReport | null> {
  if (callerSignal?.aborted) {
    throwIfAborted(callerSignal)
  }
  const subscriber = { aborted: false }
  flight.subscribers.add(subscriber)

  return new Promise<RadarReport | null>((resolve, reject) => {
    const cleanup = () => {
      callerSignal?.removeEventListener("abort", onCallerAbort)
      flight.subscribers.delete(subscriber)
    }
    const onCallerAbort = () => {
      subscriber.aborted = true
      const hasLiveSubscriber = Array.from(flight.subscribers).some((s) => !s.aborted)
      if (!hasLiveSubscriber && !flight.controller.signal.aborted) {
        flight.controller.abort(callerSignal?.reason)
      }
      cleanup()
      try {
        throwIfAborted(callerSignal)
      } catch (err) {
        reject(err)
      }
    }
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true })
    flight.promise.then(
      (result) => {
        cleanup()
        if (callerSignal?.aborted) {
          try {
            throwIfAborted(callerSignal)
          } catch (err) {
            reject(err)
          }
          return
        }
        resolve(result)
      },
      (err) => {
        cleanup()
        reject(err)
      }
    )
  })
}

/**
 * Generate a radar report. Returns the saved report, or `null` when a guard
 * skipped generation (too soon since the last report, too few items, or all
 * sources deleted before commit). Throws {@link NoRadarModelError} when no
 * model key is available.
 *
 * Overlapping calls on the same database scope share a single in-flight
 * generation by default (`B3`); pass `fresh: true` to supersede an in-flight
 * run and start anew with fresh collection.
 */
export async function runRadarReport(opts: RunRadarOptions = {}): Promise<RadarReport | null> {
  if (opts.signal?.aborted) {
    throwIfAborted(opts.signal)
  }
  const expectedDatabase = activeDatabaseName()
  const expectedEpoch = activeDatabaseEpoch()
  const scopeKey = `${expectedDatabase}#${expectedEpoch}`
  const dbGuard = { expectDatabase: expectedDatabase, expectEpoch: expectedEpoch }

  const existing = inFlightByScope.get(scopeKey)
  if (existing && !existing.controller.signal.aborted) {
    if (opts.fresh) {
      existing.superseded = true
      inFlightByScope.delete(scopeKey)
      const supersedeErr = new Error("Radar report superseded by force regenerate")
      supersedeErr.name = "AbortError"
      existing.controller.abort(supersedeErr)
    } else {
      return awaitWithCallerSignal(existing, opts.signal)
    }
  }

  const settings = await getSettings()
  if (opts.signal?.aborted) throwIfAborted(opts.signal)
  if (activeDatabaseName() !== expectedDatabase || activeDatabaseEpoch() !== expectedEpoch) {
    throw new RadarAccountChangedError(expectedDatabase, activeDatabaseName())
  }
  const radar = settings?.attentionRadar ?? DEFAULT_RADAR_SETTINGS
  if (!opts.force && !radar.enabled) return null
  const now = opts.now ?? Date.now()
  const windowDays = radar.windowDays ?? DEFAULT_RADAR_SETTINGS.windowDays
  const intervalDays = radar.intervalDays ?? DEFAULT_RADAR_SETTINGS.intervalDays

  if (!opts.force) {
    const latest = await getLatestRadarReport("self", dbGuard)
    if (opts.signal?.aborted) throwIfAborted(opts.signal)
    if (activeDatabaseName() !== expectedDatabase || activeDatabaseEpoch() !== expectedEpoch) {
      throw new RadarAccountChangedError(expectedDatabase, activeDatabaseName())
    }
    if (latest && now - latest.generatedAt < intervalDays * DAY_MS) {
      return null
    }
  }

  // Re-check single-flight in case another caller entered generation while we
  // were checking settings/interval guards.
  const raced = inFlightByScope.get(scopeKey)
  if (!opts.fresh && raced && !raced.controller.signal.aborted) {
    return awaitWithCallerSignal(raced, opts.signal)
  }

  const runController = new AbortController()
  const flight: InFlightRadarRun = {
    controller: runController,
    subscribers: new Set(),
    superseded: false,
    promise: Promise.resolve(null),
  }
  const stopDbWatch = onActiveDatabaseChange((nextName) => {
    runController.abort(new RadarAccountChangedError(expectedDatabase, nextName))
  })

  const assertActiveAndNotAborted = () => {
    if (activeDatabaseName() !== expectedDatabase || activeDatabaseEpoch() !== expectedEpoch) {
      throw new RadarAccountChangedError(expectedDatabase, activeDatabaseName())
    }
    throwIfAborted(runController.signal)
  }

  flight.promise = (async () => {
    try {
      assertActiveAndNotAborted()
      const items = await collectRadarItems({
        windowDays,
        now,
        signal: runController.signal,
      })
      assertActiveAndNotAborted()
      if (items.length < RADAR_MIN_ITEMS) return null

      const client = buildUtilityLlmClient({
        session: null,
        appSettings: settings,
        featureId: "attention-radar",
      })
      if (!client) throw new NoRadarModelError()

      const out = await generateRadarReport(client, {
        items,
        locale: settings?.language,
        signal: runController.signal,
      })
      assertActiveAndNotAborted()
      const reportId = newReportId(now)
      const report: RadarReport = {
        id: reportId,
        scope: "self",
        generatedAt: now,
        windowDays,
        itemCount: items.length,
        heatmap: computeHeatmap(items, windowDays, now),
        ...out,
        sources: items.map(({ id, source, at }) => ({ id, source, at })),
        suggestions: out.actions.map((_, actionIndex) => ({
          id: `${reportId}:action:${actionIndex}`,
          actionIndex,
          status: "pending",
        })),
      }

      let savedReport: RadarReport | null = report
      let commitPromise: Promise<void> | undefined
      const unregisterFlusher = registerPendingAccountWriteFlusher(async () => {
        await commitPromise
      })
      try {
        assertActiveAndNotAborted()
        commitPromise = (async () => {
          const persisted = await saveRadarReport(report, {
            ...dbGuard,
            verifyLiveSources: true,
            now,
          })
          // `saveRadarReport` returns `null` when `verifyLiveSources` drops all
          // deleted sources (`B1`), and `undefined` in legacy void mocks.
          savedReport = persisted === null ? null : (persisted ?? report)
          if (savedReport !== null) {
            await pruneRadarReports(undefined, dbGuard)
          }
        })()
        await commitPromise
      } finally {
        unregisterFlusher()
      }
      return savedReport
    } finally {
      stopDbWatch()
      if (inFlightByScope.get(scopeKey) === flight) {
        inFlightByScope.delete(scopeKey)
      }
    }
  })()

  inFlightByScope.set(scopeKey, flight)
  return awaitWithCallerSignal(flight, opts.signal)
}
