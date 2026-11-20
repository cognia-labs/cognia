/**
 * The Bot delivery queue.
 *
 * One row per (event, installation). This is the only thing the Bot plane
 * persists about an event, because every source already persists, verifies and
 * deduplicates its own arrival. What is genuinely per-recipient is the
 * DELIVERY: its lease, its attempts, its dead letter, and the run it started.
 *
 * The retry mathematics are `lib/queue/retry-policy.ts`, the same ones the
 * mobile outbound queue uses. Two backoff curves for two queues is how one of
 * them quietly stops matching the timeouts it was tuned against.
 */

import { getDb } from "@/lib/db/schema"
import { isBotTriggerArmed } from "./bot-installations"
import { deleteBotRunStepsForRuns } from "./bot-run-steps"
import { recordTombstones } from "./tombstones"
import type { BotDeliveryStatus, BotEventDeliveryRow, BotEventWait } from "@/lib/db/bot-types"
import type { PluginBotRetryPolicy } from "@/types/plugin/plugin-bot"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import { decideNextAttempt } from "@/lib/queue/retry-policy"

/** How long a runner may hold a delivery before another may take it. */
export const BOT_DELIVERY_LEASE_MS = 2 * 60_000

/** Settled rows are pruned after this long. Mirrors the governance policy. */
export const BOT_DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60_000

const TERMINAL_STATUSES = new Set<BotDeliveryStatus>(["succeeded", "deadletter", "dismissed"])

