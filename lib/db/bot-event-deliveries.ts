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
import { recordTombstones } from "@/lib/sync/tombstones"
import type { BotDeliveryStatus, BotEventDeliveryRow } from "@/lib/db/bot-types"
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
 * The arrival-dedup key for one delivery.
 *
 * Scoped to the installation, not the event: the same event legitimately fans
 * out to several installations, and a global key would let the first recipient
 * swallow everyone else's copy.
 */
export function botDeliveryDedupKey(
  installationId: string,
  eventId: string,
  triggerId?: string
): string {
  return triggerId === undefined
    ? `${installationId}::${eventId}`
    : `v2:${JSON.stringify([installationId, triggerId, eventId])}`
}

export class BotIntakePausedError extends Error {
  readonly code = "bot_intake_paused"
  constructor(readonly reason: "installation" | "conversation" | "cancelled" = "installation") {
    super("Bot intake is paused")
  }
}

export interface EnqueueBotDeliveryInput {
  envelope: BotEventEnvelopeV1
  /** Synchronous in-memory readiness fence immediately before a new insert. */
  assertReady?: () => undefined
  /** Hold the delivery until this instant, for a debounced trigger. */
  notBefore?: number
  concurrencyKey?: string
  holdConcurrencyWhileWaiting?: boolean
  /** The trigger's declared retry policy, snapshotted onto the row. */
  retry?: PluginBotRetryPolicy
  coalesce?: "latest" | "all"
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
  }

  return db.transaction(
    "rw",
    db.botEventDeliveries,
    db.botInstallations,
    db.conversationOverrides,
    async () => {
      const existing = await db.botEventDeliveries.where("dedupKey").equals(dedupKey).first()
      if (existing) return existing
      // Existing run IDs and step journals must survive the identity upgrade.
      const legacy = await db.botEventDeliveries
        .where("dedupKey")
        .equals(botDeliveryDedupKey(envelope.installationId, envelope.eventId))
        .first()
      if (legacy?.triggerId === envelope.triggerId) return legacy
      const conversation = envelope.binding?.conversationKey
        ? await db.conversationOverrides
            .where("conversationKey")
            .equals(envelope.binding.conversationKey)
            .first()
        : undefined
      if ((await db.botInstallations.get(row.installationId))?.paused)
        throw new BotIntakePausedError("installation")
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
  runnableOnly = false
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
  return rows
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
    .slice(0, limit)
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
          status: row.waitingFor || row.runId ? ("parked" as const) : ("pending" as const),
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
      await db.botEventDeliveries.put({ ...row, status: "running", runId, updatedAt: now })
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
  waitingFor?: string,
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
      ...(waitingFor ? { waitingFor } : {}),
    }
    delete next.leaseOwner
    delete next.leaseExpiresAt
    await db.botEventDeliveries.put(next)
  })
}

/** A run parked on this correlation key, if one is already waiting for it. */
export async function findParkedBotDeliveryWaitingFor(
  installationId: string,
  waitingFor: string,
  incoming?: BotEventEnvelopeV1
): Promise<BotEventDeliveryRow | undefined> {
  const rows = await getDb()
    .botEventDeliveries.where("installationId")
    .equals(installationId)
    .toArray()
  return rows.find(
    (row) =>
      row.status === "parked" &&
      row.waitingFor === waitingFor &&
      (!incoming || correlatedBotEvents(row.envelope, incoming))
  )
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
  now = Date.now(),
  random?: () => number
): Promise<BotDeliveryRecovery | null> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (!row || !isLocallyOwned(row) || !isAbandonedAttempt(row, now)) return null
    const next = chargeAbandonedAttempt(row, now, random)
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
  now?: number
  random?: () => number
}): Promise<number> {
  const db = getDb()
  const now = input.now ?? Date.now()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const rows = await db.botEventDeliveries.toArray()
    const mine = rows.filter(
      (row) =>
        isLocallyOwned(row) &&
        row.leaseOwner === input.owner &&
        (row.status === "leased" || row.status === "running")
    )
    for (const row of mine) {
      await db.botEventDeliveries.put(chargeAbandonedAttempt(row, now, input.random))
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

/** Deliveries waiting on a correlation key, for a run parked in `waitForEvent`. */
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

export async function findBotDeliveryByCorrelation(
  correlation: string,
  origin?: BotEventEnvelopeV1,
  triggerId?: string
): Promise<BotEventDeliveryRow | undefined> {
  const rows = await getDb().botEventDeliveries.where("correlation").equals(correlation).toArray()
  return rows.find(
    (row) =>
      !row.syncedFromHost &&
      row.cancelledAt === undefined &&
      (!origin || correlatedBotEvents(origin, row.envelope)) &&
      (!triggerId || row.triggerId === triggerId)
  )
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

  const ids = rows
    .filter((row) => row.settledAt !== undefined && row.settledAt <= cutoff)
    .map((row) => row.id)
  if (ids.length === 0) return 0
  await db.transaction("rw", db.botEventDeliveries, db.syncTombstones, async () => {
    await db.botEventDeliveries.bulkDelete(ids)
    // Paired clients mirror the delivery-status projection and hear about a
    // pruned row only through this tombstone.
    await recordTombstones("botEventDeliveries", ids, now)
  })
  return ids.length
}
