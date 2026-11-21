/**
 * Requests let in near a USD ceiling whose spend is not booked yet.
 *
 * The generic cost budget (`./cost-budget-gate.ts`) judges BOOKED spend. Past
 * a scope's warning level, a request it lets in holds that scope until its
 * turn settles, so the next request waits and is judged on what the first one
 * booked. Kept apart from the gate so the places that settle a turn (the chat
 * terminal, the work-submission service) release holds without importing the
 * gate's settings and notification wiring.
 */

/**
 * How long a hold serializes its scopes when its turn's settle never reaches
 * this process (a send that died before it was accepted, a turn settled
 * elsewhere). Past it the hold stops counting, so a lost settle costs one long
 * wait, never a scope that stays shut.
 */
export const COST_BUDGET_HOLD_TTL_MS = 15 * 60_000

export interface CostBudgetHold {
  runId: string
  sessionId?: string
  /** Scope keys (`day:*`, `month:project:alpha`, …) the request holds. */
  scopes: readonly string[]
  expiresAt: number
}

/** One hold per run: a run's later check replaces its earlier one. */
const holds = new Map<string, CostBudgetHold>()
const waiters = new Set<() => void>()

/** Hold `scopes` for `runId` until its turn settles or the TTL passes. */
export function takeCostBudgetHold(
  hold: Omit<CostBudgetHold, "expiresAt">,
  now: number = Date.now()
): void {
  holds.set(hold.runId, { ...hold, expiresAt: now + COST_BUDGET_HOLD_TTL_MS })
}

/**
 * The turn of `runId` (or every turn of `sessionId`) settled: its spend is
 * booked or never will be, so the scopes it held are free for the next
 * request to judge again.
 */
export function releaseCostBudgetHolds(owner: { runId?: string; sessionId?: string }): void {
  let released = false
  for (const [runId, hold] of holds) {
    if (
      (owner.runId !== undefined && runId === owner.runId) ||
      (owner.sessionId !== undefined && hold.sessionId === owner.sessionId)
    ) {
      holds.delete(runId)
      released = true
    }
  }
  if (released) for (const wake of [...waiters]) wake()
}

/** The live hold, other than `runId`'s own, on any of `scopes`: the one expiring first. */
export function blockingCostBudgetHold(
  scopes: readonly string[],
  runId: string | undefined,
  now: number = Date.now()
): CostBudgetHold | undefined {
  let blocking: CostBudgetHold | undefined
  for (const [id, hold] of holds) {
    if (hold.expiresAt <= now) {
      holds.delete(id)
      continue
    }
    if (id === runId || !hold.scopes.some((scope) => scopes.includes(scope))) continue
    if (!blocking || hold.expiresAt < blocking.expiresAt) blocking = hold
  }
  return blocking
}

/**
 * Resolve when any hold is released or `hold` expires; reject when `signal`
 * aborts. The caller judges again either way: a release elsewhere may not be
 * the one it waits for.
 */
export function waitForCostBudgetHold(
  hold: CostBudgetHold,
  signal: AbortSignal | undefined,
  now: number = Date.now()
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"))
      return
    }
    const stop = () => {
      clearTimeout(timer)
      waiters.delete(done)
      signal?.removeEventListener("abort", onAbort)
    }
    const done = () => {
      stop()
      resolve()
    }
    const onAbort = () => {
      stop()
      reject(signal?.reason ?? new Error("Aborted"))
    }
    const timer = setTimeout(done, Math.max(0, hold.expiresAt - now))
    waiters.add(done)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Test-only: drop every hold and wake every waiter. */
export function resetCostBudgetHolds(): void {
  holds.clear()
  for (const wake of [...waiters]) wake()
}
