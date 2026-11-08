import { validateOutboundFeatures } from "./outbound-features"

/**
 * Outbound delivery runner — Tasks 38 & 39.
 *
 * Task 38 primitives:
 *   - Per-adapter circuit breaker: trips when failure rate in a sliding window
 *     exceeds the threshold; re-opens after cooldown. While open, due jobs are
 *     DEFERRED (retry after the cooldown ends) — never dead-lettered for the
 *     breaker alone — and breaker deferrals don't consume attempts.
 *   - Per-adapter token bucket: rate limits outbound send attempts (checked
 *     after the atomic claim so a lost claim never wastes a token; a
 *     rate-limit deferral un-claims and refunds the attempt).
 *   - Exponential back-off with jitter: `min(60 000, 1000 * 2^attempts) + jitter`,
 *     backed by the shared `computeBackoffDelay` from `@cognia/primitives`.
 *   - Idempotency dedupe: an in-memory LRU short-circuits retries when the
 *     platform already acked, backed by row-level delivery evidence
 *     (`platformMessageId` + the indexed `idempotencyKey` column) so a
 *     rebooted runner doesn't re-send what a prior session delivered.
 *   - Dead-letter after 5 attempts.
 *   - Stale-claim recovery: `sending` rows orphaned by a crash (claimed but
 *     never settled) are flipped back to `failed` after a 5-minute grace,
 *     on startup and every five minutes thereafter.
 *
 * Task 39 addition:
 *   - Per-conversation FIFO: each bounded due batch resolves the true
 *     `orderSeq` head before entering a lane. A lane advances only after its
 *     current head becomes terminal, in bursts capped at the due-batch size;
 *     deferred heads block later siblings. Cross-conversation sends run in
 *     parallel behind the shared platform-send semaphore.
 *
 * Usage:
 *   const controller = new AbortController()
 *   startOutboundRunner({ adapters, signal: controller.signal }).catch(console.error)
 *   // later:
 *   controller.abort()
 */

import type { AdapterSendOptions } from "@/types/connectors/adapter"
import type { PlatformAdapter } from "@/types/connectors"
import { createMutex, computeBackoffDelay } from "@cognia/primitives"
import { isInQuietRange, msUntilQuietRangeEnd } from "@/lib/notifications/policy/quiet-hours"
import { placeMessage } from "./message-placement"
import {
  deleteOutboundJob,
  listDueNow,
  peekNextWakeAt,
  subscribeOutboundEnqueued,
  markSending,
  markSent,
  markAwaitingDeliveryReceipt,
  deferUnclaimed,
  holdOutboundForAuthorization,
  markFailed,
  markDeliveryUnknown,
  markDeadlettered,
  unclaimSending,
  recoverStaleSendingJobs,
  reconcileOutboundJobExecutions,
  findDeliveredByIdempotencyKey,
  findOlderActiveOutboundSibling,
  findNextActiveOutboundSibling,
  isOutboundTerminal,
  OUTBOUND_DUE_BATCH_SIZE,
  updateOutboundAuthorization,
} from "@/lib/db/outbound-jobs"
import {
  ConnectorDeliveryDeniedError,
  enqueueGoverned as enqueueOutbound,
} from "@/lib/connectors/delivery-gateway"
import { getDb } from "@/lib/db/schema"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import type {
  AdapterInstanceRow,
  ConversationOverrideRow,
  OutboundJobRow,
  OutboundTuningConfig,
} from "@/lib/db/connector-types"
import {
  markResponded,
  readForResolution,
  wakeSnoozedConversations,
} from "@/lib/db/conversation-overrides"
import { appendAudit } from "./audit"
import { enforceTwinDisclosureFromProvenance } from "@/lib/twin/outbound-disclosure"
import { trackInboxEvent } from "@/lib/telemetry/inbox-events"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { parseConversationKey, buildConversationKey } from "@/types/connectors/event"
import { isReauthCode } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import {
  createCircuitBreaker,
  type CircuitBreaker,
} from "@cognia/plugin-contract/lib/connectors/circuit-breaker"
import { createTokenBucket, type TokenBucket } from "./rate-limit"
import { recordDeliveredMessage } from "./delivered-messages"
import { createDraft, prepareDraftRow } from "@/lib/db/connector-drafts"
import type {
  DeliveryDecision,
  DeliveryPlanInput,
  OutboundAuthorization,
} from "@/lib/policy/action-review/plan-delivery"
import type { OutboundSettingsLike } from "@/lib/policy/action-review/plan-context"
import {
  ACTION_REVIEW_AUTHORITIES,
  ACTION_REVIEW_GRANT_SCOPES,
} from "@cognia/agent-config-types/action-review"
import type { AdapterRuntimeStateSnapshot } from "@cognia/plugin-contract/lib/connectors/outbound-runner"
export type { AdapterRuntimeStateSnapshot } from "@cognia/plugin-contract/lib/connectors/outbound-runner"

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
const IDEMPOTENCY_LRU_CAP = 1_000
/**
 * Defer window for muted adapters / conversations. Long mutes are the norm
 * (hours), so re-checking every 5 min is plenty responsive while keeping the
 * defer loop from re-visiting each muted job every minute.
 */
const MUTED_DEFER_MS = 5 * 60_000
/** Throttle for drain-pass error audits — one audit row per minute at most. */
const DRAIN_ERROR_AUDIT_THROTTLE_MS = 60_000
/** Pseudo adapter id for runner-level (not adapter-attributable) audit rows. */
const RUNNER_AUDIT_ADAPTER_ID = "__outbound_runner__"
/**
 * Safety-net ceiling on how long the wake-driven loop sleeps when nothing is
 * scheduled. The loop is normally woken precisely (enqueue event or the next
 * retry deadline), so this only bounds the worst case if a wake is ever
 * missed — it is NOT a poll interval. Overridable via `pollIntervalMs`.
 */
const DEFAULT_IDLE_CAP_MS = 60_000
export const MAX_ACTIVE_PLATFORM_SENDS = 16
export const STALE_RECOVERY_INTERVAL_MS = 5 * 60_000

// ── Per-bot outbound tuning ──────────────────────────────────────────────────

/**
 * Runner defaults for the per-adapter token bucket + circuit breaker. Any
 * knob an operator leaves unset on `AdapterInstanceRow.outboundTuning`
 * falls back to these values (they match the pre-tuning hardcoded ones, so
 * rows without tuning behave exactly as before).
 */
export const DEFAULT_OUTBOUND_TUNING: Required<OutboundTuningConfig> = {
  rateCapacity: 20,
  rateRefillPerSec: 5,
  breakerWindowMs: 30_000,
  breakerMinEvents: 5,
  breakerFailureThresholdPct: 50,
  breakerCooldownMs: 30_000,
}

/**
 * Fold an operator-supplied tuning block over the defaults, rejecting
 * non-finite / out-of-range knobs individually (a bad knob degrades to its
 * default rather than poisoning the whole block). Exported for the settings
 * UI so form placeholders and the runner agree on the effective values.
 */
export function sanitizeOutboundTuning(
  tuning: OutboundTuningConfig | undefined
): Required<OutboundTuningConfig> {
  const pick = (value: number | undefined, fallback: number, opts?: { max?: number }): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
    if (opts?.max !== undefined && value > opts.max) return fallback
    return value
  }
  return {
    rateCapacity: pick(tuning?.rateCapacity, DEFAULT_OUTBOUND_TUNING.rateCapacity),
    rateRefillPerSec: pick(tuning?.rateRefillPerSec, DEFAULT_OUTBOUND_TUNING.rateRefillPerSec),
    breakerWindowMs: pick(tuning?.breakerWindowMs, DEFAULT_OUTBOUND_TUNING.breakerWindowMs),
    breakerMinEvents: Math.round(
      pick(tuning?.breakerMinEvents, DEFAULT_OUTBOUND_TUNING.breakerMinEvents)
    ),
    breakerFailureThresholdPct: pick(
      tuning?.breakerFailureThresholdPct,
      DEFAULT_OUTBOUND_TUNING.breakerFailureThresholdPct,
      { max: 100 }
    ),
    breakerCooldownMs: pick(tuning?.breakerCooldownMs, DEFAULT_OUTBOUND_TUNING.breakerCooldownMs),
  }
}

// ── LRU map (insertion-order, capped) ────────────────────────────────────────

class LruMap<K, V> {
  private readonly cap: number
  private readonly map: Map<K, V>

  constructor(cap: number) {
    this.cap = cap
    this.map = new Map()
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.cap) {
      // Evict oldest (first) entry
      this.map.delete(this.map.keys().next().value as K)
    }
    this.map.set(key, value)
  }

  size(): number {
    return this.map.size
  }
}

// ── Per-conversation FIFO lane (Task 39) ──────────────────────────────────────

/**
 * Chains work items for a single conversation so they execute serially,
 * preserving createdAt order while allowing cross-conversation parallelism.
 */
