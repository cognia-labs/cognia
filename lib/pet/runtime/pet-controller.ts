// The side-effecting orchestration glue: consumes PetEvents from the bus,
// persists the progression (XP/needs/level/stage), drives the visual state +
// one-shot queue in the store, and records newly-unlocked achievements. Events
// are serialized through a promise chain so rapid bursts can't race the
// read-modify-write of the singleton profile.
//
// Bubbles are intentionally NOT handled here — the widget subscribes to the bus
// separately for ephemeral bubble display (it needs the React i18n context).

import type {
  PetActivityRow,
  PetEvent,
  PetEventKind,
  PetProfile,
  PetVisualState,
} from "@/types/pet"
import { effectiveStats } from "@/types/pet"
import { PET_ACTIVITY_CAP } from "@/lib/db/pet"
import { getDb, onActiveDatabaseChange } from "@/lib/db/schema"
import { recordTombstones } from "@/lib/db/tombstones"
import { generateBones } from "@/lib/pet/bones/generate"
import { reducePetVisualState, restingWithCare } from "@/lib/pet/state/reducer"
import { applyPetEvent, INTERACTION_KINDS } from "@/lib/pet/runtime/apply-event"
import { canInteract, normalizeInteractionGate } from "@/lib/pet/interaction/gate"
import { coinMultiplier, computeStreakFromLedger } from "@/lib/pet/economy/streak"
import { CHAOS_BURST_COUNT } from "@/lib/pet/stats/growth-table"
import { xpForEvent } from "@/lib/pet/xp/award-table"
import { checkAchievements } from "@/lib/pet/achievements/check"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import {
  assertPetScopeCurrent,
  capturePetScope,
  enqueuePetWork,
  isPetScopeCurrent,
  onPetReset,
  PetScopeInvalidatedError,
  whenPetEventsSettled,
} from "@/lib/pet/runtime/pet-scope"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { usePetStore } from "@/stores/pet/pet-store"
import { loggers } from "@cognia/logging"

export { enqueuePetWork, whenPetEventsSettled }

/**
 * Event kinds whose resting state should honor a persistent care condition.
 * Only low-signal ambient kinds with no expressive state of their own belong
 * here — kinds that map to an expressive state in `reducePetVisualState`
 * (e.g. `twinBusy` → thinking, `twinMilestone` and `radarReport` → happy) must
 * NOT be listed, or `restingWithCare` would suppress those states and make the
 * reducer cases dead.
 */
const PASSIVE_KINDS = new Set<PetEventKind>([
  "idle",
  "inboundMessage",
  "scheduledRun",
  // A due reminder maps to restingFromNeeds (the punch comes from the reminder
  // hook's one-shot), so honor the care condition like the other passive kinds.
  // scheduledRunStarting is NOT here — it maps to the expressive "thinking".
  "scheduledRunDue",
])

/** Lifecycle kinds the controller re-emits — never re-emit while handling one. */
const LIFECYCLE_EMIT_KINDS = new Set<PetEventKind>(["levelUp", "evolved", "unwell", "streakDay"])

/** Last processed non-passive event kind — drives the error→success "recovered" signal. */
let lastEventKind: PetEventKind | null = null

/**
 * Unresolved work channels whose active state must survive passive heartbeats
 * and unrelated sources returning to `idle` (F3). Priority: waiting > thinking.
 */
const activeWorkStates = new Map<string, "waiting" | "thinking">()

let nextOperationSeq = 0

/**
 * Events already committed atomically by `commitPetEvent` and then published on
 * the bus for bubble/speech observers. `handlePetEvent` skips them so the
 * controller never double-applies one committed operation.
 */
const committedBusEvents = new WeakSet<PetEvent>()

export function resetPetControllerRuntimeState(): void {
  lastEventKind = null
  activeWorkStates.clear()
}

