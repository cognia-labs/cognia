/**
 * `trigger.pet.event` fan-out — bridges the desktop pet's lifecycle bus
 * events (levelUp / evolved / achievementUnlocked / unwell, re-emitted by
 * `lib/pet/runtime/pet-controller.ts`) to subscribed workflows.
 *
 * Lifecycle: `initPetEventTrigger()` (mounted by `WorkflowRuntimeProvider` on
 * every shell — the bus exists on web too) subscribes the in-renderer
 * PetEventBus unconditionally. Unlike `desktop-event-trigger.ts` there is no
 * backend resource to reconcile: an idle bus subscription is a Set entry, so
 * the liveQuery-driven acquire/release dance is deliberately omitted.
 *
 * Bots are the second consumer: every lifecycle event is handed to them as a
 * `desktop.pet.<kind>` event through `bot-dispatch` (the router decides which
 * installations listen), whether or not any workflow matches. They get the
 * same id-only projection.
 *
 * Safety gates (mirroring the desktop runner):
 *  1. **PII red-line** — the trigger payload is a PROJECTION, never the raw
 *     event meta (talked events carry meta.userText; even though talked is
 *     not a whitelisted kind, the projection stays defensive).
 *  2. **Loop guard** — per-workflow `cooldownMs` (param, default 2000) plus
 *     an in-flight guard, so a workflow whose actions feed the pet can't
 *     re-trigger itself in a tight loop.
 */

import { loggers } from "@cognia/logging"
import { loadPort } from "@/lib/modules/ports"
import type { PetEvent } from "@/types/pet"

const log = loggers.scheduler

const DEFAULT_COOLDOWN_MS = 2_000

/** Lifecycle kinds the trigger fans out (matches PET_TRIGGER_KINDS). */
const TRIGGERABLE_KINDS: ReadonlySet<string> = new Set([
  "levelUp",
  "evolved",
  "achievementUnlocked",
  "unwell",
])

export interface PetEventTriggerDeps {
  /** Injectable clock for the cooldown gate. */
  now?: () => number
}

interface RunnerState {
  unsubscribe?: () => void
  /** Per-workflow last-fire timestamps (cooldown gate). */
  lastFired: Map<string, number>
  /** Workflows with an in-flight run started by this trigger. */
  inflight: Set<string>
  now: () => number
  active: boolean
}

let state: RunnerState | null = null

/**
 * The Bot event id of one pet occurrence. The controller emits every
 * achievement one handling unlocks with the same `at`, so the id carries what
 * tells them apart (the achievement, level or stage); two occurrences sharing
 * an id would be one delivery.
 */
export function petSourceRecordId(kind: string, payload: Record<string, unknown>): string {
  const detail = payload.achievementId ?? payload.level ?? payload.stage
  return `pet:${kind}:${String(payload.at)}${detail === undefined ? "" : `:${String(detail)}`}`
}

async function onPetEvent(event: PetEvent): Promise<void> {
  const s = state
  if (!s || !s.active) return
  if (!TRIGGERABLE_KINDS.has(event.kind)) return

  // PII red-line: project only id-shaped meta — never forward meta wholesale.
  const payload: Record<string, unknown> = { kind: event.kind, at: event.at }
  if (typeof event.meta?.achievementId === "string") {
    payload.achievementId = event.meta.achievementId
  }
  if (typeof event.meta?.level === "number") payload.level = event.meta.level
  if (typeof event.meta?.stage === "string") payload.stage = event.meta.stage

  // Bots get every lifecycle event; with no `bot-dispatch` provider there are
  // none. Best-effort, like the workflow fan-out below.
  void (async () => {
    const bots = await loadPort("bot-dispatch")
    await bots?.desktopEvent({
      type: `desktop.pet.${event.kind}`,
      sourceRecordId: petSourceRecordId(event.kind, payload),
      payload: { ...payload },
      occurredAt: event.at,
    })
  })().catch(() => undefined)

  try {
    const [{ dispatchTrigger }, { findMatchingWorkflows }] = await Promise.all([
      import("@/lib/workflow/runtime/trigger-bridge"),
      import("@/lib/workflow/runtime/trigger-subscriptions"),
    ])
    const matches = findMatchingWorkflows("trigger.pet.event", { petEventKind: event.kind })
    if (matches.length === 0) return

    const now = s.now()
    await Promise.all(
      matches.map(async (match) => {
        if (s.inflight.has(match.workflowId)) return
        const cooldown =
          typeof match.params.cooldownMs === "number"
            ? match.params.cooldownMs
            : DEFAULT_COOLDOWN_MS
        const last = s.lastFired.get(match.workflowId) ?? 0
        if (now - last < cooldown) return
        s.lastFired.set(match.workflowId, now)
        s.inflight.add(match.workflowId)
        try {
          await dispatchTrigger({
            workflowId: match.workflowId,
            kind: "trigger.pet.event",
            triggerId: match.nodeId,
            payload,
            originAt: now,
          })
        } catch {
          // Per-match isolation — one bad workflow can't block the others.
        } finally {
          s.inflight.delete(match.workflowId)
        }
      })
    )
  } catch {
    // Workflow runtime unavailable — best-effort.
  }
}

/** Subscribe the pet bus. Idempotent — disposes the previous runner first. */
export function initPetEventTrigger(deps: PetEventTriggerDeps = {}): void {
  if (typeof window === "undefined") return
  disposePetEventTrigger()
  const s: RunnerState = {
    lastFired: new Map(),
    inflight: new Set(),
    now: deps.now ?? Date.now,
    active: true,
  }
  state = s
  void import("@/lib/pet/events/pet-event-bus")
    .then(({ getPetEventBus }) => {
      if (!state || state !== s || !s.active) return
      s.unsubscribe = getPetEventBus().subscribe((event) => void onPetEvent(event))
    })
    .catch((err) => {
      log.warn?.("pet-event-trigger: subscribe failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

/** Tear the runner down (unsubscribe from the bus). */
export function disposePetEventTrigger(): void {
  const s = state
  if (!s) return
  s.active = false
  state = null
  try {
    s.unsubscribe?.()
  } catch {
    // best-effort
  }
}

/** Test-only — drive one event through the runner without the live bus. */
export async function _injectPetEventForTest(event: PetEvent): Promise<void> {
  await onPetEvent(event)
}