/** Is this delivery finished, for better or worse? */
export function isTerminalBotDelivery(status: BotDeliveryStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * What a recovered attempt records as its failure.
 *
 * Deliberately worded to miss every pattern in `NON_RETRYABLE_PATTERNS`, so an
 * interrupted attempt backs off and retries rather than dead-lettering on the
 * first crash.
 */
export const BOT_DELIVERY_INTERRUPTED_ERROR = "bot run interrupted: the host stopped mid-attempt"

/**
 * Was this row mid-attempt when whatever was running it disappeared?
 *
 * `leased` and `running` are the same answer. They differ only in which half of
 * the attempt the runner had reached, and neither half survives the process
 * that was executing it. Treating `running` as a state only its own runner can
 * leave is what used to strand a delivery forever: nothing listed it, nothing
 * pruned it, and `countActiveBotDeliveriesForKey` counted it as live, so its
 * concurrency key was retired along with it.
 */
/**
 * May this process act on the row at all?
 *
 * A mirrored row belongs to the Host that synced it. Fencing here rather than
 * in the runner is deliberate: `listDueBotDeliveries`, `claimBotDelivery` and
 * `countActiveBotDeliveriesForKey` all flow through this module, and a fence in
 * only one of them leaves the other two able to act on a foreign row. This is
 * the same choke point `isLocallyDispatchable` occupies for the outbound queue.
 */
function isLocallyOwned(row: BotEventDeliveryRow): boolean {
  return row.syncedFromHost !== true
}

function isMidAttempt(status: BotDeliveryStatus): boolean {
  return status === "leased" || status === "running"
}

function isAbandonedAttempt(row: BotEventDeliveryRow, now: number): boolean {
  if (!isMidAttempt(row.status)) return false
  return (row.leaseExpiresAt ?? 0) <= now
}

function holdsConcurrency(row: BotEventDeliveryRow, now: number): boolean {
  return (
    isLocallyOwned(row) &&
    ((row.status === "parked" && row.holdConcurrencyWhileWaiting !== false) ||
      (isMidAttempt(row.status) && !isAbandonedAttempt(row, now)))
  )
}

/**
 * The row an abandoned attempt becomes: one attempt spent, backed off, and
 * dead-lettered once the budget is gone.
 *
 * The charge is the whole point. Without it a delivery that kills whatever runs
 * it is re-claimed forever, because the attempt it was supposed to spend is
 * never recorded and the lease expiry alone makes it due again.
 */
function chargeAbandonedAttempt(
  row: BotEventDeliveryRow,
  now: number,
  random?: () => number
): BotEventDeliveryRow {
  const decision = decideNextAttempt({
    attempts: row.attempts,
    error: new Error(BOT_DELIVERY_INTERRUPTED_ERROR),
    nowMs: now,
    random,
    ...(row.retry ? { policy: row.retry } : {}),
  })
  const deadlettered = decision.status === "deadlettered"
  const next: BotEventDeliveryRow = {
    ...row,
    status: deadlettered ? "deadletter" : "pending",
    attempts: decision.attempts,
    nextAttemptAt: decision.nextAttemptAt,
    lastError: decision.lastError,
    updatedAt: now,
    ...(deadlettered ? { settledAt: now } : {}),
  }
  delete next.leaseOwner
  delete next.leaseExpiresAt
  return next
}

/**
 * Settle what a dead-lettered delivery's run owes, inside the recovery's
 * transaction, and return the row to store.
 *
 * Required of every recovery caller, and supplied by the Bot runtime, which
 * owns runs: a delivery and its run are one outcome, and dead-lettering the
 * delivery alone is how a run used to read `running` for the rest of its
 * life. It runs inside a transaction over `botEventDeliveries`,
 * `botInstallations`, `executionRuns`, `executionRunEvents` and
 * `notificationProjectionWork`, and must await nothing else.
 */
export type BotDeadletterSettler = (
  row: BotEventDeliveryRow,
  now: number
) => Promise<BotEventDeliveryRow>

/** The stores a recovery transaction spans, so its settler can write the run. */
function recoveryStores(db: ReturnType<typeof getDb>) {
  return [
    db.botEventDeliveries,
    db.botInstallations,
    db.executionRuns,
    db.executionRunEvents,
    db.notificationProjectionWork,
  ]
}

async function settledRecovery(
  next: BotEventDeliveryRow,
  now: number,
  settle: BotDeadletterSettler
): Promise<BotEventDeliveryRow> {
  return next.status === "deadletter" ? settle(next, now) : next
}

/**
 * The arrival-dedup key for one delivery.
 *
 * Scoped to the installation, not the event: the same event legitimately fans
 * out to several installations, and a global key would let the first recipient
 * swallow everyone else's copy.
 */
export function botDeliveryDedupKey(
  installationId: string,
  eventId: string,
  triggerId: string
): string {
  return `v2:${JSON.stringify([installationId, triggerId, eventId])}`
}

/**
 * Why intake refused a delivery. `disabled` and `disarmed` are the
 * {@link EnqueueBotDeliveryInput.armedTrigger} admission: the installation or
 * its trigger was switched off after the producer decided to fire.
 */
export type BotIntakeRefusal =
  "installation" | "conversation" | "cancelled" | "disabled" | "disarmed"

export class BotIntakePausedError extends Error {
  readonly code = "bot_intake_paused"
  constructor(readonly reason: BotIntakeRefusal = "installation") {
    super("Bot intake is paused")
  }
}

export interface EnqueueBotDeliveryInput {
  envelope: BotEventEnvelopeV1
  /** Synchronous in-memory readiness fence immediately before a new insert. */
  assertReady?: () => undefined
  /**
   * Admit only while the installation is enabled and this trigger armed, read
   * in the transaction that inserts the row.
   *
   * Event and timed producers pass the trigger they routed to. They decide to
   * fire from a read taken before this one, so a disarm or a disable that
   * returned in between would otherwise still let one delivery in. A manual
   * run leaves it out: it reads and enqueues in one transaction of its own,
   * and pressing Run is the arming for that once.
   */
  armedTrigger?: { id: string; enabledByDefault?: boolean }
  /** Hold the delivery until this instant, for a debounced trigger. */
  notBefore?: number
  concurrencyKey?: string
  holdConcurrencyWhileWaiting?: boolean
  /** The trigger's declared retry policy, snapshotted onto the row. */
  retry?: PluginBotRetryPolicy
  coalesce?: "latest" | "all"
  /** The delivery a Retry mints this one to succeed. See `BotEventDeliveryRow.retryOf`. */
  retryOf?: string
  now?: number
}

function coalesceGroup(envelope: BotEventEnvelopeV1, concurrencyKey?: string): string {
  const source = [
    concurrencyKey,
    envelope.source,
    envelope.binding?.integrationAccountId,
    envelope.binding?.adapterId,
  ]
  if (envelope.resource)
    return JSON.stringify([
      ...source,
      "resource",
      envelope.resource.kind,
      envelope.resource.scope,
      envelope.resource.id,
    ])
  if (envelope.binding?.conversationKey)
    return JSON.stringify([...source, "conversation", envelope.binding.conversationKey])
  if (concurrencyKey) return JSON.stringify([...source, "concurrency"])
  // Without resource identity, never discard an unrelated event.
  return JSON.stringify([...source, "event", envelope.eventId])
}

/**
 * Record a delivery, or return the one that already exists.
 *
 * Enqueue-once by unique index, not by read-then-write: two runners fanning
 * out the same at-least-once webhook race here constantly, and the read alone
 * cannot stop the second row from being written.
 */
export async function enqueueBotDelivery(
  input: EnqueueBotDeliveryInput
): Promise<BotEventDeliveryRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const envelope = input.envelope
  const dedupKey = botDeliveryDedupKey(
    envelope.installationId,
    envelope.eventId,
    envelope.triggerId
  )

  const row: BotEventDeliveryRow = {
    id: envelope.deliveryId,
    eventId: envelope.eventId,
    installationId: envelope.installationId,
    triggerId: envelope.triggerId,
    source: envelope.source,
    type: envelope.type,
    dedupKey,
    status: "pending",
    attempts: 0,
    nextAttemptAt: input.notBefore ?? now,
    envelope,
    receivedAt: now,
    updatedAt: now,
    ...(input.notBefore ? { notBefore: input.notBefore } : {}),
    ...(input.concurrencyKey ? { concurrencyKey: input.concurrencyKey } : {}),
    ...(input.holdConcurrencyWhileWaiting !== undefined
      ? { holdConcurrencyWhileWaiting: input.holdConcurrencyWhileWaiting }
      : {}),
    ...(envelope.correlation ? { correlation: envelope.correlation } : {}),
    ...(input.retry ? { retry: input.retry } : {}),
    ...(input.coalesce
      ? { coalesce: input.coalesce, coalesceKey: coalesceGroup(envelope, input.concurrencyKey) }
      : {}),
    ...(input.retryOf ? { retryOf: input.retryOf } : {}),
  }

  return db.transaction(
    "rw",
    db.botEventDeliveries,
    db.botInstallations,
    db.conversationOverrides,
    async () => {
      const existing = await db.botEventDeliveries.where("dedupKey").equals(dedupKey).first()
      if (existing) return existing
      const conversation = envelope.binding?.conversationKey
        ? await db.conversationOverrides
            .where("conversationKey")
            .equals(envelope.binding.conversationKey)
            .first()
        : undefined
      const installation = await db.botInstallations.get(row.installationId)
      if (installation?.paused) throw new BotIntakePausedError("installation")
      if (input.armedTrigger) {
        if (installation?.status !== "enabled") throw new BotIntakePausedError("disabled")
        if (!isBotTriggerArmed(installation, input.armedTrigger))
          throw new BotIntakePausedError("disarmed")
      }
      if (conversation?.automationPaused) throw new BotIntakePausedError("conversation")
      if (
        conversation?.automationCancelledBefore !== undefined &&
        (row.envelope.receivedAt ?? row.receivedAt) <= conversation.automationCancelledBefore
      )
        throw new BotIntakePausedError("cancelled")
      input.assertReady?.()
      await db.botEventDeliveries.add(row)
      if (row.coalesce === "latest" && (row.notBefore ?? 0) > now) {
        const candidates = await db.botEventDeliveries
          .where("[installationId+status]")
          .equals([row.installationId, "pending"])
          .toArray()
        const eligible = candidates.filter(
          (previous) =>
            isLocallyOwned(previous) &&
            previous.attempts === 0 &&
            !previous.runId &&
            previous.triggerId === row.triggerId &&
            previous.coalesce === "latest" &&
            previous.coalesceKey === row.coalesceKey &&
            (previous.notBefore ?? 0) > now
        )
        const winner = eligible.reduce(
          (latest, candidate) => (candidate.receivedAt > latest.receivedAt ? candidate : latest),
          row
        )
        for (const previous of eligible) {
          if (previous.id === winner.id) continue
          const dismissed = {
            status: "dismissed" as const,
            settledAt: now,
            updatedAt: now,
            lastError: "Superseded by a newer event in the debounce window",
          }
          await db.botEventDeliveries.update(previous.id, dismissed)
          if (previous.id === row.id) Object.assign(row, dismissed)
        }
      }
      return row
    }
  )
}

