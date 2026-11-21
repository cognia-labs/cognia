/**
 * The production entry point for the USD cost budget.
 *
 * One call, made before a turn spends anything:
 *
 *   const decision = await enforceCostBudget({ providerId, runId, signal })
 *   if (!decision.allowed) return    // the user declined the overrun
 *
 * It reads the ceilings from settings, reads the spend from the durable
 * rollup, announces any newly-crossed threshold, and — at 100% — blocks until
 * a human approves exactly one more request.
 *
 * ## What it can and cannot promise
 *
 * The spend it reads is BOOKED spend: a request still running has not been
 * booked yet. Far from a ceiling that is harmless. Near one, two requests let
 * in together could each fit and still overrun it together ($9 of $10 booked,
 * two $2 requests: $13). So once a scope is past its warning level, a request
 * that passes holds that scope until its turn settles, and the next request
 * waits for it and re-reads the spend. It is still not a hard cap — a single
 * request can cost more than the room left, which only a reservation can
 * prevent (Router + Fusion holds the money before the call, ADR-0188).
 *
 * A configured ceiling whose spend or settings cannot be read asks a person
 * (or, for work nobody waits on, counts as exhausted); it never lets the
 * request through unchecked.
 *
 * ## Why blocking, when the routing budget only warns
 *
 * `ProviderConstraint.dailyCostBudget` is advisory by design: it deprioritises
 * an over-budget provider and, if it was the only candidate, shows a toast and
 * proceeds. That is the right behaviour for a routing PREFERENCE. It is the
 * wrong behaviour for a spending LIMIT — a warning that scrolls past is how
 * people discover a budget was exceeded by reading the invoice. The two coexist:
 * routing still steers, this still stops.
 */

import type { AppSettings } from "@cognia/agent-config-types"

import { useSettingsStore } from "@/stores/settings"

import {
  evaluateCostBudget,
  exceededScopes,
  hasAnyCostCeiling,
  projectHasCostCeiling,
  worstCostBudgetVerdict,
  type CostBudgetLevel,
  type CostBudgetPolicy,
  type CostBudgetVerdict,
} from "./cost-budget"
import {
  notifyCostBudgetThreshold,
  readCostBudgetSpend,
  requestCostBudgetOverride,
  requestUncheckedBudgetApproval,
} from "./cost-budget-runtime"
import {
  blockingCostBudgetHold,
  releaseCostBudgetHolds,
  resetCostBudgetHolds,
  takeCostBudgetHold,
  waitForCostBudgetHold,
} from "./cost-budget-holds"

export interface EnforceCostBudgetInput {
  /** Provider about to be charged. Scopes the per-provider ceilings. */
  providerId?: string
  /** Workspace the send belongs to. Scopes the per-project ceilings (ADR-0204). */
  projectId?: string
  /**
   * Run this send belongs to — labels the HITL gate, and owns the in-flight
   * hold near a ceiling, released when that run's turn settles.
   */
  runId?: string
  /** Session the run belongs to: a session's turn settling releases its holds too. */
  sessionId?: string
  signal?: AbortSignal
  /** Injected for tests; defaults to the persisted settings singleton. */
  loadSettings?: () => Promise<AppSettings | undefined>
  now?: number
}

export interface CostBudgetGateResult {
  allowed: boolean
  /** The most severe scope evaluated, or `null` when no ceiling is configured. */
  verdict: CostBudgetVerdict | null
  /** Scopes that blocked, when `allowed` is false. */
  blockedBy: CostBudgetVerdict[]
}

const ALLOW_UNCONFIGURED: CostBudgetGateResult = { allowed: true, verdict: null, blockedBy: [] }

/** Highest level already announced per scope, per process. */
const announced = new Map<string, CostBudgetLevel>()

/** Test-only: forget which thresholds have been announced, and every hold. */
export function __resetCostBudgetGateForTesting(): void {
  announced.clear()
  resetCostBudgetHolds()
}

/** The hydrated settings' policy: what a failed settings read falls back to. */
function hydratedPolicy(): CostBudgetPolicy {
  try {
    return useSettingsStore.getState().settings?.costBudget ?? {}
  } catch {
    return {}
  }
}

/**
 * Synchronous pre-check: is any ceiling configured at all?
 *
 * The send path calls this FIRST so the default install — which configures no
 * budget — pays nothing for the feature. `enforceCostBudget` is async, and
 * awaiting it unconditionally would add a hop to every turn purely to discover
 * there is no limit to check. Reads the hydrated settings store, not Dexie, for
 * the same reason.
 */
export function isCostBudgetConfigured(): boolean {
  try {
    const settings = useSettingsStore.getState().settings
    return hasAnyCostCeiling(settings?.costBudget ?? {})
  } catch {
    return false
  }
}

async function defaultLoadSettings(): Promise<AppSettings | undefined> {
  const { getSettings } = await import("@/lib/db/settings")
  return getSettings()
}

