/**
 * Shared native gateway event sink for desktop and headless brains.
 * One physical listener per transport prevents duplicate usage writes when
 * several runtime owners temporarily overlap during mounting or teardown.
 */
import { appendGatewayRequestLog } from "@/lib/db/gateway-request-log"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  GATEWAY_REQUEST_LOG_EVENT,
  GATEWAY_REQUEST_OUTCOME_EVENT,
  type GatewayAccountScope,
  type GatewayRequestLogRow,
  type GatewayRequestOutcome,
} from "@/types/gateway"
import { forwardGatewayOutcome } from "./telemetry-forwarder"

type EventTransport = Pick<Transport, "subscribe">

export interface GatewayTelemetryAuthority {
  acceptsEvent: (event: GatewayAccountScope) => boolean | Promise<boolean>
  /** Rechecked after an asynchronous authority lookup, immediately before IO. */
  isCurrent?: () => boolean
}

interface Owner extends GatewayTelemetryAuthority {
  active: boolean
}

interface Subscription {
  owners: Set<Owner>
  stop: () => void
}

const subscriptions = new WeakMap<EventTransport, Subscription>()

function current(owner: Owner): boolean {
  try {
    return owner.active && (owner.isCurrent?.() ?? true)
  } catch {
    return false
  }
}

function deliver(owners: Set<Owner>, event: GatewayAccountScope, write: () => void): void {
  let delivered = false
  const commit = (owner: Owner, accepted: boolean) => {
    if (!accepted || delivered || !current(owner) || !owners.has(owner)) return
    delivered = true
    try {
      write()
    } catch {
      // A malformed native event or unavailable telemetry store cannot break
      // the inference path or another event consumer.
    }
  }
  for (const owner of owners) {
    if (!current(owner)) continue
    try {
      const accepted = owner.acceptsEvent(event)
      if (typeof accepted === "boolean") commit(owner, accepted)
      else void accepted.then((value) => commit(owner, value)).catch(() => {})
    } catch {
      // Authority lookup failure is a refusal, never permission to write.
    }
  }
}

/** Install exactly one shared gateway outcome/log subscription per transport. */
export function installGatewayTelemetrySubscription(
  transport: EventTransport,
  authority: GatewayTelemetryAuthority
): () => void {
  let subscription = subscriptions.get(transport)
  if (!subscription) {
    const owners = new Set<Owner>()
    const stopOutcome = transport.subscribe<GatewayRequestOutcome>(
      GATEWAY_REQUEST_OUTCOME_EVENT,
      (event) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) return
        deliver(owners, event, () => forwardGatewayOutcome(event))
      }
    )
    let stopLog: (() => void) | undefined
    try {
      stopLog = transport.subscribe<GatewayRequestLogRow>(GATEWAY_REQUEST_LOG_EVENT, (row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return
        deliver(owners, row, () => {
          void appendGatewayRequestLog(row).catch(() => {})
        })
      })
    } catch (error) {
      stopOutcome()
      throw error
    }
    subscription = {
      owners,
      stop: () => {
        stopLog?.()
        stopOutcome()
      },
    }
    subscriptions.set(transport, subscription)
  }
  const owner: Owner = { ...authority, active: true }
  subscription.owners.add(owner)
  return () => {
    if (!owner.active) return
    owner.active = false
    subscription.owners.delete(owner)
    if (subscription.owners.size === 0) {
      subscriptions.delete(transport)
      subscription.stop()
    }
  }
}