/**
 * Deliveries whose next attempt is due, oldest first.
 *
 * An abandoned attempt is due again whichever status it stopped in: the runner
 * that held it is gone, and leaving the delivery there forever is the
 * difference between a crash costing one retry and costing the event.
 */
export async function listDueBotDeliveries(
  limit = 20,
  now = Date.now(),
  runnableOnly = false,
  /**
   * An installation's effective `maxConcurrentRuns`, when it has one. With it,
   * the batch skips candidates whose installation has no free slot left,
   * counting the attempts already running AND the ones this batch has picked,
   * so an installation at capacity cannot fill the batch with work the runner
   * would only throttle while another installation's ready work waits.
   */
  capacityFor?: (installationId: string) => Promise<number | undefined>
): Promise<BotEventDeliveryRow[]> {
  const db = getDb()
  const rows = await db.botEventDeliveries.toArray()
  const paused = new Set(
    runnableOnly
      ? (await db.botInstallations.toArray()).filter((row) => row.paused).map((row) => row.id)
      : []
  )
  const pausedConversations = new Set(
    runnableOnly
      ? (await db.conversationOverrides.toArray())
          .filter((row) => row.automationPaused)
          .map((row) => row.conversationKey)
      : []
  )
  const heldKeys = new Map<string, Set<string>>()
  if (runnableOnly) {
    for (const row of rows) {
      if (!row.concurrencyKey || !holdsConcurrency(row, now)) continue
      const ids = heldKeys.get(row.concurrencyKey) ?? new Set<string>()
      ids.add(row.id)
      heldKeys.set(row.concurrencyKey, ids)
    }
  }
  const selectedKeys = new Set<string>()
  const candidates = rows
    .filter((row) => {
      if (
        !isLocallyOwned(row) ||
        paused.has(row.installationId) ||
        pausedConversations.has(row.envelope.binding?.conversationKey ?? "")
      )
        return false
      // A parked row is due on its own clock. It can never strand: whichever
      // host reaches it next re-enters the handler, which replays its completed
      // steps and asks the same question again.
      if (row.status === "pending" || row.status === "parked") return row.nextAttemptAt <= now
      return isAbandonedAttempt(row, now)
    })
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.receivedAt - b.receivedAt)
    .filter((row) => {
      if (!runnableOnly || !row.concurrencyKey) return true
      const holders = heldKeys.get(row.concurrencyKey)
      if (holders && (holders.size > 1 || !holders.has(row.id))) return false
      if (selectedKeys.has(row.concurrencyKey)) return false
      selectedKeys.add(row.concurrencyKey)
      return true
    })
  if (!capacityFor) return candidates.slice(0, limit)

  // The same count `countRunningBotDeliveriesForInstallation` takes, read off
  // the rows already loaded instead of one query per candidate.
  const running = new Map<string, number>()
  for (const row of rows) {
    if (isLocallyOwned(row) && isMidAttempt(row.status) && !isAbandonedAttempt(row, now))
      running.set(row.installationId, (running.get(row.installationId) ?? 0) + 1)
  }
  const capacities = new Map<string, number | undefined>()
  const selected: BotEventDeliveryRow[] = []
  for (const row of candidates) {
    if (selected.length >= limit) break
    if (!capacities.has(row.installationId))
      capacities.set(row.installationId, await capacityFor(row.installationId))
    const capacity = capacities.get(row.installationId)
    // An abandoned attempt is due for recovery, which charges it rather than
    // starting it, so it needs no slot.
    if (capacity !== undefined && !isAbandonedAttempt(row, now)) {
      const taken = running.get(row.installationId) ?? 0
      if (taken >= capacity) continue
      running.set(row.installationId, taken + 1)
    }
    selected.push(row)
  }
  return selected
}

