"use client"

/**
 * The renderer's lane for background results (ADR-0249).
 *
 * The delivery path itself is `lib/background-tasks/result-delivery.ts`: the
 * one queue, the wake limiter, the supervisor claim and the framing. This
 * file is the window's side of it. The chat controller registers its send,
 * and a conversation is reachable when it is open here (a held session,
 * ADR-0204, counts as open) and idle when its turn has settled. Job ends are
 * claimed under this browser profile's consumer id.
 *
 * Mid-turn injection is impossible (the sidecar restarts a session on a
 * same-session send while streaming), so a streaming parent keeps its
 * results until its turn settles, and a closed one until it next opens idle.
 */

import {
  registerBackgroundDeliveryLane,
  type BackgroundReplaySend,
} from "@/lib/background-tasks/result-delivery"
import { isSessionOpen, sessionStatusOf } from "./steer-runtime"

export {
  __resetBackgroundResultRuntimeForTesting,
  __setBackgroundJobDeliveryDepsForTesting,
  attemptBackgroundResultDelivery,
  maybeDrainBackgroundResults,
  onBackgroundJobSettled,
  onBackgroundRunSettled,
  registerBackgroundResultNotifyStrings,
  type BackgroundJobDeliveryDeps,
  type BackgroundReplaySend,
  type BackgroundResultNotifyStrings,
} from "@/lib/background-tasks/result-delivery"

const CONSUMER_STORAGE_KEY = "cognia.background-job-consumer"
let consumerId: string | undefined

/**
 * This browser profile's consumer id for delivery claims. Stable across
 * reloads and shared by its windows (which already share one outbox), so a
 * reload retries its own claim; another device has another id.
 */
function backgroundJobConsumerId(): string {
  if (consumerId) return consumerId
  try {
    const stored = window.localStorage.getItem(CONSUMER_STORAGE_KEY)
    if (stored) return (consumerId = stored)
    const created = `renderer:${crypto.randomUUID()}`
    window.localStorage.setItem(CONSUMER_STORAGE_KEY, created)
    return (consumerId = created)
  } catch {
    return (consumerId ??= `renderer:${crypto.randomUUID()}`)
  }
}

/** Register the chat controller's send as this window's lane (returns an unregister). */
export function registerBackgroundReplaySend(send: BackgroundReplaySend): () => void {
  return registerBackgroundDeliveryLane({
    isReachable: (sessionId) => isSessionOpen(sessionId),
    isIdle: (sessionId) => sessionStatusOf(sessionId) === "idle",
    send,
    consumerId: backgroundJobConsumerId,
  })
}
