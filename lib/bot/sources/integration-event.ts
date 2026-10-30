/**
 * Integration events become Bot events.
 *
 * This is the path a verified webhook takes. `publishIntegrationEvent` has
 * already checked the signature in Rust, deduplicated the delivery, and
 * written the durable row, so nothing here re-does any of it: the adapter
 * projects that record onto the source-neutral envelope and hands it to the
 * router.
 *
 * One projection step among several. `publishIntegrationEvent` runs it in its
 * own try and records whether it finished, so a Bot that cannot be routed
 * neither takes the other consumers down nor is silently dropped: the event
 * row stays pending and recovery re-runs this step (enqueueing is deduplicated
 * per installation and event).
 */

import { buildBotEventEnvelope, botEventId } from "@/lib/bot/events/envelope"
import { getDb } from "@/lib/db/schema"
import { sha256Hex } from "@/lib/share/hash"
import { dispatchBotEvent, type DispatchBotEventResult } from "@/lib/bot/events/dispatch"
import { externalProvenance } from "@/lib/bot/events/provenance"
import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"

function epochMs(value: string, fallback: number): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Project one integration event onto the Bot plane.
 *
 * The account id is carried as the routing key so an installation bound to one
 * GitHub account never sees another's events, which is the difference between
 * two teams sharing a Cognia install and two teams reading each other's pull
 * requests.
 */
export interface DispatchIntegrationEventToBotsOptions {
  /** Re-route to these installations only (a retry of the unready ones). */
  installationIds?: readonly string[]
  /**
   * A retry passes the epoch-ms instant the event was first projected, so an
   * old event never reaches an installation created in between. The first
   * pass omits it: the installations present then are, by definition, the
   * ones that existed when it arrived.
   */
  installedBefore?: number
}

export async function dispatchIntegrationEventToBots(
  event: IntegrationEventEnvelope,
  options: DispatchIntegrationEventToBotsOptions = {}
): Promise<DispatchBotEventResult> {
  const now = Date.now()
  const legacySourceId = `${event.pluginId}:${event.deliveryId}`
  const legacy = await getDb()
    .botEventDeliveries.where("eventId")
    .equals(botEventId("integration", legacySourceId))
    .toArray()
  // An unfinished projection may have already admitted work before the
  // identity upgrade. Keep those run/step identities for this exact account.
  const hasLegacy = legacy.some(
    (row) =>
      row.source === "integration" &&
      row.type === event.eventType &&
      row.envelope.binding?.integrationAccountId === event.accountId
  )
  const envelope = buildBotEventEnvelope({
    source: "integration",
    // Provider IDs are scoped to an integration account, not the whole plugin.
    // A slash cannot start a valid legacy plugin ID. The fixed-size digest
    // also keeps derived delivery/run IDs within the public RPC contract.
    sourceRecordId: hasLegacy
      ? legacySourceId
      : `/v2/${await sha256Hex(JSON.stringify([event.pluginId, event.integrationId, event.accountId, event.deliveryId]))}`,
    type: event.eventType,
    // Routing decides the real values. These are placeholders the router
    // overwrites per recipient.
    installationId: "",
    triggerId: "",
    occurredAt: epochMs(event.occurredAt, now),
    receivedAt: epochMs(event.receivedAt, now),
    payload: event.payload,
    binding: { integrationAccountId: event.accountId },
    provenance: externalProvenance(),
    ...(event.actor
      ? {
          actor: {
            // A webhook tells us who acted on the far side, not who they are
            // here. `principalId` stays unset, so nothing downstream mistakes
            // this for a verified Cognia identity.
            kind: "human" as const,
            id: event.actor.id,
            ...(event.actor.label ? { displayName: event.actor.label } : {}),
          },
        }
      : {}),
    ...(event.resource
      ? {
          resource: {
            kind: event.resource.kind,
            id: event.resource.id,
            ...(event.resource.url ? { url: event.resource.url } : {}),
            ...(event.resource.parent ? { scope: event.resource.parent.id } : {}),
          },
        }
      : {}),
  })

  const { installationId: _i, triggerId: _t, deliveryId: _d, ...routable } = envelope

  return dispatchBotEvent({
    envelope: routable,
    query: {
      source: "integration",
      type: event.eventType,
      integrationAccountId: event.accountId,
    },
    ...(options.installationIds ? { installationIds: options.installationIds } : {}),
    ...(options.installedBefore !== undefined ? { installedBefore: options.installedBefore } : {}),
    now,
  })
}