/**
 * Take a delivery for `owner`, or return undefined when somebody else already
 * holds a live lease on it.
 *
 * Serialized in a transaction so two runners reading the same due row cannot
 * both conclude they won.
 */
export interface ClaimBotDeliveryLimits {
  /**
   * The installation's effective `maxConcurrentRuns`. Checked inside the claim
   * transaction, so passes claiming in parallel cannot jointly overshoot it.
   */
  maxConcurrentRuns?: number
}

export async function claimBotDelivery(
  id: string,
  owner: string,
  now = Date.now(),
  limits: ClaimBotDeliveryLimits = {}
): Promise<BotEventDeliveryRow | undefined> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.botEventDeliveries,
    db.botInstallations,
    db.conversationOverrides,
    async () => {
      const row = await db.botEventDeliveries.get(id)
      if (!row || (await db.botInstallations.get(row.installationId))?.paused) return undefined
      const conversation = row.envelope.binding?.conversationKey
        ? await db.conversationOverrides
            .where("conversationKey")
            .equals(row.envelope.binding.conversationKey)
            .first()
        : undefined
      if (
        conversation?.automationPaused ||
        (conversation?.automationCancelledBefore !== undefined &&
          (row.envelope.receivedAt ?? row.receivedAt) <= conversation.automationCancelledBefore)
      )
        return undefined
      if (!isLocallyOwned(row)) return undefined
      if (isTerminalBotDelivery(row.status)) return undefined
      // `running` counts here too. A live lease is a live lease whichever half of
      // the attempt its holder had reached, and letting a second runner take a
      // row somebody is executing is the same double-run the lease exists to stop.
      const heldByOther =
        (row.status === "leased" || row.status === "running") && (row.leaseExpiresAt ?? 0) > now
      if (heldByOther) return undefined
      if (
        row.concurrencyKey &&
        (await countActiveBotDeliveriesForKey(row.concurrencyKey, now, row.id)) > 0
      ) {
        return undefined
      }
      if (
        limits.maxConcurrentRuns !== undefined &&
        (await countRunningBotDeliveriesForInstallation(row.installationId, now, row.id)) >=
          limits.maxConcurrentRuns
      ) {
        return undefined
      }

      const claimed: BotEventDeliveryRow = {
        ...row,
        status: "leased",
        leaseOwner: owner,
        leaseExpiresAt: now + BOT_DELIVERY_LEASE_MS,
        updatedAt: now,
      }
      await db.botEventDeliveries.put(claimed)
      return claimed
    }
  )
}

/** Extend a live lease. Returns false when the lease is no longer this owner's. */
export async function renewBotDeliveryLease(
  id: string,
  owner: string,
  now = Date.now()
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (!row || row.leaseOwner !== owner || isTerminalBotDelivery(row.status)) return false
    await db.botEventDeliveries.put({
      ...row,
      leaseExpiresAt: now + BOT_DELIVERY_LEASE_MS,
      updatedAt: now,
    })
    return true
  })
}

