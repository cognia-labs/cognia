/**
 * The price a member's Host-run usage is booked at (ADR-0253 §10).
 *
 * A member's turn runs on the organization's models, through the Host's
 * gateway and on the organization's key: the spend is API spend, so it is
 * priced, never left at a bare zero that every display reads as "free". The
 * order:
 *
 * 1. A figure the model's runtime reported itself stays as it is.
 * 2. The price the model's deployment gives it, which the Host hands the brain
 *    with the agent policy (`modelPricing`). Frozen as `custom`.
 * 3. The built-in catalog by model id. Frozen as `derived`.
 * 4. Neither: frozen as `unknown`, which the usage displays show as unpriced.
 *
 * The brain reads the agent policy before each member turn, so the prices here
 * are the ones in force when the turn ran.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { resolveModelPricingUsd } from "@/lib/usage/pricing"
import { effectiveCostUsdDetailed, type PricingResolver } from "@/lib/usage/session-analytics"
import type { ModelPricing } from "@cognia/provider-types/provider"
import {
  deploymentModelPricingSchema,
  type DeploymentModelPricing,
} from "@cognia/provider-types/provider-profile"

/** Per provider, the price its deployment gives each served model. */
export type PersonModelPricing = Record<string, Record<string, DeploymentModelPricing>>

let current: PersonModelPricing = {}

/**
 * The prices the Host gave, for models it also serves. An entry that is not a
 * valid price, or that prices a model the served map does not list, is
 * dropped: a bad entry costs that model its deployment price, not the policy.
 */
export function readPersonModelPricing(
  value: unknown,
  models: Record<string, string[]>
): PersonModelPricing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: PersonModelPricing = {}
  for (const [provider, prices] of Object.entries(value)) {
    if (!prices || typeof prices !== "object" || Array.isArray(prices)) continue
    const kept: Record<string, DeploymentModelPricing> = {}
    for (const [id, price] of Object.entries(prices)) {
      const parsed = deploymentModelPricingSchema.safeParse(price)
      if (parsed.success && models[provider]?.includes(id)) kept[id] = parsed.data
    }
    if (Object.keys(kept).length > 0) out[provider] = kept
  }
  return out
}

/** Keep the Host's latest prices; every read of the agent policy calls this. */
export function rememberPersonModelPricing(pricing: PersonModelPricing): void {
  current = pricing
}

export function currentPersonModelPricing(): PersonModelPricing {
  return current
}

function pricedAt(
  row: SessionUsageRow,
  pricing: Partial<ModelPricing>,
  costSource: "custom" | "derived"
): SessionUsageRow {
  // The same token arithmetic every reader uses, against this one price.
  const { cost } = effectiveCostUsdDetailed(
    { ...row, costUsd: 0, costSource: undefined, costKnown: undefined },
    () => pricing
  )
  return {
    ...row,
    costUsd: cost,
    costKnown: true,
    costSource,
    priceSnapshot: {
      ...(pricing.promptPer1M !== undefined ? { promptPer1M: pricing.promptPer1M } : {}),
      ...(pricing.completionPer1M !== undefined
        ? { completionPer1M: pricing.completionPer1M }
        : {}),
      ...(pricing.cachedInputPer1M !== undefined
        ? { cachedInputPer1M: pricing.cachedInputPer1M }
        : {}),
      ...(pricing.cacheCreationPer1M !== undefined
        ? { cacheCreationPer1M: pricing.cacheCreationPer1M }
        : {}),
      currency: "USD",
    },
  }
}

/** Price one member usage row in the order above. Pure apart from the remembered prices. */
export function priceMemberUsageRow(
  row: SessionUsageRow,
  options: { deployment?: PersonModelPricing; catalog?: PricingResolver } = {}
): SessionUsageRow {
  if (row.costKnown === true) return row
  const deployment = (options.deployment ?? current)[row.providerId ?? ""]?.[row.model ?? ""]
  if (deployment) return pricedAt(row, deployment, "custom")
  const catalog = (options.catalog ?? resolveModelPricingUsd)(row.providerId, row.model)
  if (catalog && (catalog.promptPer1M !== undefined || catalog.completionPer1M !== undefined))
    return pricedAt(row, catalog, "derived")
  return { ...row, costUsd: 0, costKnown: false, costSource: "unknown" }
}
