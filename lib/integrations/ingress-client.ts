import { collectPages } from "@/lib/tauri/companion-paging"
import { createDiagnostic } from "@cognia/diagnostics"
import { detectPlatform } from "@/lib/platform/detect"
import { transport } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import { sweepExpiredSyncLeases } from "@/lib/db/sync-leases"
import { withSyncLease, type SyncLease } from "@/lib/external-services/sync-lease"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import {
  getIntegrationIngressEndpoint,
  removeIntegrationAccount,
  removeIntegrationSubscription,
} from "@/lib/db/integrations"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { removeSession } from "@/lib/plugin/auth/auth-provider-registry"
import { publishIntegrationEvent } from "./events"
import { getIntegrationEventNormalizer, getRegisteredIntegration } from "./registry"
import type {
  IntegrationIngressDeadLetter,
  IntegrationIngressDeadLetterDetail,
  IntegrationIngressVerification,
  IntegrationIngressEndpoint,
  IntegrationVerifiedDelivery,
} from "@/types/plugin/plugin-integration"

interface IngressRouteInput {
  routeId: string
  pluginId: string
  integrationId: string
  accountId: string
  subscriptionId?: string
  path: string
  verification: IntegrationIngressVerification & { secretHandle: string }
  deliveryIdHeader?: string
  eventTypeHeader?: string
  enabled: boolean
}

type IngressDeliveryStage = "startup" | "route" | "normalize" | "publish" | "acknowledge"

function reportIngressFailure(
  delivery: Pick<IntegrationVerifiedDelivery, "routeId" | "deliveryId">,
  stage: IngressDeliveryStage,
  error: unknown
): void {
  dispatchDiagnostic(
    createDiagnostic("serverError", {
      source: "connector",
      message: error instanceof Error ? error.message : String(error),
      meta: {
        extra: {
          stage,
          routeId: delivery.routeId,
          deliveryId: delivery.deliveryId,
        },
      },
    }),
    { kind: "background" }
  )
}

function supportsIntegrationExecution(): boolean {
  const platform = detectPlatform()
  return platform === "tauri" || platform === "headless"
}

/** Ordinary disable/reload keeps the encrypted spool; terminal access removal purges it. */
export async function unregisterIngress(
  endpoint: Pick<IntegrationIngressEndpoint, "routeId">,
  options: { purge?: boolean } = {}
): Promise<void> {
  if (!supportsIntegrationExecution()) return
  await transport.call("integration_ingress_unregister", {
    routeId: endpoint.routeId,
    ...(options.purge ? { purge: true } : {}),
  })
}

/** Resolve the local/tunnel URL for a registered Integration ingress route. */
export async function getIntegrationIngressPublicUrl(routeId: string): Promise<string | undefined> {
  if (!supportsIntegrationExecution()) return undefined
  return transport
    .call<string | null>("integration_ingress_get_url", { routeId })
    .then((value) => value ?? undefined)
}

export async function syncIntegrationIngressRoutes(): Promise<number> {
  if (!supportsIntegrationExecution()) return 0
  const db = getDb()
  const accounts = await db.integrationAccounts.toArray()
  let registered = 0
  for (const account of accounts) {
    if (!account.enabled) continue
    const endpoint =
      account.ingressEndpoint ?? (await getIntegrationIngressEndpoint(account.pluginId, account.id))
    if (!endpoint) continue
    const integration = getRegisteredIntegration(account.pluginId, account.integrationId)
    const ingress = integration?.definition.ingress
    if (!ingress) continue
    const input: IngressRouteInput = {
      routeId: endpoint.routeId,
      pluginId: account.pluginId,
      integrationId: account.integrationId,
      accountId: account.id,
      path: endpoint.routeId,
      verification: { ...ingress.verification, secretHandle: endpoint.secretHandle },
      deliveryIdHeader: ingress.deliveryIdHeader,
      eventTypeHeader: ingress.eventTypeHeader,
      enabled: endpoint.enabled && account.enabled,
    }
    await transport.call("integration_ingress_register", { input })
    registered += 1
  }
  return registered
}