/** Attach the ExecutionRun a delivery started, and mark it running. */
export async function markBotDeliveryRunning(
  id: string,
  runId: string,
  now = Date.now(),
  owner?: string
): Promise<boolean> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.botEventDeliveries,
    db.botInstallations,
    db.conversationOverrides,
    async () => {
      const row = await db.botEventDeliveries.get(id)
      if (
        !row ||
        isTerminalBotDelivery(row.status) ||
        (owner !== undefined && row.leaseOwner !== owner)
      )
        return false
      const conversation = row.envelope.binding?.conversationKey
        ? await db.conversationOverrides
            .where("conversationKey")
            .equals(row.envelope.binding.conversationKey)
            .first()
        : undefined
      if (
        (await db.botInstallations.get(row.installationId))?.paused ||
        conversation?.automationPaused
      ) {
        const pending = {
          ...row,
          status: row.runId ? ("parked" as const) : ("pending" as const),
          updatedAt: now,
        }
        delete pending.leaseOwner
        delete pending.leaseExpiresAt
        await db.botEventDeliveries.put(pending)
        return false
      }
      if (
        conversation?.automationCancelledBefore !== undefined &&
        (row.envelope.receivedAt ?? row.receivedAt) <= conversation.automationCancelledBefore
      )
        return false
      const running: BotEventDeliveryRow = { ...row, status: "running", runId, updatedAt: now }
      delete running.notReadySince
      await db.botEventDeliveries.put(running)
      return true
    }
  )
}

export async function completeBotDelivery(
  id: string,
  now = Date.now(),
  owner?: string
): Promise<void> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (
      !row ||
      isTerminalBotDelivery(row.status) ||
      (owner !== undefined && row.leaseOwner !== owner)
    )
      return
    const settled: BotEventDeliveryRow = {
      ...row,
      status: "succeeded",
      updatedAt: now,
      settledAt: now,
    }
    delete settled.leaseOwner
    delete settled.leaseExpiresAt
    await db.botEventDeliveries.put(settled)
  })
}

/**
 * Record a failed attempt, scheduling a retry or dead-lettering.
 *
 * The decision comes from the shared retry policy, which also refuses to retry
 * errors that will always fail (a 403, a schema violation). Retrying those
 * burns the attempt budget an intermittent failure needed.
 */
export async function failBotDelivery(
  id: string,
  error: unknown,
  now = Date.now(),
  random?: () => number,
  owner?: string
): Promise<BotEventDeliveryRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (
      !row ||
      isTerminalBotDelivery(row.status) ||
      (owner !== undefined && row.leaseOwner !== owner)
    )
      return undefined

    const decision = decideNextAttempt({
      attempts: row.attempts,
      error,
      nowMs: now,
      random,
      ...(row.retry ? { policy: row.retry } : {}),
    })
    const deadlettered = decision.status === "deadlettered"
    const next: BotEventDeliveryRow = {
      ...row,
      status: deadlettered ? "deadletter" : "pending",
      attempts: decision.attempts,
      nextAttemptAt: decision.nextAttemptAt,
      lastError: decision.lastError,
      updatedAt: now,
      ...(deadlettered ? { settledAt: now } : {}),
    }
    delete next.leaseOwner
    delete next.leaseExpiresAt
    await db.botEventDeliveries.put(next)
    return next
  })
}

/** How long accepted work waits for its Bot's definition and handler to register. */
export const BOT_NOT_READY_WINDOW_MS = 10 * 60_000
const BOT_NOT_READY_MIN_RETRY_MS = 1_000
const BOT_NOT_READY_MAX_RETRY_MS = 60_000

/**
 * Hand a claimed delivery back because its Bot is not registered here yet.
 *
 * A plugin reloading, or a host whose runner started before its plugins
 * registered, is a gap that closes by itself; dismissing the work then lost
 * it for good, and a dismissed row cannot be retried. So the delivery goes
 * back to `pending` without spending an attempt (the handler never ran) and
 * comes due again after as long as it has already waited, capped at a minute.
 * Past {@link BOT_NOT_READY_WINDOW_MS} it is dead-lettered: still visible, and
 * still one Retry away once the plugin is back.
 */
export async function deferBotDeliveryUntilReady(
  id: string,
  owner: string,
  now = Date.now()
): Promise<BotEventDeliveryRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (!row || isTerminalBotDelivery(row.status) || row.leaseOwner !== owner) return undefined
    const since = row.notReadySince ?? now
    const waited = now - since
    const expired = waited >= BOT_NOT_READY_WINDOW_MS
    const next: BotEventDeliveryRow = {
      ...row,
      status: expired ? "deadletter" : "pending",
      notReadySince: since,
      nextAttemptAt: expired
        ? now
        : now + Math.min(BOT_NOT_READY_MAX_RETRY_MS, Math.max(BOT_NOT_READY_MIN_RETRY_MS, waited)),
      lastError: expired
        ? "The Bot's definition or handler did not register in time"
        : "Waiting for the Bot's definition and handler to register",
      updatedAt: now,
      ...(expired ? { settledAt: now } : {}),
    }
    delete next.leaseOwner
    delete next.leaseExpiresAt
    await db.botEventDeliveries.put(next)
    return next
  })
}

/**
 * Set a delivery aside until `resumeAt`, without spending an attempt.
 *
 * A run waiting on a person is not failing, so charging it would burn the
 * budget on somebody's thinking time. The lease is cleared because this host is
 * no longer executing it, which is what lets any host resume the run.
 */