/**
 * Evaluate the budget for one prospective send.
 *
 * With no ceiling configured it allows without reading anything. With one
 * configured and the settings or the spend unreadable, it asks a person to let
 * this one request through unchecked: the user asked not to overspend, and a
 * request nobody checked is the one that can.
 */
export async function enforceCostBudget(
  input: EnforceCostBudgetInput = {}
): Promise<CostBudgetGateResult> {
  let policy: CostBudgetPolicy
  try {
    const settings = await (input.loadSettings ?? defaultLoadSettings)()
    policy = settings?.costBudget ?? {}
  } catch {
    if (!hasAnyCostCeiling(hydratedPolicy())) return ALLOW_UNCONFIGURED
    return allowUnchecked(input)
  }
  if (!hasAnyCostCeiling(policy)) return ALLOW_UNCONFIGURED

  for (;;) {
    let verdicts: CostBudgetVerdict[]
    try {
      const spend = await readCostBudgetSpend(
        input.now,
        input.projectId && projectHasCostCeiling(policy, input.projectId) ? [input.projectId] : []
      )
      verdicts = evaluateCostBudget(policy, spend, input.providerId, input.projectId)
    } catch {
      return allowUnchecked(input)
    }

    // Near a ceiling the booked spend misses whatever is still running: wait
    // for the request holding the scope, then judge again on what it booked.
    const near = verdicts.filter((verdict) => verdict.level !== "ok").map((v) => v.scopeKey)
    const holder = near.length > 0 ? blockingCostBudgetHold(near, input.runId) : undefined
    if (holder) {
      try {
        await waitForCostBudgetHold(holder, input.signal)
      } catch {
        return { allowed: false, verdict: worstCostBudgetVerdict(verdicts), blockedBy: [] }
      }
      continue
    }
    // Held from here, before any await, so a concurrent request waits for
    // this one's approval and its spend instead of racing it.
    if (near.length > 0 && input.runId) {
      takeCostBudgetHold({
        runId: input.runId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        scopes: near,
      })
    }

    await announceThresholds(verdicts, input.now)

    const blocking = exceededScopes(verdicts)
    const worst = worstCostBudgetVerdict(verdicts)
    if (blocking.length === 0) return { allowed: true, verdict: worst, blockedBy: [] }

    // Every blocking scope needs its own answer: approving the daily overrun
    // does not authorise blowing through the monthly one.
    for (const verdict of blocking) {
      const decision = await requestCostBudgetOverride(verdict, {
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      if (!decision.approved) {
        if (input.runId) releaseCostBudgetHolds({ runId: input.runId })
        return { allowed: false, verdict: worst, blockedBy: blocking }
      }
    }
    return { allowed: true, verdict: worst, blockedBy: [] }
  }
}

/** A ceiling is configured but could not be checked: one person-approved request. */
async function allowUnchecked(input: EnforceCostBudgetInput): Promise<CostBudgetGateResult> {
  const decision = await requestUncheckedBudgetApproval({
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  return { allowed: decision.approved, verdict: null, blockedBy: [] }
}

/**
 * Whether a send now would exceed a ceiling, without asking anyone. For work
 * nobody is waiting on, such as a background job's wake (ADR-0249 §4): such
 * work is not started over budget, and no person is asked to approve it. A
 * configured ceiling that cannot be read counts as exhausted, the same answer
 * {@link enforceCostBudget} gets from a person who is not there.
 */
export async function isCostBudgetExhausted(
  input: Pick<EnforceCostBudgetInput, "providerId" | "projectId" | "loadSettings" | "now"> = {}
): Promise<boolean> {
  let policy: CostBudgetPolicy
  try {
    const settings = await (input.loadSettings ?? defaultLoadSettings)()
    policy = settings?.costBudget ?? {}
  } catch {
    return hasAnyCostCeiling(hydratedPolicy())
  }
  if (!hasAnyCostCeiling(policy)) return false
  try {
    const spend = await readCostBudgetSpend(
      input.now,
      input.projectId && projectHasCostCeiling(policy, input.projectId) ? [input.projectId] : []
    )
    return (
      exceededScopes(evaluateCostBudget(policy, spend, input.providerId, input.projectId)).length >
      0
    )
  } catch {
    return true
  }
}

/** Notify once per scope per level; re-arm when a scope falls back to ok. */
async function announceThresholds(
  verdicts: readonly CostBudgetVerdict[],
  now?: number
): Promise<void> {
  for (const verdict of verdicts) {
    if (verdict.level === "ok") {
      // A new day or a raised ceiling must be able to warn again.
      announced.delete(verdict.scopeKey)
      continue
    }
    if (announced.get(verdict.scopeKey) === verdict.level) continue
    announced.set(verdict.scopeKey, verdict.level)
    try {
      await notifyCostBudgetThreshold(verdict, now)
    } catch {
      // A failed notification must not block the send it was warning about.
    }
  }
}
