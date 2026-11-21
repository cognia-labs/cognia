/**
 * The tenant level of the two-level budget (ADR-0188 D22): what the existing
 * cost-budget ceilings still allow. Every configured scope that applies to the
 * provider and the run's project counts — daily and monthly, global,
 * per-provider and per-project — and the tightest one is the limit. No
 * configured scope means no tenant limit.
 *
 * Spend is read from the durable rollup the budget gate already uses, so a
 * Router + Fusion run and an ordinary send see the same number.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import {
  evaluateCostBudget,
  projectHasCostCeiling,
  type CostBudgetSpend,
  type CostBudgetVerdict,
} from "@/lib/usage/cost-budget"
import { readCostBudgetSpend } from "@/lib/usage/cost-budget-runtime"

import { unbookedFusionSpendMicrousd } from "./unbooked-spend"

export interface TenantLimitOptions {
  /**
   * The app project (workspace) the run spends for. Its own ceiling binds the
   * run like the global one: an ordinary send in a project that spent its
   * ceiling is refused, so a ledgered run there is too.
   */
  projectId?: string | null
  /** Reads the spend, with the shares of `projectIds`; defaults to the durable rollup. */
  readSpend?: (projectIds: readonly string[]) => Promise<CostBudgetSpend>
  /** Ledgered spend the rollup does not hold yet; defaults to {@link unbookedFusionSpendMicrousd}. */
  unbookedMicrousd?: () => Promise<number>
}

export interface TenantLimit {
  /** Remaining microusd under the tightest applicable scope; null = no limit. */
  remainingMicrousd: number | null
  /** The scope that binds, for the grant dialog. */
  binding: CostBudgetVerdict | null
}

export async function tenantLimitFor(
  costBudget: AppSettings["costBudget"],
  providerId: string,
  options: TenantLimitOptions = {}
): Promise<TenantLimit> {
  if (!costBudget) return { remainingMicrousd: null, binding: null }
  const projectId = options.projectId ?? undefined
  const projectIds = projectId && projectHasCostCeiling(costBudget, projectId) ? [projectId] : []
  const probe = evaluateCostBudget(
    costBudget,
    {
      dayUsd: 0,
      monthUsd: 0,
      ...(projectIds.length > 0
        ? { byProjectDayUsd: { [projectIds[0]]: 0 }, byProjectMonthUsd: { [projectIds[0]]: 0 } }
        : {}),
    },
    providerId,
    projectId
  )
  if (probe.length === 0) return { remainingMicrousd: null, binding: null }
  const readSpend =
    options.readSpend ?? ((ids: readonly string[]) => readCostBudgetSpend(undefined, ids))
  const verdicts = evaluateCostBudget(
    costBudget,
    await readSpend(projectIds),
    providerId,
    projectId
  )
  let binding: CostBudgetVerdict | null = null
  let remaining = Number.POSITIVE_INFINITY
  for (const verdict of verdicts) {
    const left = verdict.limitUsd - verdict.usedUsd
    if (left < remaining) {
      remaining = left
      binding = verdict
    }
  }
  // Money a settled call already spent but the rollup does not show yet is not
  // free: it counts against every scope, as the tenant's holds do.
  const unbooked = await (options.unbookedMicrousd ?? unbookedFusionSpendMicrousd)()
  return {
    // Floor: the tenant never gets a fraction of a microusd it does not have.
    // The epsilon only absorbs binary float noise ($1 − $0.90 = 0.0999…98),
    // which would otherwise take a whole microusd away.
    remainingMicrousd: Math.max(0, Math.floor(remaining * 1_000_000 + 1e-6) - unbooked),
    binding,
  }
}

/**
 * The tenant limit of a run that may call several providers: the tightest
 * limit over every provider behind its roles (`providerId::modelId` ids).
 * Null when none of them has a configured scope.
 */
export async function tightestTenantLimit(
  costBudget: AppSettings["costBudget"],
  deploymentIds: readonly string[],
  options: TenantLimitOptions = {}
): Promise<number | null> {
  const providers = [
    ...new Set(
      deploymentIds
        .map((id) => id.slice(0, Math.max(0, id.indexOf("::"))))
        .filter((providerId) => providerId.length > 0)
    ),
  ]
  let tightest: number | null = null
  for (const providerId of providers) {
    const limit = await tenantLimitFor(costBudget, providerId, options)
    if (limit.remainingMicrousd === null) continue
    tightest =
      tightest === null ? limit.remainingMicrousd : Math.min(tightest, limit.remainingMicrousd)
  }
  return tightest
}