export async function parkBotDelivery(
  id: string,
  resumeAt: number,
  now = Date.now(),
  owner?: string
): Promise<void> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (
      !row ||
      isTerminalBotDelivery(row.status) ||
      (owner !== undefined && row.leaseOwner !== owner)
    )
      return
    const next: BotEventDeliveryRow = {
      ...row,
      status: "parked",
      nextAttemptAt: resumeAt,
      updatedAt: now,
    }
    delete next.leaseOwner
    delete next.leaseExpiresAt
    await db.botEventDeliveries.put(next)
  })
}

/**
 * Retire a delivery that was correctly never run.
 *
 * Kept apart from `failed` so a coalesced burst or a disabled installation
 * does not read as a broken queue.
 */
export async function dismissBotDelivery(
  id: string,
  reason: string,
  now = Date.now(),
  owner?: string
): Promise<void> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (
      !row ||
      isTerminalBotDelivery(row.status) ||
      (owner !== undefined && row.leaseOwner !== owner)
    )
      return
    const next: BotEventDeliveryRow = {
      ...row,
      status: "dismissed",
      lastError: reason,
      updatedAt: now,
      settledAt: now,
    }
    delete next.leaseOwner
    delete next.leaseExpiresAt
    await db.botEventDeliveries.put(next)
  })
}

/** Put a dead letter back in the queue for one more attempt. */
export async function replayBotDelivery(
  id: string,
  now = Date.now()
): Promise<BotEventDeliveryRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (!row || row.status !== "deadletter" || !isLocallyOwned(row)) return undefined
    const next: BotEventDeliveryRow = {
      ...row,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      updatedAt: now,
    }
    delete next.settledAt
    delete next.leaseOwner
    delete next.leaseExpiresAt
    delete next.lastError
    await db.botEventDeliveries.put(next)
    return next
  })
}

/** What became of a delivery whose attempt was abandoned. */
export type BotDeliveryRecovery = "recovered" | "deadlettered"

/**
 * Charge one attempt to a delivery whose runner disappeared, and put it back in
 * the queue (or dead-letter it once the budget is gone).
 *
 * Called before the claim rather than inside it so the runner can report why it
 * skipped this pass. The row comes back on the next drain, after its backoff,
 * which is what stops a delivery that kills its host from being re-claimed in a
 * tight loop.
 */
export async function recoverAbandonedBotDelivery(
  id: string,
  settle: BotDeadletterSettler,
  now = Date.now(),
  random?: () => number
): Promise<BotDeliveryRecovery | null> {
  const db = getDb()
  return db.transaction("rw", recoveryStores(db), async () => {
    const row = await db.botEventDeliveries.get(id)
    if (!row || !isLocallyOwned(row) || !isAbandonedAttempt(row, now)) return null
    const next = await settledRecovery(chargeAbandonedAttempt(row, now, random), now, settle)
    await db.botEventDeliveries.put(next)
    return next.status === "deadletter" ? "deadlettered" : "recovered"
  })
}

/**
 * Reclaim, at boot, the rows this host was executing when it stopped.
 *
 * Owner-scoped on purpose. The connector plane can reclaim every `running` row
 * because it owns its adapters outright; the Bot queue may be drained by more
 * than one host, so a blanket sweep would yank a delivery out from under a peer
 * that is still working on it. What a restarting host *does* know is that its
 * own owner string cannot belong to a live attempt: that process is this one,
 * and it has just started. So its rows are recovered immediately instead of
 * waiting out a lease nobody is holding.
 */
export async function recoverStaleBotDeliveries(input: {
  owner: string
  settle: BotDeadletterSettler
  now?: number
  random?: () => number
}): Promise<number> {
  const db = getDb()
  const now = input.now ?? Date.now()
  return db.transaction("rw", recoveryStores(db), async () => {
    const rows = await db.botEventDeliveries.toArray()
    const mine = rows.filter(
      (row) =>
        isLocallyOwned(row) &&
        row.leaseOwner === input.owner &&
        (row.status === "leased" || row.status === "running")
    )
    for (const row of mine) {
      await db.botEventDeliveries.put(
        await settledRecovery(chargeAbandonedAttempt(row, now, input.random), now, input.settle)
      )
    }
    return mine.length
  })
}

/** In-flight deliveries sharing a concurrency key, for serialisation. */
export async function countActiveBotDeliveriesForKey(
  concurrencyKey: string,
  now = Date.now(),
  excludeId?: string
): Promise<number> {
  const rows = await getDb()
    .botEventDeliveries.where("concurrencyKey")
    .equals(concurrencyKey)
    .toArray()
  // Both mid-attempt statuses need a LIVE lease to count. Counting `running`
  // unconditionally is what used to retire a concurrency key permanently: one
  // crash left a row nothing could clear, and every later delivery on that key
  // was skipped as serialised forever after.
  return rows.filter((row) => row.id !== excludeId && holdsConcurrency(row, now)).length
}

/**
 * Attempts of one installation that are executing right now: claimed or
 * running under a live lease. This is what `maxConcurrentRuns` bounds.
 *
 * A parked run is deliberately not counted. It is waiting on a person, holds
 * no executor, and counting it would let one unanswered approval stop every
 * other run of the installation (including the short ones that answer status
 * and cancel requests about it).
 */
