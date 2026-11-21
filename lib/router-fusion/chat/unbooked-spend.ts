/**
 * Router + Fusion spend the account's usage rows do not hold yet (F23).
 *
 * A run's tenant hold covers its money until a call settles; settling gives
 * the hold back at once, but the usage row that books the cost reaches the
 * account database later — through the ledger's outbox, or as the chat's own
 * row after the turn sealed its run. In that gap the budget read from the
 * rollup still showed the money as free, so a second run could be admitted on
 * it. The tenant limit subtracts this figure to close the gap.
 */

import { bookedUsdByRun } from "@/lib/db/session-usage"

import { currentFusionStore } from "./store-provider"

/** How far back a still-open run may have started. Runs end at their deadline long before. */
export const UNBOOKED_RUN_LOOKBACK_MS = 24 * 60 * 60_000

/**
 * How long after a run is sealed its usage row is still expected. A row that
 * has not landed by then is a stuck projection, not money in flight, and
 * keeping it held would shrink the limit for good.
 */
export const UNBOOKED_SEAL_WINDOW_MS = 10 * 60_000

/** Microusd that runs have spent beyond what the account has booked for them. */
export async function unbookedFusionSpendMicrousd(now: number = Date.now()): Promise<number> {
  const store = await currentFusionStore()
  const runs = await store.recentRunSpend(
    now - UNBOOKED_RUN_LOOKBACK_MS,
    now - UNBOOKED_SEAL_WINDOW_MS
  )
  if (runs.length === 0) return 0
  const booked = await bookedUsdByRun(runs.map((run) => run.runId))
  let unbooked = 0
  for (const run of runs) {
    const bookedMicrousd = Math.round((booked.get(run.runId) ?? 0) * 1_000_000)
    unbooked += Math.max(0, run.spentMicrousd - bookedMicrousd)
  }
  return unbooked
}
