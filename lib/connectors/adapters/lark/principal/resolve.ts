/**
 * Lark principal resolution, contributed through `../contribution.ts` to
 * `lib/connectors/principal/resolve.ts` (plan 2026-07-24 Phase 1, §3.2).
 *
 * Maps the verified envelope's `tenantKey + appId + openId` to a registered
 * `FeishuPrincipalRow` and its Cognia account. FAIL CLOSED: whenever the
 * `larkPrincipalRegistry` flag is on and the sender cannot be positively
 * resolved to the currently active account, the event must not create an
 * agent turn and must never fall back to the default local account — callers
 * route every non-`resolved` outcome through `handleUnresolvedPrincipal`.
 */

import type { FeishuPrincipalRow } from "@/lib/db/connector-types"
import {
  getFeishuPrincipal,
  getFeishuTenant,
  rebindFeishuPrincipal,
  touchFeishuPrincipalVerification,
} from "@/lib/db/feishu-principals"
import { isLarkPrincipalRegistryEnabled } from "@/lib/connectors/feature-flags"
import {
  getActiveRuntimeAccountId,
  hashOpenId,
  type PrincipalResolution,
  type ResolvePrincipalInput,
} from "@/lib/connectors/principal/resolve"

// Throttle lastVerifiedAt writes to once per principal per hour.
const VERIFICATION_TOUCH_INTERVAL_MS = 60 * 60 * 1000

/**
 * Record the sender's `union_id` on a principal that has none yet.
 *
 * Principals seeded from the contact directory or approved before the parser
 * read `union_id` carry only an `open_id`, which can never meet a login's
 * Feishu identity. The first verified event that names the union id fills it
 * in. A principal that already holds a DIFFERENT union id is left alone: one
 * `open_id` maps to one person inside an app, so a mismatch is evidence of a
 * fault, not something to overwrite. Best-effort: never blocks resolution.
 */
async function backfillUnionId(
  principal: FeishuPrincipalRow,
  unionId: string | undefined
): Promise<FeishuPrincipalRow> {
  if (!unionId || principal.unionId) return principal
  return rebindFeishuPrincipal(principal.id, { unionId }).catch(() => principal)
}

export async function resolveLarkPrincipal(
  input: ResolvePrincipalInput
): Promise<PrincipalResolution> {
  if (!isLarkPrincipalRegistryEnabled(input.adapterRow)) return { status: "legacy" }

  const openId = input.remoteUserId
  const openIdHash = await hashOpenId(openId)
  const tenantKey = input.identityScope?.tenantKey
  // The envelope header omits app_id on some event generations; the adapter's
  // whoami probe knows which app THIS adapter is, so it is a safe fallback.
  // tenantKey has no such fallback: guessing it from whoami would merge
  // cross-tenant (external-group) senders into the home tenant — refuse.
  const appId = input.identityScope?.appId ?? input.adapterRow.lastWhoamiResult?.appId
  const unionId = input.identityScope?.unionId
  const unbound = (): PrincipalResolution => ({
    status: "unbound",
    tenantKey,
    appId,
    ...(unionId ? { unionId } : {}),
    openIdHash,
  })
  if (!tenantKey || !appId) return unbound()

  const tenant = await getFeishuTenant(tenantKey, appId)
  if (!tenant) return unbound()
  if (tenant.status === "disabled") return { status: "tenant_disabled", tenant }

  const fetched = await getFeishuPrincipal(tenantKey, appId, openId)
  if (!fetched) return unbound()
  if (fetched.status !== "active") return { status: "principal_disabled", principal: fetched }

  const activeAccountId = input.activeAccountId ?? getActiveRuntimeAccountId()
  if (fetched.cogniaAccountId !== activeAccountId || tenant.cogniaAccountId !== activeAccountId) {
    return {
      status: "cross_account",
      declaredAccountId:
        fetched.cogniaAccountId !== activeAccountId
          ? fetched.cogniaAccountId
          : tenant.cogniaAccountId,
    }
  }

  const now = Date.now()
  if (!fetched.lastVerifiedAt || now - fetched.lastVerifiedAt > VERIFICATION_TOUCH_INTERVAL_MS) {
    // Best-effort freshness marker; never blocks resolution.
    await touchFeishuPrincipalVerification(fetched.id, now).catch(() => undefined)
  }

  // Only a principal that positively resolved learns its union id: inbound
  // traffic never rewrites a disabled or cross-account row.
  const principal = await backfillUnionId(fetched, unionId)
  return { status: "resolved", principal, tenant, accountId: activeAccountId }
}