export async function drainIntegrationIngress(): Promise<number> {
  if (!supportsIntegrationExecution()) return 0
  await sweepExpiredSyncLeases()
  const deliveries = await transport.call<IntegrationVerifiedDelivery[]>(
    "integration_ingress_poll",
    {
      limit: 100,
    }
  )
  const accounts = await getDb().integrationAccounts.toArray()
  const byRoute = new Map(
    accounts
      .filter((account) => account.ingressEndpoint)
      .map((account) => [account.ingressEndpoint!.routeId, account])
  )
  let acknowledged = 0
  const processDelivery = async (delivery: IntegrationVerifiedDelivery, lease?: SyncLease) => {
    const subscription = byRoute.get(delivery.routeId)
    let stage: IngressDeliveryStage = "route"
    try {
      if (!subscription || !subscription.enabled || !subscription.ingressEndpoint?.enabled)
        throw new Error(`Integration ingress route "${delivery.routeId}" is stale`)
      const normalizer = getIntegrationEventNormalizer(
        subscription.pluginId,
        subscription.integrationId
      )
      if (!normalizer) throw new Error("Integration ingress normalizer is unavailable")
      stage = "normalize"
      const normalized = await normalizer(delivery, {
        pluginId: subscription.pluginId,
        integrationId: subscription.integrationId,
        accountId: subscription.id,
      })
      stage = "publish"
      if (lease) await lease.commit([], async () => undefined)
      for (const event of Array.isArray(normalized) ? normalized : [normalized]) {
        if (lease) await publishIntegrationEvent(subscription.pluginId, event, { syncLease: lease })
        else await publishIntegrationEvent(subscription.pluginId, event)
      }
      stage = "acknowledge"
      if (lease) await lease.commit([], async () => undefined)
      await transport.call("integration_ingress_ack", {
        routeId: delivery.routeId,
        deliveryId: delivery.deliveryId,
      })
      acknowledged += 1
    } catch (error) {
      // A stale drainer must not ACK or NACK a new owner's delivery.
      if (lease?.signal.aborted) throw error
      if (lease) await lease.commit([], async () => undefined)
      reportIngressFailure(delivery, stage, error)
      await transport.call("integration_ingress_nack", {
        routeId: delivery.routeId,
        deliveryId: delivery.deliveryId,
      })
    }
  }
  const byConnection = new Map<string, IntegrationVerifiedDelivery[]>()
  for (const delivery of deliveries) {
    const ref = byRoute.get(delivery.routeId)?.connectionId
    if (!ref) await processDelivery(delivery)
    else byConnection.set(ref, [...(byConnection.get(ref) ?? []), delivery])
  }
  for (const [ref, batch] of byConnection) {
    await withSyncLease(ref, "ingress", async (lease) => {
      for (const delivery of batch) await processDelivery(delivery, lease)
    })
  }
  return acknowledged
}

export async function listIntegrationIngressDeadletters(
  pluginId: string,
  accountId: string
): Promise<IntegrationIngressDeadLetter[]> {
  if (!supportsIntegrationExecution()) return []
  const account = (await getDb().integrationAccounts.toArray()).find(
    (candidate) => candidate.pluginId === pluginId && candidate.id === accountId
  )
  const routeId = account?.ingressEndpoint?.routeId
  if (!routeId) return []
  const rows = await collectPages<IntegrationIngressDeadLetter>(
    (pageToken) => transport.call("integration_ingress_deadletters", { pageSize: 500, pageToken }),
    { maxItems: 500 }
  )
  return rows.filter((row) => row.routeId === routeId)
}

export async function requeueIntegrationIngressDeadletter(
  pluginId: string,
  accountId: string,
  routeId: string,
  deliveryId: string
): Promise<boolean> {
  if (!supportsIntegrationExecution()) return false
  const account = (await getDb().integrationAccounts.toArray()).find(
    (candidate) => candidate.pluginId === pluginId && candidate.id === accountId
  )
  if (account?.ingressEndpoint?.routeId !== routeId) {
    throw new Error(`Integration ingress route "${routeId}" does not belong to account`)
  }
  const requeued = await transport.call<boolean>("integration_ingress_requeue", {
    routeId,
    deliveryId,
  })
  if (requeued) await drainIntegrationIngress()
  return requeued
}