onPetReset(() => {
  resetPetControllerRuntimeState()
  usePetStore.setState({
    visualState: "idle",
    oneShotQueue: [],
    bubble: null,
    lastGrewStats: [],
    careAlert: null,
    interactionRefusal: null,
    profileSnapshot: null,
  })
})
onActiveDatabaseChange(resetPetControllerRuntimeState)

function updateActiveWorkState(event: PetEvent): void {
  switch (event.source) {
    case "attention": {
      if (event.kind === "waiting") activeWorkStates.set("attention", "waiting")
      else if (event.kind === "review" || event.kind === "idle" || event.kind === "success") {
        activeWorkStates.delete("attention")
      }
      return
    }
    case "capture": {
      if (event.kind === "waiting") activeWorkStates.set("capture", "waiting")
      else if (event.kind === "idle" || event.kind === "success") {
        activeWorkStates.delete("capture")
      }
      return
    }
    case "chat": {
      const key =
        typeof event.meta?.sessionId === "string" ? `chat:${event.meta.sessionId}` : "chat"
      if (event.kind === "waiting") activeWorkStates.set(key, "waiting")
      else if (event.kind === "thinking") activeWorkStates.set(key, "thinking")
      else if (
        event.kind === "review" ||
        event.kind === "idle" ||
        event.kind === "error" ||
        event.kind === "success"
      ) {
        activeWorkStates.delete(key)
      }
      return
    }
    case "background-task": {
      if (event.kind === "thinking") activeWorkStates.set("background-task", "thinking")
      else if (event.kind === "success" || event.kind === "error" || event.kind === "idle") {
        activeWorkStates.delete("background-task")
      }
      return
    }
    case "terminal": {
      if (event.kind === "thinking") activeWorkStates.set("terminal", "thinking")
      else if (event.kind === "success" || event.kind === "error" || event.kind === "idle") {
        activeWorkStates.delete("terminal")
      }
      return
    }
    case "agent-team": {
      if (event.kind === "teamRun") activeWorkStates.set("agent-team", "thinking")
      else if (event.kind === "success" || event.kind === "error" || event.kind === "idle") {
        activeWorkStates.delete("agent-team")
      }
      return
    }
    case "twin": {
      const key = typeof event.meta?.twinId === "string" ? `twin:${event.meta.twinId}` : "twin"
      if (event.kind === "twinBusy") activeWorkStates.set(key, "thinking")
      else if (event.kind === "idle") activeWorkStates.delete(key)
      return
    }
    case "workflow": {
      const key =
        typeof event.meta?.runId === "string" ? `workflow:${event.meta.runId}` : "workflow"
      if (event.kind === "workflowRun") activeWorkStates.set(key, "thinking")
      else if (event.kind === "success" || event.kind === "error" || event.kind === "idle") {
        activeWorkStates.delete(key)
      }
      return
    }
    default:
      return
  }
}

function resolveActiveWorkVisualState(): PetVisualState | null {
  let hasThinking = false
  for (const state of activeWorkStates.values()) {
    if (state === "waiting") return "waiting"
    if (state === "thinking") hasThinking = true
  }
  return hasThinking ? "thinking" : null
}

export type PetCommitFailureReason =
  | "uninitialized"
  | "not-hatched"
  | "cooldown"
  | "item-not-owned"
  | "scope-invalidated"
  | "storage-error"

export type PetCommitOutcome =
  | {
      ok: true
      opId: string
      grantedXp: number
      grantedCoins: number
      profile: PetProfile
    }
  | {
      ok: false
      reason: PetCommitFailureReason
      readyAtMs?: number
      error?: unknown
    }

export interface CommitPetEventOptions {
  /**
   * Decrement this owned consumable item inside the exact same Dexie
   * transaction as the profile and activity ledger update (F16/F18).
   */
  consumeItemId?: string
  /**
   * Publish the committed event onto `PetEventBus` (marked so `handlePetEvent`
   * ignores it) so bubble/proactive hooks react normally.
   */
  emitOnBus?: boolean
  /**
   * When false, do not write an interaction-refusal bubble signal into
   * `usePetStore` (used by remote/automated callers that report refusals directly).
   */
  signalRefusal?: boolean
  /**
   * When true, already running inside an outer `enqueuePetWork` turn; execute
   * directly without nesting into `enqueuePetWork` (which would deadlock).
   */
  alreadySerialized?: boolean
  /** Scope captured at call time so queued work is fenced by a later reset or account switch. */
  scope?: ReturnType<typeof capturePetScope>
}