export async function countRunningBotDeliveriesForInstallation(
  installationId: string,
  now = Date.now(),
  excludeId?: string
): Promise<number> {
  const rows = await getDb()
    .botEventDeliveries.where("[installationId+status]")
    .anyOf([
      [installationId, "leased"],
      [installationId, "running"],
    ])
    .toArray()
  return rows.filter(
    (row) => row.id !== excludeId && isLocallyOwned(row) && !isAbandonedAttempt(row, now)
  ).length
}

/** One delivery by id. A primary-key read, so a control write can check state. */
export async function getBotDelivery(id: string): Promise<BotEventDeliveryRow | undefined> {
  return getDb().botEventDeliveries.get(id)
}

export async function listBotDeliveries(query: {
  installationId?: string
  status?: BotDeliveryStatus
  limit?: number
}): Promise<BotEventDeliveryRow[]> {
  const rows = await getDb().botEventDeliveries.toArray()
  return rows
    .filter((row) => {
      if (query.installationId && row.installationId !== query.installationId) return false
      if (query.status && row.status !== query.status) return false
      return true
    })
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, query.limit ?? 100)
}

/**
 * A correlation key as deliveries carry it: scoped to the installation, so two
 * Bots watching one resource cannot consume each other's answers. The router
 * and `ctx.bots.queue` stamp deliveries with it, and a wait matches on it. A
 * key already scoped to this installation (an envelope's own `correlation`
 * handed back by a handler) is returned unchanged rather than scoped twice.
 */
export function botCorrelationKey(installationId: string, key: string): string {
  const prefix = `${installationId}::`
  return key.startsWith(prefix) ? key : prefix + key
}

/** Do two envelopes belong to one conversation of one installation? */
export function correlatedBotEvents(
  origin: BotEventEnvelopeV1,
  reply: BotEventEnvelopeV1
): boolean {
  if (origin.installationId !== reply.installationId || origin.eventId === reply.eventId)
    return false
  if (origin.source !== reply.source) return true
  return (
    origin.binding?.integrationAccountId === reply.binding?.integrationAccountId &&
    origin.binding?.adapterId === reply.binding?.adapterId &&
    origin.binding?.conversationKey === reply.binding?.conversationKey
  )
}

/** The run a wait belongs to: its id, installation and, when it has one, its own delivery. */
export interface BotEventWaiter {
  runId: string
  installationId: string
  origin?: BotEventEnvelopeV1
}

/**
 * Does `reply` answer this wait? The ONE rule: the waiting step and the
 * delivery runner both apply it, so a delivery the runner hands to a waiting
 * run is one the run accepts, and one the run would refuse is left to start
 * its own handler.
 *
 * A reply answers when it carries the wait's key and answer trigger, was
 * received by the deadline (one that arrived in time but is read later still
 * counts), belongs to the run's conversation, and is still unclaimed: a reply
 * that ran its own handler, was cancelled or coalesced away, or was consumed
 * by a wait already (an earlier round's included) answers nothing more. The
 * reply this same wait consumed keeps answering it, so a re-entry finds it.
 */
export function answersBotEventWait(
  waiter: BotEventWaiter,
  wait: BotEventWait,
  reply: BotEventDeliveryRow
): boolean {
  if (reply.syncedFromHost || reply.runId === waiter.runId) return false
  if (reply.installationId !== waiter.installationId || reply.correlation !== wait.key) return false
  if (wait.triggerId && reply.triggerId !== wait.triggerId) return false
  if (reply.receivedAt > wait.deadline) return false
  if (waiter.origin && !correlatedBotEvents(waiter.origin, reply.envelope)) return false
  if (reply.consumedBy) {
    return reply.consumedBy.runId === waiter.runId && reply.consumedBy.step === wait.step
  }
  return reply.status === "pending" && reply.cancelledAt === undefined
}

/** Retire `reply` as consumed by this wait. Inside a transaction over `botEventDeliveries`. */
async function consumeReply(
  reply: BotEventDeliveryRow,
  waiter: BotEventWaiter,
  wait: BotEventWait,
  now: number
): Promise<void> {
  if (reply.consumedBy) return
  await getDb().botEventDeliveries.put({
    ...reply,
    status: "dismissed",
    consumedBy: { runId: waiter.runId, step: wait.step },
    lastError: "consumed by a waiting run",
    updatedAt: now,
    settledAt: now,
  })
}

/**
 * Open a wait on the run's own delivery, so the runner can hand an arriving
 * reply to it. Replaces any wait the run had open: a run waits on one step at
 * a time. A run without a delivery (a step driven outside the queue) records
 * nothing, and only its own polling can find a reply.
 */
export async function openBotEventWait(
  runId: string,
  wait: BotEventWait,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.where("runId").equals(runId).first()
    if (!row || isTerminalBotDelivery(row.status)) return
    await db.botEventDeliveries.put({ ...row, eventWait: wait, updatedAt: now })
  })
}