export async function getIntegrationIngressDeadletter(
  pluginId: string,
  accountId: string,
  routeId: string,
  deliveryId: string
): Promise<IntegrationIngressDeadLetterDetail | undefined> {
  if (!supportsIntegrationExecution()) return undefined
  const account = (await getDb().integrationAccounts.toArray()).find(
    (candidate) => candidate.pluginId === pluginId && candidate.id === accountId
  )
  if (account?.ingressEndpoint?.routeId !== routeId) {
    throw new Error(`Integration ingress route "${routeId}" does not belong to account`)
  }
  return transport.call<IntegrationIngressDeadLetterDetail | undefined>(
    "integration_ingress_deadletter",
    { routeId, deliveryId }
  )
}

/** Backstop for a missed wake: a nacked delivery waiting in `retry_wait`, or a
 * wake raised while the webview was reloading. */
export const INGRESS_DRAIN_INTERVAL_MS = 30_000

/**
 * Install the ingress runtime: the wake subscription first, then the catch-up
 * pass, then a periodic drain.
 *
 * Order and error handling are both load-bearing:
 *
 *  - Subscribing after the initial drain left a window where an accepted
 *    delivery raised its wake signal into a subscription that did not exist
 *    yet, so it sat in the spool until some later delivery happened to drain
 *    it.
 *  - Letting the catch-up pass throw took the subscription with it. A headless
 *    brain rejected `integration_ingress_poll` on every boot (its output
 *    contract declared an object where the arm returns a `Vec<SpoolDelivery>`,
 *    so the empty spool's `[]` was a 500), this function rejected, and
 *    `startIntegrationRuntime` caught it into a no-op dispose — leaving
 *    Integration ingress dead for the life of the process on the one host that
 *    has no UI to notice.
 *  - The wake alone is not enough: a nacked delivery sits in the spool's
 *    `retry_wait` with nothing to wake it once its backoff passes, so a
 *    periodic drain picks it up.
 *
 * The catch-up failure is still reported; it just no longer decides whether
 * ingress runs at all.
 */
export async function installIntegrationIngressRuntime(): Promise<() => void> {
  if (!supportsIntegrationExecution()) return () => undefined
  const drain = (deliveryId: string) => {
    void drainIntegrationIngress().catch((error) =>
      reportIngressFailure({ routeId: "runtime", deliveryId }, "route", error)
    )
  }
  const unsubscribe = transport.subscribe("integration:delivery-available", () =>
    drain("subscription")
  )
  try {
    await syncIntegrationIngressRoutes()
    await drainIntegrationIngress()
  } catch (error) {
    reportIngressFailure({ routeId: "runtime", deliveryId: "startup" }, "startup", error)
  }
  const timer = globalThis.setInterval(() => drain("interval"), INGRESS_DRAIN_INTERVAL_MS)
  return () => {
    globalThis.clearInterval(timer)
    unsubscribe()
  }
}

export async function deleteIntegrationSubscription(
  pluginId: string,
  subscriptionId: string
): Promise<void> {
  const subscription = await getDb().integrationSubscriptions.get(subscriptionId)
  if (!subscription || subscription.pluginId !== pluginId) return
  await removeIntegrationSubscription(pluginId, subscriptionId)
}

export async function deleteIntegrationAccount(pluginId: string, accountId: string): Promise<void> {
  const account = await getDb().integrationAccounts.get(accountId)
  if (!account || account.pluginId !== pluginId) return
  const endpoint =
    account.ingressEndpoint ?? (await getIntegrationIngressEndpoint(pluginId, accountId))
  const subscriptions = await getDb()
    .integrationSubscriptions.where("accountId")
    .equals(accountId)
    .toArray()
  for (const subscription of subscriptions) {
    if (subscription.pluginId === pluginId) {
      await deleteIntegrationSubscription(pluginId, subscription.id)
    }
  }
  if (endpoint) await unregisterIngress(endpoint, { purge: true })
  if (endpoint) {
    await createKeyringStore("integration-ingress").delete(endpoint.secretHandle)
  }
  await removeIntegrationAccount(pluginId, accountId)
  const sharedCredential = await getDb()
    .integrationAccounts.filter(
      (candidate) =>
        candidate.providerId === account.providerId &&
        candidate.authSessionId === account.authSessionId
    )
    .first()
  if (!account.connectionId && !sharedCredential) {
    await removeSession(account.providerId, account.authSessionId)
  }
}
