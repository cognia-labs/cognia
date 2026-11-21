/**
 * Token budget tracker with four escalation actions.
 *
 * Per ADR-0022 §3.3. Listens to `add(usage)` calls from the team.task.dispatch
 * executor; fires `warning_crossed` / `critical_crossed` events once each per
 * run (until `extendLimit` resets thresholds). On `critical_crossed`, dispatches
 * one of four `onCritical` actions:
 *
 *   - notify: emit a critical notification, run continues
 *   - pause_for_review: emit pause_for_review event (synthesizer opens gate)
 *   - reduce_concurrency: concurrencyCtrl.reduceTo(1) + warn notification
 *   - handoff_to_background: concurrency=1 + modelPref.downshift() +
 *     notifier.suspend() + entered_background_mode event
 */

import type { TeamNotifier } from "../team-notifier"
import type { ConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import type { ModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"
import type { AgentTeamConfig, TeamBudgetEscalationAction } from "@/types/agent/agent-team"
import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"

export type BudgetEventName =
  "warning_crossed" | "critical_crossed" | "pause_for_review" | "entered_background_mode"

export interface BudgetGuardOptions {
  runId: string
  /** Token budget; 0 = unlimited. */
  limit: number
  /** Tokens already consumed by earlier attempts of the same durable run. */
  initialUsed?: number
  /** Warning threshold ratio (0–1). Default 0.80. */
  warnAt?: number
  /** Critical threshold ratio (0–1). Default 0.95. */
  critAt?: number
  /** One of the 4 ADR-0022 §3.3 escalation actions. */
  onCritical: TeamBudgetEscalationAction
  notifier: TeamNotifier
  concurrencyCtrl?: ConcurrencyController
  modelCtrl?: ModelPreferenceController
}

export interface EffectiveSquadBudget {
  limit: number
  warnAt: number
  critAt: number
  onCritical: TeamBudgetEscalationAction
  /** Present when pre-existing `tokenBudget` and `governancePolicy.budget.tokenBudget` disagree (> 0). */
  conflict?: {
    legacyTokenBudget: number
    governanceTokenBudget: number
  }
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

/**
 * Resolve the single effective budget policy for a Squad config.
 *
 * When both legacy `config.tokenBudget` (> 0) and `governancePolicy.budget.tokenBudget`
 * (> 0) exist and disagree on an un-migrated row, the non-zero legacy cap wins
 * so an existing budget is never silently raised or zeroed, and `conflict` is
 * reported for settings surfaces.
 */
export function resolveEffectiveSquadBudget(
  config: Partial<AgentTeamConfig> | undefined
): EffectiveSquadBudget {
  const legacyRaw =
    typeof config?.tokenBudget === "number" && Number.isFinite(config.tokenBudget)
      ? Math.max(0, Math.trunc(config.tokenBudget))
      : 0
  const govBudget = config?.governancePolicy?.budget
  const govRaw =
    typeof govBudget?.tokenBudget === "number" && Number.isFinite(govBudget.tokenBudget)
      ? Math.max(0, Math.trunc(govBudget.tokenBudget))
      : 0
  const hasConflict = legacyRaw > 0 && govRaw > 0 && legacyRaw !== govRaw
  const limit = hasConflict ? legacyRaw : govRaw > 0 ? govRaw : legacyRaw
  const warnAt = clampRatio(govBudget?.warningThreshold, 0.8)
  const critAt = Math.max(warnAt, clampRatio(govBudget?.criticalThreshold, 0.95))
  const onCritical = govBudget?.onCritical ?? "notify"
  return {
    limit,
    warnAt,
    critAt,
    onCritical,
    ...(hasConflict
      ? { conflict: { legacyTokenBudget: legacyRaw, governanceTokenBudget: govRaw } }
      : {}),
  }
}

export interface BudgetGuardStatus {
  used: number
  limit: number
  level: "ok" | "warning" | "critical"
}

export interface BudgetGuard {
  add(usage: SubAgentTokenUsage): void
  status(): BudgetGuardStatus
  /** Extend the cap (HITL approve path). Resets warned/critical flags. */
  extendLimit(extraTokens: number): void
  on(event: BudgetEventName, cb: (payload: { runId: string }) => void): () => void
}

interface InternalListeners {
  warning_crossed: Set<(p: { runId: string }) => void>
  critical_crossed: Set<(p: { runId: string }) => void>
  pause_for_review: Set<(p: { runId: string }) => void>
  entered_background_mode: Set<(p: { runId: string }) => void>
}

export function createBudgetGuard(opts: BudgetGuardOptions): BudgetGuard {
  const warnAt = clampRatio(opts.warnAt, 0.8)
  const critAt = Math.max(warnAt, clampRatio(opts.critAt, 0.95))
  let limit = Math.max(0, opts.limit)
  let used =
    typeof opts.initialUsed === "number" && Number.isFinite(opts.initialUsed)
      ? Math.max(0, opts.initialUsed)
      : 0
  let warned = limit > 0 && used / limit >= warnAt
  let critical = limit > 0 && used / limit >= critAt

  const listeners: InternalListeners = {
    warning_crossed: new Set(),
    critical_crossed: new Set(),
    pause_for_review: new Set(),
    entered_background_mode: new Set(),
  }

  const emit = (event: BudgetEventName): void => {
    for (const fn of listeners[event]) {
      try {
        fn({ runId: opts.runId })
      } catch (err) {
        console.warn(`BudgetGuard '${event}' listener threw:`, err)
      }
    }
  }

  const computeLevel = (): BudgetGuardStatus["level"] => {
    if (limit <= 0) return "ok"
    const ratio = used / limit
    if (ratio >= critAt) return "critical"
    if (ratio >= warnAt) return "warning"
    return "ok"
  }

  const handleCritical = (): void => {
    opts.notifier.notify({
      level: "critical",
      title: "Token budget critical",
      body: `Used ${used} of ${limit} tokens (${((used / limit) * 100).toFixed(1)}%)`,
      runId: opts.runId,
      teamId: "",
      dedupeKey: `budget-critical:${opts.runId}`,
    })
    emit("critical_crossed")
    switch (opts.onCritical) {
      case "notify":
        // notification already sent above
        break
      case "pause_for_review":
        emit("pause_for_review")
        break
      case "reduce_concurrency":
        opts.concurrencyCtrl?.reduceTo(1)
        opts.notifier.notify({
          level: "warn",
          title: "Concurrency reduced to 1",
          body: "Budget critical; further tasks will serialize.",
          runId: opts.runId,
          teamId: "",
          dedupeKey: `budget-reduce:${opts.runId}`,
        })
        break
      case "handoff_to_background":
        opts.concurrencyCtrl?.reduceTo(1)
        opts.modelCtrl?.downshift()
        opts.notifier.suspend()
        emit("entered_background_mode")
        break
    }
  }

  return {
    add: (usage) => {
      const delta = usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
      used += delta
      if (limit <= 0) return
      const ratio = used / limit
      // Check thresholds independently — a single add() that jumps from 0 to
      // 96% must fire warning_crossed AND critical_crossed.
      if (ratio >= warnAt && !warned) {
        warned = true
        opts.notifier.notify({
          level: "warn",
          title: "Token budget warning",
          body: `Used ${used} of ${limit} tokens (${(ratio * 100).toFixed(1)}%)`,
          runId: opts.runId,
          teamId: "",
          dedupeKey: `budget-warning:${opts.runId}`,
        })
        emit("warning_crossed")
      }
      if (ratio >= critAt && !critical) {
        critical = true
        handleCritical()
      }
    },
    status: () => ({ used, limit, level: computeLevel() }),
    extendLimit: (extraTokens) => {
      limit += extraTokens
      warned = false
      critical = false
    },
    on: (event, cb) => {
      listeners[event].add(cb)
      return () => {
        listeners[event].delete(cb)
      }
    },
  }
}