/** Close the run's open wait, when it timed out. */
export async function closeBotEventWait(runId: string, now = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.where("runId").equals(runId).first()
    if (!row?.eventWait) return
    const next: BotEventDeliveryRow = { ...row, updatedAt: now }
    delete next.eventWait
    await db.botEventDeliveries.put(next)
  })
}

/**
 * Take the reply that answers a wait, oldest first, and close the wait.
 *
 * Consumed in the same transaction it is chosen in, so the runner cannot claim
 * it for its own handler in between: one arrival answers one wait, once.
 */
export async function takeBotEventReply(
  waiter: BotEventWaiter,
  wait: BotEventWait,
  now = Date.now()
): Promise<BotEventEnvelopeV1 | undefined> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const candidates = await db.botEventDeliveries.where("correlation").equals(wait.key).toArray()
    const reply = candidates
      .filter((row) => answersBotEventWait(waiter, wait, row))
      .sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id))[0]
    if (!reply) return undefined
    await consumeReply(reply, waiter, wait, now)
    const own = await db.botEventDeliveries.where("runId").equals(waiter.runId).first()
    if (own?.eventWait?.step === wait.step) {
      const next: BotEventDeliveryRow = { ...own, updatedAt: now }
      delete next.eventWait
      await db.botEventDeliveries.put(next)
    }
    return reply.envelope
  })
}

/**
 * Hand a just-arrived delivery to the run already waiting for it, if one is.
 *
 * Checked before the delivery is claimed, by the same rule the waiting step
 * applies. The reply is consumed for that run and a parked run is woken now
 * rather than at its next interval. Returns the waiting run's delivery, or
 * undefined when no open wait accepts this reply and it should run on its own.
 */
export async function handBotReplyToWaitingRun(
  replyId: string,
  now = Date.now()
): Promise<BotEventDeliveryRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const reply = await db.botEventDeliveries.get(replyId)
    if (!reply?.correlation) return undefined
    const rows = await db.botEventDeliveries
      .where("installationId")
      .equals(reply.installationId)
      .toArray()
    for (const row of rows) {
      const wait = row.eventWait
      if (!wait || !row.runId || (row.status !== "parked" && row.status !== "running")) continue
      const waiter = { runId: row.runId, installationId: row.installationId, origin: row.envelope }
      if (!answersBotEventWait(waiter, wait, reply)) continue
      await consumeReply(reply, waiter, wait, now)
      if (row.status === "parked") {
        await db.botEventDeliveries.put({ ...row, nextAttemptAt: now, updatedAt: now })
      }
      return row
    }
    return undefined
  })
}

/**
 * Drop settled rows past the retention window, and retire anything that has
 * been unsettled for longer than one. Returns the number of rows removed.
 *
 * The second half is the backstop. Recovery already returns an abandoned
 * attempt to the queue, so a row should not be able to sit unsettled for two
 * weeks; if one does, its installation is gone or its trigger no longer exists,
 * and leaving it is how a queue accumulates work nobody will ever do. It is
 * dismissed rather than deleted so the reason survives to the next sweep.
 */
export async function pruneSettledBotDeliveries(now = Date.now()): Promise<number> {
  const db = getDb()
  const cutoff = now - BOT_DELIVERY_RETENTION_MS
  const rows = await db.botEventDeliveries.toArray()

  const paused = new Set(
    (await db.botInstallations.toArray()).filter((row) => row.paused).map((row) => row.id)
  )
  const pausedConversations = new Set(
    (await db.conversationOverrides.toArray())
      .filter((row) => row.automationPaused)
      .map((row) => row.conversationKey)
  )
  const expired = rows.filter(
    (row) =>
      isLocallyOwned(row) &&
      !isTerminalBotDelivery(row.status) &&
      Math.max(row.receivedAt, row.retentionExtendedAt ?? 0) <= cutoff &&
      !paused.has(row.installationId) &&
      !pausedConversations.has(row.envelope.binding?.conversationKey ?? "")
  )
  for (const row of expired) {
    await dismissBotDelivery(row.id, "unsettled past the retention window", now)
  }

  const pruned = rows.filter((row) => row.settledAt !== undefined && row.settledAt <= cutoff)
  if (pruned.length === 0) return 0
  const ids = pruned.map((row) => row.id)
  await db.transaction("rw", db.botEventDeliveries, db.botRunSteps, db.syncTombstones, async () => {
    await db.botEventDeliveries.bulkDelete(ids)
    // The run's checkpoints (business steps, its policy snapshot, its final
    // result) go with the delivery that owns them, as the data catalog
    // declares. A run id is derived per delivery, so no other delivery can
    // still need them; a retry mints a successor delivery with its own run.
    await deleteBotRunStepsForRuns(pruned.flatMap((row) => (row.runId ? [row.runId] : [])))
    // Paired clients mirror the delivery-status projection and hear about a
    // pruned row only through this tombstone.
    await recordTombstones("botEventDeliveries", ids, now)
  })
  return ids.length
}
