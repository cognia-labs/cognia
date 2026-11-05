/**
 * Lark inbound principal resolution, contributed through `../contribution.ts`
 * to the connector bus's step 2.5 (plan 2026-07-24).
 *
 * The bus asks one question — who sent this — and this answers it, healing
 * the two cases the first event can heal before failing closed: an adapter
 * whose registry was never seeded, and the signed-in owner writing to another
 * of this profile's bots.
 */

import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import {
  readIdentityScope,
  type PrincipalResolution,
  type ResolvePrincipalInput,
} from "@/lib/connectors/principal/resolve"
import type { ConnectorVendorInboundPrincipalInput } from "@/lib/connectors/vendor-contribution"
import { bootstrapFeishuRegistry } from "./bootstrap"
import { resolveLarkPrincipal } from "./resolve"
import { isForgeResistantTransport, selfBindSignedInOwner } from "./self-bind"

export async function resolveLarkInboundPrincipal(
  input: ConnectorVendorInboundPrincipalInput
): Promise<PrincipalResolution> {
  const { event, adapterRow, transportModes } = input
  // A sender's union_id is recorded (bind requests, principal back-fill) and
  // matched against an owner confirmation, so it is only believed when the
  // transport authenticates more than a static token. On a token-only
  // webhook one forged event could otherwise plant it permanently.
  const stampedScope = readIdentityScope(event.channelData)
  const identityScope =
    stampedScope?.unionId &&
    !(await isForgeResistantTransport(event.adapterId, transportModes, connectorsKeyringGet))
      ? { tenantKey: stampedScope.tenantKey, appId: stampedScope.appId }
      : stampedScope
  const resolveInput: ResolvePrincipalInput = {
    platform: event.platform,
    adapterRow,
    remoteUserId: event.sender.remoteUserId,
    identityScope,
    activeAccountId: input.activeAccountId,
  }
  let resolution = await resolveLarkPrincipal(resolveInput)
  // Self-heal the one ordering hazard in registry seeding: the adapter's
  // tenant_key is only learnable from inbound traffic, so an adapter that has
  // never received an event boots with no tenant scope and the start-up
  // bootstrap can only skip. The first event both reveals the tenant and
  // arrives BEFORE anything seeded the registry, which would park an entire
  // existing workspace on the very message that could have seeded it. The
  // bootstrap is idempotent and no-ops once the tenant row exists.
  if (resolution.status === "unbound") {
    const seeded = await bootstrapFeishuRegistry({
      adapterId: event.adapterId,
      adapterRow,
    }).catch(() => ({ status: "skipped" as const, reason: "flag_off" as const }))
    if (seeded.status === "seeded") resolution = await resolveLarkPrincipal(resolveInput)
  }
  // The signed-in owner, once they confirmed a bot principal as themselves,
  // is not a stranger to this profile's other bots in the tenant: admit them
  // (or re-admit a principal a sign-out unlinked) instead of handing them
  // another bind code. Everyone else stays as resolved.
  const selfBindable =
    resolution.status === "unbound" ||
    (resolution.status === "principal_disabled" &&
      resolution.principal.status === "unlinked" &&
      resolution.principal.selfBoundAt !== undefined)
  if (selfBindable) {
    const selfBound = await selfBindSignedInOwner({
      adapterId: event.adapterId,
      transportModes,
      openId: event.sender.remoteUserId,
      identityScope,
      fallbackAppId: adapterRow.lastWhoamiResult?.appId,
      localAccountId: input.activeAccountId,
      conversationKey: event.conversationKey,
    }).catch(() => ({ status: "skipped" as const }))
    if (selfBound.status === "bound") resolution = await resolveLarkPrincipal(resolveInput)
  }
  return resolution
}