async function runCommittedEvent(
  event: PetEvent,
  opts: CommitPetEventOptions = {}
): Promise<PetCommitOutcome> {
  const originScope = opts.scope ?? capturePetScope()
  if (!isPetScopeCurrent(originScope)) {
    return { ok: false, reason: "scope-invalidated" }
  }
  const now = event.at || Date.now()
  const signalRefusal = opts.signalRefusal ?? true

  type TxResult =
    | {
        status: "refused"
        reason: "uninitialized" | "not-hatched" | "cooldown" | "item-not-owned"
        readyAtMs?: number
      }
    | {
        status: "committed"
        opId: string
        persistProfile: PetProfile & { care: NonNullable<PetProfile["care"]> }
        xp: number
        coinsEarned: number
        oneShots: ReturnType<typeof applyPetEvent>["oneShots"]
        grewStats: ReturnType<typeof applyPetEvent>["grewStats"]
        becameUnwell: boolean
        recovered: boolean
        leveledUpTo: number | null
        evolvedTo: ReturnType<typeof applyPetEvent>["evolvedTo"]
        streakAdvancedTo: number | null
        newlyUnlocked: string[]
      }

  let txResult: TxResult
  try {
    const db = getDb()
    txResult = await db.transaction(
      "rw",
      [db.petProfile, db.petActivityLog, db.petInventory, db.petAchievements, db.syncTombstones],
      async (): Promise<TxResult> => {
        assertPetScopeCurrent(originScope)
        let profile = await db.petProfile.get("global")
        if (!profile) return { status: "refused", reason: "uninitialized" }

        // One-time streak backfill for profiles that predate the economy.
        if (profile.streak === undefined) {
          const ledger = await db.petActivityLog
            .orderBy("ts")
            .reverse()
            .limit(PET_ACTIVITY_CAP)
            .toArray()
          profile = { ...profile, streak: computeStreakFromLedger(ledger, INTERACTION_KINDS) }
        }

        const gate = normalizeInteractionGate(profile.interactionGate)
        const decision = canInteract({
          nowMs: now,
          kind: event.kind,
          source: event.source,
          state: gate,
          hatched: profile.soul !== null,
        })
        if (!decision.ok) {
          return {
            status: "refused",
            reason: decision.reason,
            ...(decision.readyAtMs !== undefined ? { readyAtMs: decision.readyAtMs } : {}),
          }
        }

        if (opts.consumeItemId) {
          const inv = await db.petInventory.get(opts.consumeItemId)
          if (!inv || inv.qty < 1) {
            return { status: "refused", reason: "item-not-owned" }
          }
          if (inv.qty === 1) {
            await db.petInventory.delete(opts.consumeItemId)
            await recordTombstones("petInventory", [opts.consumeItemId], now)
          } else {
            await db.petInventory.put({ ...inv, qty: inv.qty - 1, updatedAt: now })
          }
        }

        const recent = await db.petActivityLog
          .orderBy("ts")
          .reverse()
          .limit(CHAOS_BURST_COUNT)
          .toArray()
        const recoveredFromError = event.kind === "success" && lastEventKind === "error"

        const applied = applyPetEvent(profile, event, now, {
          recentEventTs: recent.map((r) => r.ts),
          recoveredFromError,
        })

        const withGate = { ...applied.profile, interactionGate: decision.nextState }
        const persistProfile = applied.becameUnwell
          ? { ...withGate, care: { ...withGate.care, notifiedAt: now } }
          : withGate

        assertPetScopeCurrent(originScope)
        await db.petProfile.put(persistProfile)

        const xp = xpForEvent(event.kind, event.xp)
        if (xp > 0) {
          await db.petActivityLog.add({
            kind: event.kind,
            source: event.source,
            xp,
            ts: now,
          } as PetActivityRow)
          const count = await db.petActivityLog.count()
          if (count > PET_ACTIVITY_CAP) {
            const overflow = count - PET_ACTIVITY_CAP
            const oldest = await db.petActivityLog.orderBy("ts").limit(overflow).primaryKeys()
            if (oldest.length > 0) await db.petActivityLog.bulkDelete(oldest as number[])
          }
        }

        // Evaluate and persist achievements in the same atomic transaction so
        // profile progression, activity counters, and unlocks never diverge (F18).
        const bones = generateBones(persistProfile.accountFingerprint)
        const allRows = await db.petActivityLog.toArray()
        const counters: Record<string, number> = {}
        for (const row of allRows) counters[row.kind] = (counters[row.kind] ?? 0) + 1
        const unlocked = (await db.petAchievements.orderBy("unlockedAt").toArray()).map((a) => a.id)
        const newly = checkAchievements(
          {
            profile: persistProfile,
            bones,
            activity: [],
            counters,
            effectiveStats: effectiveStats(bones.stats, persistProfile.statProgress),
            care: persistProfile.care,
          },
          unlocked
        )
        const newlyUnlocked: string[] = []
        for (const id of newly) {
          const existing = await db.petAchievements.get(id)
          if (!existing) {
            await db.petAchievements.put({ id, unlockedAt: now })
            newlyUnlocked.push(id)
          }
        }

        nextOperationSeq += 1
        const opId = `pet_op_${now}_${nextOperationSeq}`
        return {
          status: "committed",
          opId,
          persistProfile,
          xp,
          coinsEarned: applied.coinsEarned,
          oneShots: applied.oneShots,
          grewStats: applied.grewStats,
          becameUnwell: applied.becameUnwell,
          recovered: applied.recovered,
          leveledUpTo: applied.leveledUpTo,
          evolvedTo: applied.evolvedTo,
          streakAdvancedTo: applied.streakAdvancedTo,
          newlyUnlocked,
        }
      }
    )
  } catch (err) {
    if (err instanceof PetScopeInvalidatedError) {
      return { ok: false, reason: "scope-invalidated", error: err }
    }
    return { ok: false, reason: "storage-error", error: err }
  }

  if (!isPetScopeCurrent(originScope)) {
    return { ok: false, reason: "scope-invalidated" }
  }

  if (txResult.status === "refused") {
    if (signalRefusal && (txResult.reason === "cooldown" || txResult.reason === "not-hatched")) {
      usePetStore.getState().setInteractionRefusal({
        kind: event.kind,
        reason: txResult.reason,
        ...(txResult.readyAtMs !== undefined ? { readyAtMs: txResult.readyAtMs } : {}),
        at: now,
      })
    }
    return {
      ok: false,
      reason: txResult.reason,
      ...(txResult.readyAtMs !== undefined ? { readyAtMs: txResult.readyAtMs } : {}),
    }
  }

  const {
    opId,
    persistProfile,
    xp,
    coinsEarned,
    oneShots,
    grewStats,
    becameUnwell,
    recovered,
    leveledUpTo,
    evolvedTo,
    streakAdvancedTo,
    newlyUnlocked,
  } = txResult

  if (!PASSIVE_KINDS.has(event.kind)) {
    lastEventKind = event.kind
  }

  // Plugin hooks — fire-and-forget so a slow plugin can never delay the pet.
  const hooks = getPluginEventHooks()
  if (INTERACTION_KINDS.has(event.kind)) {
    void hooks.dispatchPetInteract({ kind: event.kind, source: event.source, xp, at: now })
  }
  if (leveledUpTo !== null) {
    void hooks.dispatchPetLevelUp({ level: leveledUpTo, stage: persistProfile.stage, at: now })
  }
  if (evolvedTo !== null) {
    void hooks.dispatchPetEvolved({ stage: evolvedTo, level: persistProfile.level, at: now })
  }
  if (becameUnwell) {
    void hooks.dispatchPetUnwell({ condition: persistProfile.care.condition, at: now })
  }
  for (const id of newlyUnlocked) {
    void hooks.dispatchPetAchievementUnlocked({ achievementId: id, at: now })
  }

  updateActiveWorkState(event)

  // Drive the renderer. Passive/idle events preserve unresolved waiting or
  // active work states first (F3), then honor a persistent unwell condition;
  // expressive interactions and milestones keep their own states.
  const store = usePetStore.getState()
  const visual = PASSIVE_KINDS.has(event.kind)
    ? (resolveActiveWorkVisualState() ??
      restingWithCare(persistProfile.needs, persistProfile.care.condition))
    : reducePetVisualState(event, persistProfile.needs)
  store.setVisualState(visual)
  for (const shot of oneShots) store.enqueueOneShot(shot)
  if (grewStats.length) store.setLastGrewStats(grewStats)
  if (becameUnwell) {
    store.setCareAlert({ at: now, petName: persistProfile.soul?.name ?? null })
  }
  if (recovered) store.enqueueOneShot("happy")

  if (opts.emitOnBus) {
    const announced: PetEvent = { ...event, at: now }
    committedBusEvents.add(announced)
    getPetEventBus().emit(announced)
  }

  // Announce unlocks on the bus so bubble/proactive subscribers can celebrate.
  if (event.kind !== "achievementUnlocked") {
    const bus = getPetEventBus()
    for (const id of newlyUnlocked) {
      bus.emit({
        source: "system",
        kind: "achievementUnlocked",
        at: now,
        meta: { achievementId: id },
      })
    }
  }

  if (!LIFECYCLE_EMIT_KINDS.has(event.kind)) {
    const bus = getPetEventBus()
    if (leveledUpTo !== null) {
      bus.emit({ source: "system", kind: "levelUp", at: now, meta: { level: leveledUpTo } })
    }
    if (evolvedTo !== null) {
      bus.emit({ source: "system", kind: "evolved", at: now, meta: { stage: evolvedTo } })
    }
    if (becameUnwell) {
      bus.emit({ source: "system", kind: "unwell", at: now })
    }
    if (streakAdvancedTo !== null && streakAdvancedTo >= 2) {
      bus.emit({
        source: "system",
        kind: "streakDay",
        at: now,
        meta: {
          days: streakAdvancedTo,
          multiplier: coinMultiplier(streakAdvancedTo),
        },
      })
    }
  }

  return {
    ok: true,
    opId,
    grantedXp: xp,
    grantedCoins: coinsEarned,
    profile: persistProfile,
  }
}

/**
 * Commit one event atomically (profile + optional item spend + activity log +
 * achievements) inside the serialized controller queue, returning the exact
 * committed outcome (F16, F17, F18, F27).
 */
export function commitPetEvent(
  event: PetEvent,
  opts: CommitPetEventOptions = {}
): Promise<PetCommitOutcome> {
  const scope = opts.scope ?? capturePetScope()
  if (opts.alreadySerialized) return runCommittedEvent(event, { ...opts, scope })
  return enqueuePetWork(() => runCommittedEvent(event, { ...opts, scope }))
}

/**
 * Handle one event from the bus, serialized after any in-flight handling.
 * Storage failures are logged without poisoning the serialization chain.
 */
export function handlePetEvent(event: PetEvent): Promise<void> {
  if (committedBusEvents.has(event)) return Promise.resolve()
  const scope = capturePetScope()
  return enqueuePetWork(async () => {
    const outcome = await runCommittedEvent(event, { alreadySerialized: true, scope })
    if (!outcome.ok && outcome.reason === "storage-error") {
      loggers.app.warn("pet event handling failed", {
        kind: event.kind,
        source: event.source,
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? ""),
      })
    }
  })
}