export class ConversationLane {
  // Delegates serialization to the shared async mutex (lib/utils/async-mutex)
  // so the tail-chain pattern lives in one tested place. The lane keeps its
  // fire-and-forget contract: enqueue never rejects (errors are handled inside
  // `work`), so we swallow the mutex result here rather than in the primitive.
  private readonly mutex = createMutex()
  private pending = 0

  constructor(private readonly onIdle: () => void = () => undefined) {}

  /** Enqueue `work` behind the current tail; resolves when it settles. */
  enqueue(work: () => Promise<void>): Promise<void> {
    this.pending += 1
    return this.mutex
      .runExclusive(work)
      .catch(() => {
        // Errors are handled inside `work`; lane must not stall on them.
      })
      .finally(() => {
        this.pending -= 1
        if (this.pending === 0) this.onIdle()
      })
  }

  pendingCount(): number {
    return this.pending
  }
}

class PlatformSendSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(
    private readonly limit: number,
    private readonly onChange: (active: number) => void
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active += 1
    this.onChange(this.active)
    try {
      return await work()
    } finally {
      this.active -= 1
      this.onChange(this.active)
      this.waiters.shift()?.()
    }
  }
}

// ── Runner options ────────────────────────────────────────────────────────────

export interface OutboundRunnerOptions {
  /** Current authorization mode; default reads the settings store lazily. */
  settings?: () => OutboundSettingsLike | Promise<OutboundSettingsLike>
  /** Default loads the real planner lazily, avoiding the gateway/runtime cycle. */
  planDelivery?: (input: DeliveryPlanInput) => Promise<DeliveryDecision>
  /**
   * Live adapter lookup. Structurally satisfied by a `Map`, but production
   * callers should pass a getter backed by the bus registry so adapters
   * rebuilt after boot (credential rotation, hot enable) are picked up — a
   * Map snapshotted at boot time delivers through stale instances forever.
   */
  adapters: { get(adapterId: string): PlatformAdapter | undefined }
  /**
   * Idle-sleep ceiling in ms (default 60 000). The loop is event-driven —
   * it wakes on enqueue and at each retry deadline — so this only caps the
   * worst-case sleep if a wake is missed; it is not a poll interval. Named
   * `pollIntervalMs` for backwards compatibility with existing call-sites
   * and tests (which pass a tiny value to tighten the safety net).
   */
  pollIntervalMs?: number
  /** Cancellation signal — runner exits when this aborts. */
  signal: AbortSignal
  /** Clock injection for circuit breakers and rate limiters. */
  now?: () => number
  /**
   * Jitter factory — returns a random ms to add to the back-off.
   * Default: `() => Math.random() * 500`.
   */
  jitter?: () => number
  /**
   * Fired best-effort after a job is successfully delivered (or served from
   * the idempotency cache), with the delivered conversation key. Production
   * wires this to `ConnectorBus.recordBotReply` so the `cooldown-after-bot-reply`
   * trigger blocker (a default group-chat anti-spam rule) actually has a
   * `lastReplyAt` to read — the bus's policy state has no other writer. Kept
   * as an injected callback so the runner stays decoupled from the bus and
   * unit-testable. Must never throw.
   */
  onDelivered?: (conversationKey: string) => void
  /** Test/diagnostic observer for structural scheduler budgets. */
  onSchedulerState?: (state: {
    activeSends: number
    laneCount: number
    dueBatchSize: number
  }) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Persisted host claims are unknown at the package boundary. Never cast unchecked. */
function readStoredAuthorization(value: unknown): OutboundAuthorization | undefined {
  if (!isRecord(value)) return undefined
  const optionalString = (record: Record<string, unknown>, key: string) =>
    record[key] === undefined || typeof record[key] === "string"
  let valid = false
  switch (value.kind) {
    case "human":
      valid = ["local-user", "device", "connector-user"].includes(value.actor as string)
      break
    case "origin-reply":
    case "system-notice":
      valid = typeof value.inboundConversationKey === "string"
      break
    case "tool-call":
      valid =
        typeof value.sessionId === "string" &&
        typeof value.toolUseId === "string" &&
        (value.createdConversation === undefined || typeof value.createdConversation === "boolean")
      break
    case "plugin":
      valid = typeof value.pluginId === "string" && optionalString(value, "botRunId")
      break
    case "unattended": {
      const origin = value.origin
      const target = isRecord(origin) ? origin.originThread : undefined
      valid =
        typeof value.ownerRef === "string" &&
        optionalString(value, "sessionId") &&
        (origin === undefined ||
          (isRecord(origin) &&
            optionalString(origin, "rootSessionId") &&
            optionalString(origin, "instructionEpoch") &&
            (target === undefined ||
              (isRecord(target) &&
                [
                  "conversation",
                  "person",
                  "mail",
                  "repository",
                  "site",
                  "public",
                  "unknown",
                ].includes(target.kind as string) &&
                typeof target.channel === "string" &&
                typeof target.recipient === "string" &&
                optionalString(target, "thread"))))) &&
        (value.policyGrants === undefined ||
          (Array.isArray(value.policyGrants) &&
            value.policyGrants.every(
              (grant) =>
                isRecord(grant) &&
                typeof grant.policyRef === "string" &&
                (Array.isArray(grant.fingerprints) || grant.fingerprints instanceof Set) &&
                [...grant.fingerprints].every((fp) => typeof fp === "string")
            )))
      break
    }
    case "rerouted": {
      const from = value.from
      if (!isRecord(from) || typeof from.conversationKey !== "string") break
      const by = from.authorizedBy
      const provenance = from.provenance
      valid =
        (by === undefined ||
          (isRecord(by) &&
            ACTION_REVIEW_AUTHORITIES.some((authority) => authority === by.authority) &&
            optionalString(by, "receiptId") &&
            optionalString(by, "policyRef") &&
            (by.grantScope === undefined ||
              ACTION_REVIEW_GRANT_SCOPES.some((scope) => scope === by.grantScope)))) &&
        (provenance === undefined ||
          (isRecord(provenance) &&
            provenance.schemaVersion === 1 &&
            ["shadow", "enforce"].includes(provenance.mode as string) &&
            ["allow", "draft", "deny", "unplanned", "exempt"].includes(provenance.plan as string) &&
            typeof provenance.policyVersion === "string" &&
            typeof provenance.plannedAt === "number" &&
            optionalString(provenance, "receiptId")))
      break
    }
  }
  return valid ? (value as unknown as OutboundAuthorization) : undefined
}

// ── Per-adapter state ────────────────────────────────────────────────────────

interface AdapterState {
  breaker: CircuitBreaker
  bucket: TokenBucket
  /**
   * Serialized effective tuning this state was built with. When the
   * adapter row's tuning changes mid-run, the runner rebuilds the
   * bucket/breaker pair (dropping their in-flight window — acceptable:
   * a tuning edit is an explicit operator action).
   */
  tuningFingerprint: string
  /**
   * Set once an `adapter.reauth_required` row has been written for this
   * adapter, cleared by the next successful delivery. Keeps a backlog of
   * jobs failing on the same revoked credential from writing one row each.
   */
  reauthRecorded: boolean
}

// ── Runtime-state registry (heartbeat read-side) ─────────────────────────────

/**
 * The runner singleton publishes its live `adapterState` Map here so the
 * heartbeat (which lives outside the runner closure) can read snapshots
 * without IPC. `null` between runner stop and the next start.
 */
let currentAdapterStateMap: Map<string, AdapterState> | null = null

/**
 * Read a snapshot of the outbound runtime for `adapterId`. Returns `null`
 * when the runner isn't currently running, or when the adapter has not
 * yet produced any outbound activity (lazy-initialised on first send).
 * Callers (e.g., the heartbeat probe, Health Detail panel) should treat
 * `null` as "no data yet" and fall back to neutral defaults in the UI.
 */
export function getAdapterRuntimeStateSnapshot(
  adapterId: string
): AdapterRuntimeStateSnapshot | null {
  if (currentAdapterStateMap === null) return null
  const state = currentAdapterStateMap.get(adapterId)
  if (!state) return null
  return {
    breaker: state.breaker.snapshot(),
    bucket: state.bucket.snapshot(),
  }
}

/** Test-only: drop the runtime-state registry so unit tests don't bleed state. */
export function __resetAdapterRuntimeStateForTesting(): void {
  currentAdapterStateMap = null
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Start the outbound delivery loop. Resolves when `signal` is aborted.
 * Never rejects — all delivery errors are surfaced via audit log.
 */
export async function startOutboundRunner(opts: OutboundRunnerOptions): Promise<void> {
  const idleCapMs = opts.pollIntervalMs ?? DEFAULT_IDLE_CAP_MS
  const clock = opts.now ?? (() => Date.now())
  const jitter = opts.jitter ?? (() => Math.random() * 500)

  const adapterState = new Map<string, AdapterState>()
  // Publish this runner's adapterState to the module-level registry so the
  // heartbeat probe can read circuit / rate-limit snapshots. Cleared on
  // signal abort below.
  currentAdapterStateMap = adapterState
  const idempotencyCache = new LruMap<string, string>(IDEMPOTENCY_LRU_CAP)
  // Task 39: per-conversation FIFO lanes
  const lanes = new Map<string, ConversationLane>()
  let activeSends = 0
  let lastDueBatchSize = 0
  const publishSchedulerState = (): void => {
    opts.onSchedulerState?.({
      activeSends,
      laneCount: lanes.size,
      dueBatchSize: lastDueBatchSize,
    })
  }
  const sendSemaphore = new PlatformSendSemaphore(MAX_ACTIVE_PLATFORM_SENDS, (active) => {
    activeSends = active
    publishSchedulerState()
  })
  // Jobs currently enqueued into a lane but not yet terminal. `markSending`
  // happens late (after the muted/quiet/idempotency/breaker gates), so
  // without this guard a tight drain would re-pick a job that is still
  // `pending` in the DB and double-enqueue it. The lane closure clears the
  // id in a `finally`.
  const inFlight = new Set<string>()
  // Job ids whose mute-deferral has already been audited this run. A long
  // mute defers the same job over and over; auditing each cycle floods the
  // capped audit table, so the audit fires once per job (per runner
  // lifetime). Entries are dropped when the job leaves the muted path.
  const mutedAuditedJobs = new Set<string>()
  // Last time a drain-pass DB error was audited (throttled to once/min so a
  // persistent Dexie failure is visible without flooding the audit table).
  // -Infinity ⇒ the first error always audits, whatever the injected clock.
  let lastDrainErrorAuditAt = -Infinity
  let nextStaleRecoveryAt = -Infinity

  function getAdapterState(adapterId: string, row?: AdapterInstanceRow): AdapterState {
    const tuning = sanitizeOutboundTuning(row?.outboundTuning)
    const fingerprint = JSON.stringify(tuning)
    const existing = adapterState.get(adapterId)
    // Rebuild when the per-bot tuning changed since this state was built,
    // so an operator edit applies on the next delivery without a restart.
    // Callers that pass no row (heartbeat-less paths) reuse whatever state
    // exists rather than resetting it to defaults.
    if (existing && (row === undefined || existing.tuningFingerprint === fingerprint)) {
      return existing
    }
    const state: AdapterState = {
      breaker: createCircuitBreaker({
        windowMs: tuning.breakerWindowMs,
        minEvents: tuning.breakerMinEvents,
        failureThresholdPct: tuning.breakerFailureThresholdPct,
        cooldownMs: tuning.breakerCooldownMs,
        now: clock,
        // v49 breadcrumb — emit on every state transition so the
        // operator can see breaker history in the inbox telemetry
        // export. Also write the matching `circuit.*` audit kind so the
        // Health 24h dot grid (derive-history.ts) actually colours breaker
        // transitions — it reads the audit log, not the telemetry ring, so
        // without this the declared `circuit.*` kinds stayed dead.
        onStateChange: (from, to, at) => {
          if (to === "open") {
            void trackInboxEvent("breaker.open", { adapterId, fields: { from }, at })
          } else if (to === "closed") {
            void trackInboxEvent("breaker.close", { adapterId, fields: { from }, at })
          }
          const auditKind =
            to === "open"
              ? "circuit.opened"
              : to === "half_open"
                ? "circuit.half_opened"
                : "circuit.closed"
          void appendAudit({ adapterId, kind: auditKind, at, fields: { from, to } })
        },
      }),
      bucket: createTokenBucket({
        capacity: tuning.rateCapacity,
        refillPerSec: tuning.rateRefillPerSec,
        now: clock,
      }),
      tuningFingerprint: fingerprint,
      reauthRecorded: existing?.reauthRecorded ?? false,
    }
    adapterState.set(adapterId, state)
    return state
  }

  function getLane(conversationKey: string): ConversationLane {
    const existing = lanes.get(conversationKey)
    if (existing) return existing
    const lane = new ConversationLane(() => {
      if (lane.pendingCount() === 0 && lanes.get(conversationKey) === lane) {
        lanes.delete(conversationKey)
        publishSchedulerState()
      }
    })
    lanes.set(conversationKey, lane)
    publishSchedulerState()
    return lane
  }

  /**
   * Re-enqueue `job` through the first eligible sibling of `fromRow` for
   * one of the two multi-bot reroute mechanisms:
   *
   *   - `"failover"` — this adapter's circuit is open (hard failure).
   *     Candidates come from `failoverAdapterIds`; a sibling qualifies when
   *     its breaker can pass.
   *   - `"balanced"` — this adapter's token bucket is exhausted (throughput
   *     pressure). Candidates come from `balanceAdapterIds`; a sibling
   *     qualifies when its breaker can pass AND its bucket still has send
   *     capacity (an untracked sibling counts as fresh = full bucket).
   *
   * Returns true when handled (rerouted or held by authorization), false
   * when no sibling qualifies and the caller should defer normally.
   *
   * The re-enqueued job carries a derived idempotency key (`…:fo:<id>` /
   * `…:lb:<id>`) so it can never collide with the original in the runner's
   * idempotency cache, plus the mechanism's `*FromAdapterId` marker as the
   * shared single-hop guard.
   */
  async function rerouteJob(
    job: OutboundJobRow,
    fromRow: AdapterInstanceRow,
    mechanism: "failover" | "balanced",
    request: OutboundJobRow["request"],
    adapterCache?: Map<string, AdapterInstanceRow | undefined>,
    /** This runner already holds the `sending` claim on `job`. */
    claimed = false
  ): Promise<boolean> {
    const candidates =
      (mechanism === "failover" ? fromRow.failoverAdapterIds : fromRow.balanceAdapterIds) ?? []
    if (candidates.length === 0) return false
    const now = clock()

    const persistedAddress = job.request.deliveryTarget?.address
    let parsedKey: ReturnType<typeof parseConversationKey> | undefined
    if (!persistedAddress) {
      try {
        parsedKey = parseConversationKey(job.conversationKey)
      } catch {
        // Legacy row without a complete target and with a malformed key.
        return false
      }
    }

    for (const targetId of candidates) {
      if (!targetId || targetId === job.adapterId) continue
      let targetRow: AdapterInstanceRow | undefined
      if (adapterCache?.has(targetId)) {
        targetRow = adapterCache.get(targetId)
      } else {
        targetRow = await getAdapterInstance(targetId).catch(() => undefined)
        adapterCache?.set(targetId, targetRow)
      }
      if (!targetRow || !targetRow.enabled || targetRow.muted === true) continue
      if (targetRow.type !== fromRow.type) continue
      // Skip a sibling whose own breaker is already open in this runner.
      const knownState = adapterState.get(targetId)
      if (knownState && !knownState.breaker.canPass()) continue
      // Balance additionally requires spare send capacity on the sibling:
      // spilling onto an equally-exhausted bot would just move the queue.
      // An untracked sibling has produced no outbound activity this run —
      // its bucket would initialise full, so it counts as capacity.
      if (mechanism === "balanced" && knownState && knownState.bucket.snapshot().available < 1) {
        continue
      }

      // A sibling is ready to take this work. Own the original first: another
      // runner may be sending it, and copying it now would send it twice.
      // A claim lost to another runner is that runner's job to finish.
      if (!claimed && !(await markSending(job.id, now))) return true
      const releaseClaim = () =>
        unclaimSending(
          job.id,
          mechanism === "failover" ? "circuit_open" : "rate_limited",
          "Reroute refused; the original is retried",
          now + 1_000
        )
      // Then authorize it: otherwise an unknown legacy row would acquire
      // enforce/unplanned provenance from the reroute wrapper and escape the
      // legacy recheck. A held job is handled, so callers must not defer/revive it.
      try {
        if (!(await authorizeJob(job, request, true))) return true
      } catch (error) {
        // A failed receipt or draft write rolled its own transaction back; the
        // claim must not outlive it, or the unsent job reads as in flight.
        await releaseClaim()
        throw error
      }

      const keySuffix = mechanism === "failover" ? "fo" : "lb"
      const newConversationKey = buildConversationKey(
        persistedAddress?.platform ?? parsedKey!.platform,
        targetId,
        persistedAddress?.containerId ?? parsedKey!.remoteChatId,
        persistedAddress?.topicId ?? parsedKey?.threadId
      )
      const reroutedRef = { ...job.request.conversationRef, adapterId: targetId }
      const reroutedTarget = job.request.deliveryTarget
        ? {
            ...job.request.deliveryTarget,
            address: {
              ...job.request.deliveryTarget.address,
              adapterId: targetId,
              conversationKey: newConversationKey,
            },
            conversationRef: reroutedRef,
          }
        : undefined
      let newJob: Awaited<ReturnType<typeof enqueueOutbound>>
      try {
        newJob = await enqueueOutbound(
          {
            adapterId: targetId,
            conversationKey: newConversationKey,
            request: {
              ...job.request,
              conversationRef: reroutedRef,
              ...(reroutedTarget ? { deliveryTarget: reroutedTarget } : {}),
              metadata: {
                ...job.request.metadata,
                idempotencyKey: `${job.request.metadata.idempotencyKey}:${keySuffix}:${targetId}`,
                ...(mechanism === "failover"
                  ? { failoverFromAdapterId: job.adapterId }
                  : { balancedFromAdapterId: job.adapterId }),
              },
            },
            source: job.source,
            ...(job.source === "workflow" && job.sourceWorkflow
              ? { sourceWorkflow: job.sourceWorkflow }
              : {}),
            // The same chat through a sibling bot: what authorized the original
            // job carries over, it is not planned again (ADR-0239).
            authorization: {
              kind: "rerouted",
              from: {
                conversationKey: job.conversationKey,
                ...(job.authorizedBy ? { authorizedBy: job.authorizedBy } : {}),
                ...(job.authorizationProvenance ? { provenance: job.authorizationProvenance } : {}),
              },
            },
          },
          {
            // Inherit the exact live Host job before settling the original.
            executionContext: { executionRunId: `execution:job:outbound:${job.id}` },
          }
        )
      } catch (error) {
        // The copy was refused (the mode turned to enforce after the original
        // was authorized). The original goes back to the queue, unsent, and is
        // planned next pass.
        await releaseClaim()
        if (error instanceof ConnectorDeliveryDeniedError) return true
        throw error
      }
      const reasonText = mechanism === "failover" ? "circuit open" : "rate limited"
      // Point the dead-lettered original at the sibling job that now carries
      // the delivery, so `waitForOutboundTerminal` (plugin waitForDelivery /
      // the send node) follows the reroute to the sibling's true terminal
      // status instead of misreading this reroute as a failure.
      await markDeadlettered(
        job.id,
        mechanism,
        `${mechanism === "failover" ? "Failed over" : "Balanced"} to ${targetId} (${reasonText})`,
        { toJobId: newJob.id, mechanism }
      )
      await appendAudit({
        adapterId: job.adapterId,
        kind: mechanism === "failover" ? "delivery.failover" : "delivery.balanced",
        at: now,
        conversationKey: job.conversationKey,
        idempotencyKey: job.request.metadata.idempotencyKey,
        message: `${reasonText} — re-enqueued via ${targetId}`,
        fields:
          mechanism === "failover"
            ? { failoverToAdapterId: targetId, newJobId: newJob.id }
            : { balancedToAdapterId: targetId, newJobId: newJob.id },
      })
      void trackInboxEvent(mechanism === "failover" ? "outbound.failover" : "outbound.balanced", {
        adapterId: job.adapterId,
        conversationKey: job.conversationKey,
        fields: { toAdapterId: targetId, newJobId: newJob.id },
        at: now,
      })
      return true
    }
    return false
  }

  /** Re-plan only shadow-held, unplanned or unknown legacy automation before a claim. */
  async function authorizeJob(
    job: OutboundJobRow,
    request: OutboundJobRow["request"],
    /** This runner holds the job's `sending` claim (a reroute between claim and send). */
    claimed = false
  ): Promise<boolean> {
    if (job.source === "manual" || job.source === "draft-approved") return true
    const previous = job.authorizationProvenance
    const needsPlan = previous
      ? previous.plan === "unplanned" ||
        (previous.mode === "shadow" && previous.plan !== "allow" && previous.plan !== "exempt")
      : !job.authorizedBy
    if (!needsPlan) return true

    const { readAppSettings } = await import("@/lib/policy/action-review/plan-context")
    const { readOutboundAuthorizationMode } = await import("@/lib/policy/action-review/policy")
    const settings = await (opts.settings ?? readAppSettings)()
    if (readOutboundAuthorizationMode(settings) !== "enforce") return true

    const { planDelivery, OUTBOUND_DELIVERY_POLICY_VERSION, sameChat } =
      await import("@/lib/policy/action-review/plan-delivery")
    let authorization = readStoredAuthorization(previous?.authorization)
    // Rerouting itself plans nothing. Revisit the original claim, not the
    // wrapper that would merely return the old shadow decision again.
    const visited = new Set<OutboundAuthorization>()
    while (
      authorization?.kind === "rerouted" &&
      sameChat(authorization.from.conversationKey, job.conversationKey)
    ) {
      if (visited.has(authorization)) {
        authorization = undefined
        break
      }
      visited.add(authorization)
      authorization = readStoredAuthorization(authorization.from.provenance?.authorization)
    }
    let decision: DeliveryDecision
    try {
      const input: DeliveryPlanInput = {
        adapterId: job.adapterId,
        conversationKey: job.conversationKey,
        source: job.source,
        ...(request.sendOptions?.mode ? { deliveryMode: request.sendOptions.mode } : {}),
        ...(authorization ? { authorization } : {}),
      }
      decision = await (opts.planDelivery
        ? opts.planDelivery(input)
        : planDelivery(input, { settings: () => settings }))
    } catch (error) {
      console.warn("[outbound-runner] authorization re-planning failed; holding a draft", error)
      const { outboundReceipt } = await import("@/lib/policy/action-review/outbound-receipt")
      const { conversationTarget, toReviewTarget } =
        await import("@/lib/policy/action-review/outbound-targets")
      const target = conversationTarget(job.conversationKey) ?? {
        kind: "unknown" as const,
        channel: job.adapterId,
        recipient: "*",
      }
      const sessionId =
        authorization && "sessionId" in authorization ? authorization.sessionId : undefined
      const ownerRef =
        authorization?.kind === "unattended" ? authorization.ownerRef : `source:${job.source}`
      const origin = authorization?.kind === "unattended" ? authorization.origin : undefined
      decision = {
        action: "draft",
        draftSessionId: sessionId ?? origin?.rootSessionId ?? ownerRef,
        receipt: outboundReceipt({
          requestId: `delivery:${crypto.randomUUID()}`,
          origin: {
            channel: "connector-delivery",
            scope: "connector",
            headless: true,
            ...(sessionId ? { sessionId } : {}),
            ...(origin?.rootSessionId ? { rootSessionId: origin.rootSessionId } : {}),
            ...(origin?.instructionEpoch ? { instructionEpoch: origin.instructionEpoch } : {}),
          },
          subject: {
            kind: "connector-delivery",
            ref: ownerRef,
            targets: [toReviewTarget(target)],
          },
          plan: "draft",
          enforced: true,
          outcome: "deny",
          authority: "policy-default",
          reason: "held as a draft for a person to approve: delivery planning failed",
          now: clock(),
        }),
      }
    }

    if (decision.action === "send") {
      const { toDeliveryReceiptRow } = await import("@/lib/policy/action-review/projection")
      const provenance = {
        schemaVersion: 1 as const,
        ...decision.provenance,
        mode: "enforce" as const,
        policyVersion: OUTBOUND_DELIVERY_POLICY_VERSION,
        plannedAt: clock(),
        ...(authorization ? { authorization: structuredClone(authorization) } : {}),
      }
      const updated = await updateOutboundAuthorization(
        job.id,
        provenance,
        decision.authorizedBy,
        decision.receipt ? await toDeliveryReceiptRow(decision.receipt) : undefined,
        { claimed }
      )
      if (updated) {
        job.authorizationProvenance = provenance
        job.authorizedBy = decision.authorizedBy
      }
      return updated
    }

    const draft =
      decision.action === "draft"
        ? await prepareDraftRow({
            conversationKey: job.conversationKey,
            sessionId: decision.draftSessionId,
            segments: request.segments,
            outboundPreview: {
              ...request,
              conversationRef: { ...request.conversationRef, adapterId: job.adapterId },
            },
          })
        : undefined
    // Not yet claimed: another runner may have held (or claimed) the row
    // since it was read. Only the one that holds it records the outcome.
    const held = await holdOutboundForAuthorization(job.id, {
      errorCode: draft ? "authorization" : "authorization_denied",
      message: draft
        ? `Delivery held as draft ${draft.id} for a person to approve`
        : `Delivery authorization denied: ${decision.action === "deny" ? decision.reason : "unapproved"}`,
      ...(draft ? { draft } : {}),
      claimed,
    })
    if (!held) return false
    // There is no send to pair with these observer writes, just as in the
    // gateway's draft/deny paths. Their failure must never revive the job.
    const { projectActionReviewSettled } = await import("@/lib/policy/action-review/projection")
    await projectActionReviewSettled(decision.receipt.request, decision.receipt.decision)
    await Promise.resolve(
      appendAudit({
        adapterId: job.adapterId,
        kind: draft ? "outbound.drafted" : "outbound.denied",
        at: clock(),
        conversationKey: job.conversationKey,
        idempotencyKey: request.metadata.idempotencyKey,
        fields: {
          source: job.source,
          receiptId: decision.receipt.request.requestId,
          ...(draft
            ? { draftId: draft.id }
            : { reason: decision.action === "deny" ? decision.reason : "unapproved" }),
        },
      })
    ).catch(() => undefined)
    return false
  }

  /**
   * Process a single outbound job. Called inside a conversation lane so
   * ordering is guaranteed within each conversation.
   */
  async function processJob(
    jobId: string,
    adapterId: string,
    // Per-drain caches: jobs batched in one drain pass frequently share an
    // adapter (a busy bot fanning to many conversations) or a conversation
    // (a multi-segment burst). The adapter + override rows are stable across a
    // single sub-second drain, so read each once per pass and reuse — a config
    // change (mute / quiet-hours toggle) lands on the next drain. Omitted by
    // any non-drain caller, which then reads fresh every time (current behaviour).
    adapterCache?: Map<string, AdapterInstanceRow | undefined>,
    overrideCache?: Map<string, ConversationOverrideRow | null>
  ): Promise<void> {
    const now = clock()

    // Re-fetch the job by id to get the latest state (attempts may have been
    // incremented by a prior lane execution for this same job).
    const job = await getDb().outboundQueue.get(jobId)
    if (!job) return // already processed or deleted
    if (job.status !== "pending" && job.status !== "failed") return

    const { conversationKey } = job
    const request = job.request.deliveryTarget
      ? { ...job.request, conversationRef: job.request.deliveryTarget.conversationRef }
      : { ...job.request }
    const { idempotencyKey } = request.metadata
    const ephemeral = request.metadata.larkEphemeral !== undefined
    const ephemeralAdapter = ephemeral ? opts.adapters.get(adapterId) : undefined
    if (
      ephemeral &&
      ((ephemeralAdapter &&
        (ephemeralAdapter.meta.type !== "lark" ||
          !ephemeralAdapter.meta.capabilities.includes("send.ephemeral"))) ||
        request.conversationRef.platform !== "lark" ||
        request.editTargetMessageId ||
        request.metadata.failoverFromAdapterId ||
        request.metadata.balancedFromAdapterId)
    ) {
      const message =
        "Recipient-only Lark cards require the original adapter with send.ephemeral support and cannot use normal message editing"
      await markDeadlettered(job.id, "validation", message)
      await appendAudit({
        adapterId,
        kind: "delivery.deadlettered",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "validation",
        message,
      })
      return
    }

    if (ephemeral && !ephemeralAdapter) {
      // A bot may briefly be absent while its saved credentials reload. Keep
      // the app-scoped recipient queued for that same bot, without rerouting.
      await markFailed(
        job.id,
        "adapter_not_found",
        "Lark adapter is not registered yet",
        now + 1_000
      )
      return
    }

    // ── Cross-pass FIFO guard ─────────────────────────────────────────────
    // The drain resolves the true conversation head before entering this
    // lane. Rechecking every older row here turns a 1,000-job FIFO burst into
    // an O(n²) IndexedDB scan as terminal predecessors accumulate.

    // ── Muted / quiet-hours check ─────────────────────────────────────────
    let adapterRow: AdapterInstanceRow | undefined
    if (adapterCache?.has(adapterId)) {
      adapterRow = adapterCache.get(adapterId)
    } else {
      adapterRow = await getAdapterInstance(adapterId)
      adapterCache?.set(adapterId, adapterRow)
    }
    if (adapterRow) {
      if (adapterRow.muted === true) {
        // Muted: defer (do NOT count as failure). Audit only the FIRST
        // deferral per job — a long mute re-defers the same job every
        // cycle and would otherwise flood the capped audit table.
        await markFailed(job.id, "muted", "Adapter is globally muted", now + MUTED_DEFER_MS)
        if (!mutedAuditedJobs.has(job.id)) {
          mutedAuditedJobs.add(job.id)
          await appendAudit({
            adapterId,
            kind: "delivery.error",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: "muted",
            message: "Adapter is globally muted — delivery deferred",
          })
        }
        return
      }

      // Per-conversation override beats adapter default (im-refactored-crayon
      // Phase 1.4). When the operator sets a quiet window on the override
      // row, the runner consults that instead of the adapter-level one so
      // a single Telegram bot can have different on-call windows per chat.
      let convOverride: ConversationOverrideRow | null
      if (overrideCache?.has(conversationKey)) {
        convOverride = overrideCache.get(conversationKey) ?? null
      } else {
        convOverride = (await readForResolution(conversationKey).catch(() => null)) ?? null
        overrideCache?.set(conversationKey, convOverride)
      }
      // Per-conversation mute: same defer-not-fail semantics as the adapter
      // level mute above, scoped to one conversation — the bot keeps
      // delivering everywhere else. Audited once per job, like above.
      if (convOverride?.muted === true) {
        await markFailed(job.id, "muted", "Conversation is muted", now + MUTED_DEFER_MS)
        if (!mutedAuditedJobs.has(job.id)) {
          mutedAuditedJobs.add(job.id)
          await appendAudit({
            adapterId,
            kind: "delivery.error",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: "muted",
            message: "Conversation is muted — delivery deferred",
          })
        }
        return
      }

      // Past both mute gates — forget any mute-audit marker so a future
      // re-mute of this (still-undelivered) job audits again.
      mutedAuditedJobs.delete(job.id)

      const effectiveQuietHours = convOverride?.quietHours ?? adapterRow.quietHours
      if (effectiveQuietHours) {
        const { from, to, tz } = effectiveQuietHours
        if (isInQuietRange(now, from, to, tz)) {
          const deferMs = msUntilQuietRangeEnd(now, to, tz)
          await markFailed(job.id, "quiet_hours", "Within quiet hours window", now + deferMs)
          await appendAudit({
            adapterId,
            kind: "delivery.error",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: "quiet_hours",
            message: `Within quiet hours [${from}–${to} ${tz}] — deferred ${Math.round(deferMs / 60_000)} min`,
          })
          // v49 breadcrumb
          void trackInboxEvent("quiet.deferred", {
            adapterId,
            conversationKey,
            fields: { from, to, tz, deferMs },
            at: now,
          })
          return
        }
      }
    }

    // Per-adapter breaker + bucket, built with (and live-rebuilt on changes
    // to) this bot's `outboundTuning` — the row was just read above.
    const adapterRuntime = getAdapterState(adapterId, adapterRow)
    const { breaker, bucket } = adapterRuntime

    // ── Idempotency short-circuit ─────────────────────────────────────────
    if (idempotencyCache.has(idempotencyKey)) {
      const platformMsgId = idempotencyCache.get(idempotencyKey)!
      await markSent(job.id, platformMsgId)
      try {
        opts.onDelivered?.(conversationKey)
      } catch {
        /* best-effort — cooldown bookkeeping must never break delivery */
      }
      await appendAudit({
        adapterId,
        kind: "delivery.success",
        at: now,
        conversationKey,
        idempotencyKey,
        message: "idempotency_cache_hit",
      })
      return
    }

    // ── Row-evidence dedupe (persistent idempotency) ──────────────────────
    // The LRU above is in-memory only — a rebooted runner starts empty. Two
    // durable evidence sources close (most of) the duplicate window:
    //   1. This row already carries a `platformMessageId` (a prior attempt's
    //      `markSent` landed but the status was later rewound, e.g. an
    //      operator replay): the platform HAS the message — finish the
    //      bookkeeping, never re-send.
    //   2. A sibling row with the same idempotencyKey already delivered
    //      (indexed lookup): serve this row from that evidence, exactly
    //      like an LRU hit.
    // Neither closes the crash window between a successful `adapter.send()`
    // and `markSent` (the ack died with the runner, so no local evidence
    // exists). That window is closed PLATFORM-SIDE by the idempotency
    // contract declared in `ambiguousDelivery` (types/connectors/
    // runtime-capability.ts):
    //   - `remote_idempotent` — the adapter forwards `idempotencyKey` as the
    //     platform's per-message token, so a retry returns the ORIGINAL
    //     message instead of a duplicate: Lark message-create `uuid`,
    //     Matrix `PUT …/send/{type}/{txnId}`, Discord `nonce` +
    //     `enforce_nonce: true` (`discordNonce`, one per chunk / lane).
    //   - `reconciliation_required` — no such token (Slack, Telegram, OneBot,
    //     WeCom, WeChat, DingTalk, QQ): a retry after a lost ack MAY
    //     duplicate; the audit trail + `delivery_unknown` status are what the
    //     operator reconciles against. QQ is a special case — its passive
    //     `msg_seq` is derived from the key, so the retry is REJECTED by the
    //     platform (dead-lettered `platform_4xx`) rather than delivered twice.
    const rowEvidence =
      job.platformMessageId ??
      (await findDeliveredByIdempotencyKey(idempotencyKey, job.id).catch(() => undefined))
        ?.platformMessageId
    if (rowEvidence) {
      await markSent(job.id, rowEvidence)
      idempotencyCache.set(idempotencyKey, rowEvidence)
      try {
        opts.onDelivered?.(conversationKey)
      } catch {
        /* best-effort — cooldown bookkeeping must never break delivery */
      }
      await appendAudit({
        adapterId,
        kind: "delivery.success",
        at: now,
        conversationKey,
        idempotencyKey,
        message: "row_evidence_hit",
      })
      return
    }

    // ── Plugin onConnectorOutbound (observe + veto + transform) ───────────
    // Fires once per job (first attempt only) so a retry reuses the persisted
    // transform without re-dispatching. A `block` drops the job entirely; a
    // `transform` rewrites the segments AFTER passing the fail-closed PII gate
    // (a leaking rewrite is rejected, the original kept). Plugin errors never
    // break delivery.
    if (job.attempts === 0) {
      try {
        let platform = ""
        try {
          platform =
            request.deliveryTarget?.address.platform ??
            parseConversationKey(conversationKey).platform
        } catch {
          platform = ""
        }
        const decision = await getPluginEventHooks().dispatchConnectorDecision(
          "onConnectorOutbound",
          {
            adapterId,
            conversationKey,
            platform,
            segments: request.segments,
            source: job.source,
            idempotencyKey,
            // Terminal-card marker a producer may stamp so result-card
            // middleware can find "the" card without parsing segment JSON.
            ...(request.metadata.resultCard ? { resultCard: request.metadata.resultCard } : {}),
          }
        )
        if (decision.action === "block") {
          await deleteOutboundJob(job.id)
          await appendAudit({
            adapterId,
            kind: "plugin.outbound_blocked",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: decision.reason ?? "plugin_blocked",
          })
          return
        }
        if (decision.action === "transform") {
          const segments = decision.segments as MessageSegment[]
          if (hasNoLeakingPiiDeep(segments)) {
            request.segments = enforceTwinDisclosureFromProvenance(
              segments,
              request.metadata.provenance
            )
            await getDb().outboundQueue.update(job.id, { request })
            await appendAudit({
              adapterId,
              kind: "plugin.outbound_transformed",
              at: now,
              conversationKey,
              idempotencyKey,
            })
          } else {
            await appendAudit({
              adapterId,
              kind: "plugin.transform_pii_blocked",
              at: now,
              conversationKey,
              idempotencyKey,
              reason: "outbound_transform_pii",
            })
          }
        }
      } catch (err) {
        console.error("[outbound-runner] onConnectorOutbound dispatch failed", err)
      }
    }

    // ── Circuit breaker ───────────────────────────────────────────────────
    if (!breaker.canPass()) {
      // Multi-bot failover: before deferring, try to re-enqueue the payload
      // through an enabled same-platform sibling from this bot's
      // `failoverAdapterIds`. Single hop only — a job that already failed
      // over once (metadata guard) stays put so two open-circuit bots can't
      // ping-pong it forever.
      if (
        !ephemeral &&
        adapterRow &&
        request.metadata.failoverFromAdapterId === undefined &&
        request.metadata.balancedFromAdapterId === undefined
      ) {
        if (await rerouteJob(job, adapterRow, "failover", request, adapterCache)) return
      }
      // An open breaker is a TRANSIENT adapter condition, not a property of
      // this job: DEFER until the cooldown ends (plus jitter so the whole
      // backlog doesn't stampede the half-open probe), never dead-letter.
      // `markFailed` leaves `attempts` untouched, so breaker deferrals
      // don't consume the max-attempts budget; jobs that genuinely exceed
      // it still dead-letter via the max-attempts gate below.
      const cooldownMs = sanitizeOutboundTuning(adapterRow?.outboundTuning).breakerCooldownMs
      const openedAt = breaker.snapshot().openedAt
      const nextAt = Math.max(now + 1_000, (openedAt ?? now) + cooldownMs) + jitter()
      await markFailed(job.id, "circuit_open", "Circuit breaker is open — deferred", nextAt)
      await appendAudit({
        adapterId,
        kind: "delivery.error",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "circuit_open",
        message: `Circuit breaker is open — deferred ${Math.max(0, Math.round((nextAt - now) / 1000))}s`,
      })
      return
    }

    // ── Dead-letter gate: max attempts ────────────────────────────────────
    // Bookkeeping only — no wire event happened here, so the breaker's
    // failure window is NOT fed (a burst of maxed-out retry jobs must not
    // open the circuit by itself).
    if (job.attempts >= MAX_ATTEMPTS) {
      await markDeadlettered(job.id, "max_attempts", `Exceeded ${MAX_ATTEMPTS} attempts`)
      await appendAudit({
        adapterId,
        kind: "delivery.deadlettered",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "max_attempts",
      })
      return
    }

    const deferRateLimit = async (claimed: boolean): Promise<void> => {
      // Multi-bot load balancing: before deferring behind the exhausted
      // bucket, try to spill the job onto a same-platform sibling from this
      // bot's `balanceAdapterIds` that still has send capacity. Single hop
      // only (shared guard with failover) so saturated bots can't ping-pong.
      // (`rerouteJob` dead-letters the original with a reroute pointer, so
      // the `sending` claim needs no separate rollback on this path.)
      if (
        !ephemeral &&
        adapterRow &&
        request.metadata.failoverFromAdapterId === undefined &&
        request.metadata.balancedFromAdapterId === undefined
      ) {
        if (await rerouteJob(job, adapterRow, "balanced", request, adapterCache, claimed)) return
      }
      // Defer retry by 1 second (the lane-completion wake re-tightens the
      // loop's sleep so the runner re-picks once the deferral elapses).
      // `unclaimSending` refunds the attempt `markSending` charged — a
      // rate-limit deferral is not a delivery attempt.
      const nextAt = now + 1_000
      if (claimed) await unclaimSending(job.id, "rate_limited", "Token bucket exhausted", nextAt)
      // Unclaimed, another runner may hold the row by now: defer it only while
      // it is still waiting, never by rewriting that runner's `sending` claim.
      else if (!(await deferUnclaimed(job.id, "rate_limited", "Token bucket exhausted", nextAt)))
        return
      await appendAudit({
        adapterId,
        kind: "rate_limit.tripped",
        at: now,
        conversationKey,
        idempotencyKey,
      })
    }

    // Check capacity without spending a token before planning. Deferred jobs
    // must not mint a new authorization receipt every runner cycle.
    if (bucket.snapshot().available < 1) {
      await deferRateLimit(false)
      return
    }
    if (!(await authorizeJob(job, request))) return

    // ── Send ──────────────────────────────────────────────────────────────
    // Atomic claim: if another runner already moved this job out of
    // pending/failed, yield rather than double-send the same message.
    // Claimed BEFORE the token bucket so a lost claim never consumes a
    // rate-limit token.
    const claimed = await markSending(job.id, now)
    if (!claimed) {
      return
    }

    // A different lane may consume capacity while authorization is awaited.
    if (!bucket.tryAcquire()) {
      await deferRateLimit(true)
      return
    }

    // ── Pending message placement (ADR-0239) ──────────────────────────────
    // A plugin's reply or edit target that could not be placed in its
    // conversation when the job was queued is placed now, by the same
    // evidence (`message-placement.ts`) and the running adapter. Elsewhere
    // or unplaceable: dead-lettered. Still unavailable, the bot not running
    // included: retried like a network failure, so it ends at the attempt
    // limit.
    const pendingPlacement = request.metadata.pendingPlacement ?? []
    const deferPlacement = async (
      pointer: (typeof pendingPlacement)[number],
      platform: string
    ): Promise<void> => {
      const message = `Cannot place ${pointer.use} target ${pointer.messageId} in ${conversationKey} yet`
      await markFailed(
        job.id,
        "placement_unavailable",
        message,
        now +
          computeBackoffDelay(job.attempts, {
            baseDelayMs: BASE_BACKOFF_MS,
            maxDelayMs: MAX_BACKOFF_MS,
            jitter: { kind: "absolute", amountMs: jitter },
          })
      )
      await appendAudit({
        adapterId,
        kind: "delivery.error",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "placement_unavailable",
        message,
      })
      void trackEvent("connector.message.sent", {
        adapterId,
        platform,
        outcome: "failed",
        errorCode: "placement_unavailable",
      })
    }

    const adapter = opts.adapters.get(adapterId)
    if (!adapter && pendingPlacement.length > 0) {
      await deferPlacement(pendingPlacement[0]!, "unknown")
      return
    }
    if (!adapter) {
      await markDeadlettered(job.id, "adapter_not_found", `Adapter ${adapterId} not registered`)
      await appendAudit({
        adapterId,
        kind: "delivery.deadlettered",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "adapter_not_found",
      })
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: "unknown",
        outcome: "failed",
        errorCode: "adapter_not_found",
      })
      return
    }

    for (const pointer of pendingPlacement) {
      const placement = await placeMessage(
        { ...pointer, adapterId, conversationKey, conversationRef: request.conversationRef },
        { getAdapter: () => adapter }
      )
      if (placement === "within") continue
      if (placement === "unavailable") {
        await deferPlacement(pointer, adapter.meta.type)
        return
      }
      const reason = placement === "elsewhere" ? "destination_foreign" : "destination_unplaced"
      const message =
        placement === "elsewhere"
          ? `The ${pointer.use} target ${pointer.messageId} is in another chat than ${conversationKey}`
          : `The ${pointer.use} target ${pointer.messageId} cannot be placed in ${conversationKey}`
      await markDeadlettered(job.id, reason, message)
      await appendAudit({
        adapterId,
        kind: "delivery.deadlettered",
        at: now,
        conversationKey,
        idempotencyKey,
        reason,
        message,
      })
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: adapter.meta.type,
        outcome: "failed",
        errorCode: reason,
      })
      return
    }

    // Host-owned Twin provenance survives draft edits and plugin transforms.
    // Re-assert the visible disclosure at the final external sink.
    request.segments = enforceTwinDisclosureFromProvenance(
      request.segments,
      request.metadata.provenance
    )

    const unsupportedFeature = validateOutboundFeatures(adapter, request)
    if (unsupportedFeature?.error) {
      await markDeadlettered(
        job.id,
        unsupportedFeature.error.code,
        unsupportedFeature.error.message
      )
      await appendAudit({
        adapterId,
        kind: "delivery.deadlettered",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: unsupportedFeature.error.code,
        message: unsupportedFeature.error.message,
      })
      return
    }

    // Only the Host enqueue's exact job execution is proof. Serialized source,
    // message ids and result-card metadata cannot mint or recover admission.
    const deliveryRun = await getDb().executionRuns.get(`execution:job:outbound:${job.id}`)
    const identityOptions: AdapterSendOptions | undefined = deliveryRun?.sessionId
      ? { executionIdentity: { sessionId: deliveryRun.sessionId, runId: deliveryRun.id } }
      : undefined

    // Edit-vs-send dispatch. When the request carries an
    // `editTargetMessageId`, route to `adapter.edit()` so the platform
    // updates the existing message in place. Adapters that don't
    // implement `edit()` fall back to `send()` and audit the fallback so
    // the caller can detect "you asked for in-place edit but this
    // platform can't do it".
    let result: Awaited<ReturnType<PlatformAdapter["send"]>>
    const editTargetId = request.editTargetMessageId
    try {
      if (editTargetId && typeof adapter.edit === "function") {
        result = await sendSemaphore.run(() => adapter.edit!(editTargetId, request))
      } else {
        if (editTargetId) {
          await appendAudit({
            adapterId,
            kind: "delivery.error",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: "edit_unsupported",
            message: `${adapterId} adapter has no edit() — falling back to send()`,
          })
        }
        result = await sendSemaphore.run(() =>
          adapter.meta.capabilities.includes("events.delivery-status")
            ? adapter.send(request, {
                ...identityOptions,
                onPendingReceipt: async (receipt) => {
                  await markAwaitingDeliveryReceipt(job.id, receipt)
                },
              })
            : identityOptions
              ? adapter.send(request, identityOptions)
              : adapter.send(request)
        )
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (ephemeral || adapter.runtimeCapabilities?.ambiguousDelivery !== "remote_idempotent") {
        await markDeliveryUnknown(job.id, "delivery_unknown", msg)
        breaker.recordFailure()
        await appendAudit({
          adapterId,
          kind: "delivery.error",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: "delivery_unknown",
          message: msg,
        })
        void trackEvent("connector.message.sent", {
          adapterId,
          platform: adapter.meta.type,
          outcome: "failed",
          errorCode: err instanceof Error ? err.name : "Error",
        })
        return
      }
      const backoff = computeBackoffDelay(job.attempts, {
        baseDelayMs: BASE_BACKOFF_MS,
        maxDelayMs: MAX_BACKOFF_MS,
        jitter: { kind: "absolute", amountMs: jitter },
      })
      await markFailed(job.id, "network", msg, now + backoff)
      breaker.recordFailure()
      await appendAudit({
        adapterId,
        kind: "delivery.error",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "network",
        message: msg,
      })
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: adapter.meta.type,
        outcome: "failed",
        errorCode: err instanceof Error ? err.name : "Error",
      })
      return
    }

    if (!result.ok && result.pendingReceipt) {
      const settled = await markAwaitingDeliveryReceipt(job.id, result.pendingReceipt)
      if (settled?.status === "sent") {
        try {
          opts.onDelivered?.(conversationKey)
        } catch {
          /* best effort */
        }
        breaker.recordSuccess()
      } else if (settled?.status === "delivery_unknown") {
        await appendAudit({
          adapterId,
          kind: "delivery.pending",
          at: now,
          conversationKey,
          idempotencyKey,
          fields: { receiptId: result.pendingReceipt.id, jobId: job.id },
        })
      }
      return
    }
    if (result.ok) {
      const platformMsgId = result.platformMessageId ?? idempotencyKey
      await markSent(job.id, platformMsgId)
      // Delivered-message ledger (exact `reply-to-bot` rule): only a REAL
      // platform id counts — the idempotencyKey fallback is never something a
      // user can reply to. Best-effort, never throws.
      if (result.platformMessageId || result.platformChatId) {
        await recordDeliveredMessage(
          adapterId,
          conversationKey,
          result.platformMessageId ?? "",
          result.platformChatId
        )
      }
      try {
        opts.onDelivered?.(conversationKey)
      } catch {
        /* best-effort — cooldown bookkeeping must never break delivery */
      }
      breaker.recordSuccess()
      adapterRuntime.reauthRecorded = false
      idempotencyCache.set(idempotencyKey, platformMsgId)
      await appendAudit({
        adapterId,
        kind: "delivery.success",
        at: now,
        conversationKey,
        idempotencyKey,
      })
      // Clear the response-SLA deadline now that a reply has gone out (CRM,
      // schema v83). No-op when the conversation has no SLA / override row.
      await markResponded(conversationKey, now).catch(() => undefined)
      // v49 breadcrumb
      void trackInboxEvent("outbound.sent", {
        adapterId,
        conversationKey,
        fields: { jobId: job.id, attempts: job.attempts + 1 },
        at: now,
      })
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: adapter.meta.type,
        outcome: "succeeded",
      })
    } else {
      const err = result.error!
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: adapter.meta.type,
        outcome: "failed",
        errorCode: err.code,
      })
      // The credential (bot or user identity) was rejected after the
      // adapter's own refresh-and-retry-once. The breaker still counts it —
      // an open breaker defers the backlog instead of dead-lettering it — but
      // the Health surfaces need to say "re-authenticate", not "breaker open".
      if (isReauthCode(err.code) && !adapterRuntime.reauthRecorded) {
        adapterRuntime.reauthRecorded = true
        await appendAudit({
          adapterId,
          kind: "adapter.reauth_required",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: err.code,
          message: err.message,
        })
      }
      if (err.code === "identity_reauthorization_required") {
        const resolution = await readForResolution(conversationKey).catch(() => null)
        if (resolution?.sessionId) {
          const draft = await createDraft({
            conversationKey,
            sessionId: resolution.sessionId,
            segments: request.segments,
            sourceMessageId: request.metadata.sourceMessageId,
            outboundPreview: request,
          })
          await appendAudit({
            adapterId,
            kind: "draft.prepared",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: err.code,
            message: "Reply saved as a draft; reconnect the user identity before approval",
            fields: { draftId: draft.id },
          })
        }
        await markDeadlettered(job.id, err.code, err.message)
        await appendAudit({
          adapterId,
          kind: "delivery.deadlettered",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: err.code,
          message: err.message,
        })
        return
      }
      const ambiguousRemoteFailure =
        err.code === "delivery_unknown" ||
        err.code === "reconciliation_required" ||
        ((ephemeral ||
          adapter.runtimeCapabilities?.ambiguousDelivery === "reconciliation_required") &&
          (err.code === "network" || err.code === "platform_5xx"))
      if (ambiguousRemoteFailure) {
        await markDeliveryUnknown(job.id, "delivery_unknown", err.message)
        breaker.recordFailure()
        await appendAudit({
          adapterId,
          kind: "delivery.error",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: "delivery_unknown",
          message: err.message,
        })
      } else if (err.retryable) {
        const retryAfter = err.retryAfterMs ?? 0
        const backoff =
          computeBackoffDelay(job.attempts, {
            baseDelayMs: BASE_BACKOFF_MS,
            maxDelayMs: MAX_BACKOFF_MS,
            jitter: { kind: "absolute", amountMs: jitter },
          }) + retryAfter
        await markFailed(job.id, err.code, err.message, now + backoff)
        // Platform rate limiting (429) is back-pressure, not adapter
        // failure: feeding it to the breaker would let a transient 429
        // storm open the circuit and stall the whole backlog.
        if (err.code !== "rate_limited") {
          breaker.recordFailure()
        }
        await appendAudit({
          adapterId,
          kind: "delivery.error",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: err.code,
          message: err.message,
        })
        void trackInboxEvent("outbound.failed", {
          adapterId,
          conversationKey,
          fields: { code: err.code, retryable: true, attempts: job.attempts + 1 },
          at: now,
        })
      } else {
        // Non-retryable — dead-letter immediately
        await markDeadlettered(job.id, err.code, err.message)
        if (err.code !== "rate_limited") {
          breaker.recordFailure()
        }
        await appendAudit({
          adapterId,
          kind: "delivery.deadlettered",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: err.code,
          message: err.message,
        })
        void trackInboxEvent("outbound.failed", {
          adapterId,
          conversationKey,
          fields: { code: err.code, retryable: false, attempts: job.attempts + 1 },
          at: now,
        })
      }
    }
  }

  // ── Wake coordination ───────────────────────────────────────────────────
  //
  // The loop sleeps until the next thing that could change what's actionable:
  // a fresh enqueue (external event) or the next retry deadline (timeout). A
  // completed lane also wakes it so a job rescheduled to a sooner deadline
  // (rate-limit 1s defer, etc.) re-tightens the sleep. `pendingWake` guards
  // against a wake that lands between two waits (lost-wakeup). This mirrors
  // the `Notify` + sleep-until-next-deadline shape of the Rust cron daemon.
  let pendingWake = false
  let wakeResolver: (() => void) | null = null
  const wake = (): void => {
    pendingWake = true
    const r = wakeResolver
    wakeResolver = null
    if (r) r()
  }
  const waitForWakeOrTimeout = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (pendingWake || opts.signal.aborted) {
        pendingWake = false
        resolve()
        return
      }
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal.removeEventListener("abort", settle)
        wakeResolver = null
        pendingWake = false
        resolve()
      }
      const timer = setTimeout(settle, ms)
      wakeResolver = settle
      opts.signal.addEventListener("abort", settle, { once: true })
    })

  // Wake on every enqueue (any of the ai-run / manual / workflow / draft
  // paths). Unsubscribed in the `finally` below.
  const unsubscribeEnqueue = subscribeOutboundEnqueued(wake)

  // ── Wake-driven loop ──────────────────────────────────────────────────────
  try {
    await reconcileOutboundJobExecutions()
    while (!opts.signal.aborted) {
      // CRM (v83): reopen snoozed conversations whose snooze window has
      // elapsed, so a snooze wakes on schedule even when no inbound arrives.
      // Runs each loop tick (≤ idle cap); best-effort — a failure here must
      // never stall outbound delivery.
      await wakeSnoozedConversations(clock()).catch(() => undefined)

      // Stale-claim recovery (startup + every five minutes): flip `sending` rows
      // orphaned by a crashed/reloaded runner (claimed > 5 min ago, never
      // settled) back to `failed` so this drain can retry them. Best-effort;
      // audited per recovered row. `inFlight` jobs are claimed seconds ago
      // and sit safely inside the grace window.
      if (clock() >= nextStaleRecoveryAt) {
        try {
          const recoveredRows = await recoverStaleSendingJobs(clock())
          for (const row of recoveredRows) {
            const recoveredAdapter = opts.adapters.get(row.adapterId)
            if (
              row.request.metadata.larkEphemeral !== undefined ||
              recoveredAdapter?.runtimeCapabilities?.ambiguousDelivery !== "remote_idempotent"
            ) {
              await markDeliveryUnknown(
                row.id,
                "stale_sending_delivery_unknown",
                "The runner stopped while delivery was in flight; reconcile before retrying"
              )
              await appendAudit({
                adapterId: row.adapterId,
                kind: "delivery.error",
                at: clock(),
                conversationKey: row.conversationKey,
                idempotencyKey: row.idempotencyKey,
                reason: "delivery_unknown",
                message: "Stale send has an ambiguous remote outcome and requires reconciliation",
              }).catch(() => undefined)
              continue
            }
            await appendAudit({
              adapterId: row.adapterId,
              kind: "delivery.error",
              at: clock(),
              conversationKey: row.conversationKey,
              idempotencyKey: row.idempotencyKey,
              reason: "stale_sending_recovered",
              message: "Recovered a stale sending claim — retrying now",
            }).catch(() => undefined)
          }
          nextStaleRecoveryAt = clock() + STALE_RECOVERY_INTERVAL_MS
        } catch (err) {
          console.error("[outbound-runner] stale-sending recovery failed:", err)
          nextStaleRecoveryAt = clock() + STALE_RECOVERY_INTERVAL_MS
        }
      }

      // Drain everything currently due into per-conversation lanes in one
      // pass. Lanes run concurrently across conversations and FIFO within
      // one; the `inFlight` guard prevents re-enqueuing a job that is still
      // `pending` while its lane spins up.
      try {
        const drainNow = clock()
        const due = await listDueNow({ now: drainNow })
        lastDueBatchSize = due.length
        publishSchedulerState()
        // Per-drain caches shared across all jobs scheduled in this pass so a
        // busy adapter / conversation reads its (stable) adapter + override row
        // once instead of once per job. Recreated each pass → bounded staleness.
        const adapterCache = new Map<string, AdapterInstanceRow | undefined>()
        const overrideCache = new Map<string, ConversationOverrideRow | null>()
        const heads = new Map<string, OutboundJobRow>()
        for (const job of due) {
          const current = heads.get(job.conversationKey)
          if (
            !current ||
            (job.orderSeq ?? job.createdAt) < (current.orderSeq ?? current.createdAt)
          ) {
            heads.set(job.conversationKey, job)
          }
        }
        // The due index is ordered by retry deadline, not conversation FIFO.
        // When more than one batch of same-millisecond jobs belongs to one
        // conversation, its true orderSeq head may fall outside this 128-row
        // window. Resolve that oldest active row directly instead of repeatedly
        // deferring arbitrary later candidates until the random primary-key tie
        // order happens to surface the head.
        const resolvedHeads = await Promise.all(
          Array.from(heads.values(), async (candidate) => {
            if ((lanes.get(candidate.conversationKey)?.pendingCount() ?? 0) > 0) return undefined
            const older = await findOlderActiveOutboundSibling(candidate)
            if (!older) return candidate
            if (
              older.status === "sending" ||
              older.status === "delivery_unknown" ||
              older.nextAttemptAt > drainNow
            )
              return undefined
            return older
          })
        )
        for (const job of resolvedHeads) {
          if (!job) continue
          if (inFlight.has(job.id)) continue
          inFlight.add(job.id)
          const { conversationKey } = job
          getLane(conversationKey).enqueue(async () => {
            let current: OutboundJobRow | undefined = job
            let processed = 0
            try {
              while (current && processed < OUTBOUND_DUE_BATCH_SIZE) {
                const currentId: string = current.id
                await processJob(currentId, current.adapterId, adapterCache, overrideCache)
                inFlight.delete(currentId)
                processed += 1

                const settled: OutboundJobRow | undefined =
                  await getDb().outboundQueue.get(currentId)
                if (!settled || !isOutboundTerminal(settled.status, settled.pendingReceipt)) break
                const next: OutboundJobRow | undefined = await findNextActiveOutboundSibling(
                  settled
                ).catch(() => undefined)
                if (
                  !next ||
                  next.status === "sending" ||
                  next.status === "delivery_unknown" ||
                  next.nextAttemptAt > clock() ||
                  inFlight.has(next.id)
                ) {
                  break
                }
                inFlight.add(next.id)
                current = next
              }
            } finally {
              if (current) inFlight.delete(current.id)
              // Re-evaluate: the job may have been rescheduled to a sooner
              // deadline than the loop is currently sleeping for.
              wake()
            }
          })
        }
      } catch (err) {
        // Transient DB errors self-heal on the next pass, but a PERSISTENT
        // Dexie failure must be visible: log every occurrence and audit at
        // most once per minute (`adapter.error` under the runner pseudo-id).
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[outbound-runner] drain pass failed:", msg)
        const nowMs = clock()
        if (nowMs - lastDrainErrorAuditAt >= DRAIN_ERROR_AUDIT_THROTTLE_MS) {
          lastDrainErrorAuditAt = nowMs
          await appendAudit({
            adapterId: RUNNER_AUDIT_ADAPTER_ID,
            kind: "adapter.error",
            at: nowMs,
            reason: "drain_failed",
            message: msg,
          }).catch(() => undefined)
        }
      }

      if (opts.signal.aborted) break

      // Sleep until the next future retry deadline, capped by the idle
      // ceiling. `undefined` means nothing is scheduled — sleep the full cap
      // and rely on the enqueue/lane wake to fire sooner.
      let sleepMs = idleCapMs
      try {
        const nextAt = await peekNextWakeAt(clock())
        if (typeof nextAt === "number") {
          sleepMs = Math.max(0, Math.min(idleCapMs, nextAt - clock()))
        }
      } catch {
        // Fall back to the idle cap on a transient read error.
      }

      if (opts.signal.aborted) break
      await waitForWakeOrTimeout(sleepMs)
    }
  } finally {
    unsubscribeEnqueue()
    // Surrender ownership of the runtime-state registry only if we still own
    // it. A second runner instance (test scenarios) may have replaced us
    // while we were running; in that case the registry already points at
    // the newer Map and we must not clobber it back to null.
    if (currentAdapterStateMap === adapterState) {
      currentAdapterStateMap = null
    }
  }
}
