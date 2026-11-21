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
  /** Injected clock for tests. */
  now?: number
  /** Cancellation signal from scheduler or UI lifecycle. */
  signal?: AbortSignal
}

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

/**
 * Generate a radar report. Returns the saved report, or `null` when a guard
 * skipped generation (too soon since the last report, or too few items).
 * Throws {@link NoRadarModelError} when no model key is available.
 */
export async function runRadarReport(opts: RunRadarOptions = {}): Promise<RadarReport | null> {
  const expectedDatabase = activeDatabaseName()
  const expectedEpoch = activeDatabaseEpoch()
  const dbGuard = { expectDatabase: expectedDatabase, expectEpoch: expectedEpoch }

  const runController = new AbortController()
  const onExternalAbort = () => {
    runController.abort(opts.signal?.reason)
  }
  if (opts.signal) {
    if (opts.signal.aborted) throwIfAborted(opts.signal)
    opts.signal.addEventListener("abort", onExternalAbort, { once: true })
  }
  const stopDbWatch = onActiveDatabaseChange((nextName) => {
    runController.abort(new RadarAccountChangedError(expectedDatabase, nextName))
  })

  const assertActiveAndNotAborted = () => {
    throwIfAborted(opts.signal)
    if (activeDatabaseName() !== expectedDatabase || activeDatabaseEpoch() !== expectedEpoch) {
      throw new RadarAccountChangedError(expectedDatabase, activeDatabaseName())
    }
    throwIfAborted(runController.signal)
  }

  try {
    assertActiveAndNotAborted()
    const settings = await getSettings()
    assertActiveAndNotAborted()
    const radar = settings?.attentionRadar ?? DEFAULT_RADAR_SETTINGS
    if (!opts.force && !radar.enabled) return null
    const now = opts.now ?? Date.now()
    const windowDays = radar.windowDays ?? DEFAULT_RADAR_SETTINGS.windowDays
    const intervalDays = radar.intervalDays ?? DEFAULT_RADAR_SETTINGS.intervalDays

    if (!opts.force) {
      const latest = await getLatestRadarReport("self", dbGuard)
      assertActiveAndNotAborted()
      if (latest && now - latest.generatedAt < intervalDays * DAY_MS) {
        return null
      }
    }

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

    let commitPromise: Promise<void> | undefined
    const unregisterFlusher = registerPendingAccountWriteFlusher(async () => {
      await commitPromise
    })
    try {
      assertActiveAndNotAborted()
      commitPromise = (async () => {
        await saveRadarReport(report, dbGuard)
        await pruneRadarReports(undefined, dbGuard)
      })()
      await commitPromise
    } finally {
      unregisterFlusher()
    }
    return report
  } finally {
    stopDbWatch()
    opts.signal?.removeEventListener("abort", onExternalAbort)
  }
}
