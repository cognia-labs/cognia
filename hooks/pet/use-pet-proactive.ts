// The proactive speak engine's React shell. All decision logic is pure and
// lives in `lib/pet/llm/proactive/*`; this hook only wires clocks, the event
// bus, settings, and the LLM side channel together. Main window only —
// bubbles/one-shots mirror to the overlay through the existing bridge.
//
// Ownership: while enabled (with event comments on) it CLAIMS the milestone
// kinds, so `usePetBubbles` stays silent for them. Degradation rule: a claimed
// event that cannot be uttered for ANY reason (gate, limiter, PII, no client,
// model failure, empty reply) falls back to the template bubble — today's
// behavior is preserved. Idle chatter and greetings fail to silence.
//
// Skip-memory invariant (Open-LLM-VTuber): proactive utterances are NEVER
// recorded into the conversation history — the pet cannot cite its own
// rambles. Do not import recordTurn here.

"use client"

import { useEffect, useRef } from "react"
import { useLocale, useTranslations } from "next-intl"

import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { pickBubbleKey, pickCustomBubble } from "@/lib/pet/bubbles/templates"
import { speakAsPet } from "@/lib/pet/bubbles/speak"
import { getSpeakLimiter } from "@/lib/pet/bubbles/speak-limiter"
import { EMOTION_TO_ONESHOT, parseEmotion } from "@/lib/pet/llm/emotion-tags"
import { recallAboutUser } from "@/lib/pet/llm/recall"
import { claimKinds, releaseKinds } from "@/lib/pet/llm/proactive/claim-registry"
import {
  PROACTIVE_CLAIMED_KINDS,
  evaluateEventComment,
  evaluateGreeting,
  evaluateIdle,
  type ProactiveDecision,
} from "@/lib/pet/llm/proactive/triggers"
import { canSpeak } from "@/lib/pet/llm/proactive/gate"
import {
  applySpoke,
  localDayKey,
  localHour,
  normalizeProactiveState,
} from "@/lib/pet/llm/proactive/scheduler-state"
import { resolveProactiveTuning } from "@/lib/pet/llm/proactive/tiers"
import { getLastActivityAtMs, markActivity } from "@/lib/pet/llm/proactive/activity-signal"
import { getPetProfile, patchPetProfile } from "@/lib/db/pet"
import { enqueuePetWork } from "@/lib/pet/runtime/pet-controller"
import { capturePetScope, isPetScopeCurrent } from "@/lib/pet/runtime/pet-scope"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { resolvePreferences } from "@/lib/notifications/preferences"
import { isInQuietHours } from "@/lib/notifications/policy/quiet-hours"
import { resolveUserTimeZone } from "@/lib/profile/timezone"
import { hasNoLeakingPii } from "@cognia/redact"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { usePetStore } from "@/stores/pet/pet-store"
import { usePetSettingsView } from "@/lib/pet/settings"
import type { PetEvent, PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import type { ApplyMemoryContextDeps } from "@/lib/memory/runtime/apply-memory-context"

const TEMPLATE_BUBBLE_MS = 4000
const LLM_BUBBLE_MS = 7000
/** Idle/greeting evaluation cadence. */
const TICK_MS = 60_000

export interface UsePetProactiveArgs {
  profile: PetProfile | undefined
  view: PetView | undefined
  /** Pet enabled and bubbles not muted (same gate as the other bubble hooks). */
  enabled: boolean
}

export function usePetProactive({ profile, view, enabled }: UsePetProactiveArgs): void {
  const t = useTranslations("pet")
  const locale = useLocale()
  const setBubble = usePetStore((s) => s.setBubble)
  const enqueueOneShot = usePetStore((s) => s.enqueueOneShot)
  const appSettings = usePetSettingsView((s) => s)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)
  const mountedRef = useRef(true)
  /** Lazily-built memory retriever deps, keyed by resolved memory config. */
  const memoryDeps = useRef<{ key: string; deps: ApplyMemoryContextDeps } | null>(null)

  const proactive = appSettings?.petSettings?.proactive
  const llmSpeakOn = Boolean(appSettings?.petSettings?.llmSpeak?.enabled)
  const proactiveOn = enabled && llmSpeakOn && Boolean(proactive?.enabled)
  const eventCommentsOn = proactiveOn && proactive?.eventComments !== false
  const idleChatterOn = proactiveOn && proactive?.idleChatter !== false
  const timeGreetingsOn = proactiveOn && proactive?.timeGreetings !== false

  const latest = useRef({ profile, view, appSettings, locale, proactiveOn })
  useEffect(() => {
    latest.current = { profile, view, appSettings, locale, proactiveOn }
  })

  // ── Claim ownership of milestone bubbles while event comments are on. ──────
  useEffect(() => {
    if (!eventCommentsOn) return
    claimKinds(PROACTIVE_CLAIMED_KINDS)
    return () => releaseKinds(PROACTIVE_CLAIMED_KINDS)
  }, [eventCommentsOn])

  // ── Shared utterance pipeline. ──────────────────────────────────────────────
  // `fallback` runs on EVERY non-utterance path; pass null for silence.
  const utter = useRef(
    async (decision: ProactiveDecision, fallback: (() => void) | null): Promise<void> => {
      const current = latest.current
      const now = Date.now()
      const soul = current.profile?.soul
      const llmSpeak = current.appSettings?.petSettings?.llmSpeak
      const tier = current.appSettings?.petSettings?.proactive?.tier ?? "normal"

      const show = (text: string, origin: "template" | "llm", visibleMs: number) => {
        if (!mountedRef.current || !latest.current.proactiveOn) return
        setBubble({ text, origin })
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setBubble(null), visibleMs)
      }

      if (!soul || !current.view || !llmSpeak?.enabled) {
        fallback?.()
        return
      }

      // Gate chain: counters/DND → in-flight → PII → client → global limiter.
      // Check PII and client BEFORE spending a shared speak-limiter slot, and
      // reserve `inFlight` BEFORE the first await (F30) so slow memory recall
      // never admits overlapping generations.
      const prefs = resolvePreferences(current.appSettings?.notificationPreferences)
      const tz = resolveUserTimeZone(current.appSettings?.profile)
      const dndActive = isInQuietHours(now, prefs.quietHours, tz)
      const state = normalizeProactiveState(current.profile?.proactiveState)
      const gate = canSpeak({
        nowMs: now,
        tuning: resolveProactiveTuning(tier),
        state,
        dndActive,
        tz,
      })
      if (!gate.ok || inFlight.current) {
        fallback?.()
        return
      }
      if (!hasNoLeakingPii(decision.topicSeed)) {
        fallback?.()
        return
      }
      const client = buildUtilityLlmClient({
        session: null,
        appSettings: current.appSettings,
        override: llmSpeak,
        featureId: "pet-proactive",
      })
      if (!client) {
        fallback?.()
        return
      }
      if (!getSpeakLimiter().tryAcquire(now)) {
        fallback?.()
        return
      }

      const originScope = capturePetScope()
      const isStillLive = () =>
        mountedRef.current && latest.current.proactiveOn && isPetScopeCurrent(originScope)

      inFlight.current = true
      try {
        // Idle chatter may reference recalled user facts; events don't need them.
        let recallText: string | undefined
        if (decision.trigger === "idle") {
          const memoryConfig = resolveMemoryConfig(current.appSettings?.memory)
          const memoryKey = JSON.stringify(memoryConfig)
          if (!memoryDeps.current || memoryDeps.current.key !== memoryKey) {
            // Dynamic import keeps the twin/vector stack out of the widget's
            // module graph (same pattern as lib/claude/build-options.ts).
            const built =
              (await import("@/lib/memory/runtime/build-deps")
                .then((m) => m.tryBuildMemoryDeps(memoryConfig))
                .catch(() => null)) ?? null
            if (built) memoryDeps.current = { key: memoryKey, deps: built }
          }
          if (!isStillLive()) return
          recallText =
            (await recallAboutUser(memoryDeps.current?.deps ?? undefined, {
              queryText: decision.topicSeed,
              recencyHalfLifeDays: memoryConfig.decayHalfLifeDays,
            })) || undefined
          if (!isStillLive()) return
        }

        const raw = await speakAsPet(client, {
          soul,
          bones: current.view.effectiveBones,
          userText: decision.topicSeed,
          state: {
            mood: current.view.mood,
            energy: Math.round(current.view.needs.energy),
            bond: Math.round(current.view.needs.bond),
            level: current.profile?.level ?? 1,
          },
          recallText,
          emotionInstruction: true,
          locale: current.locale,
        })
        if (!isStillLive()) return
        const parsed = raw ? parseEmotion(raw) : null
        if (!parsed || !parsed.cleanText) {
          fallback?.()
          return
        }
        show(parsed.cleanText, "llm", LLM_BUBBLE_MS)
        if (parsed.emotion) enqueueOneShot(EMOTION_TO_ONESHOT[parsed.emotion])
        // Persist the advanced counters inside the controller's serialization
        // queue against the freshest stored proactiveState (F26/F30); skip-memory
        // — recordTurn is never called.
        await enqueuePetWork(async () => {
          if (!isPetScopeCurrent(originScope)) return
          const freshProfile =
            typeof getPetProfile === "function"
              ? await getPetProfile().catch(() => undefined)
              : undefined
          const baseState = freshProfile
            ? normalizeProactiveState(freshProfile.proactiveState)
            : state
          await patchPetProfile({
            proactiveState: applySpoke(baseState, now, {
              tz,
              greetedWindow: decision.greetingWindowKey,
            }),
          })
        }).catch(() => undefined)
      } catch {
        if (isStillLive()) fallback?.()
      } finally {
        inFlight.current = false
      }
    }
  )

  // Track user pet interactions for idle-chatter cadence even when event
  // comments are disabled.
  useEffect(() => {
    if (!proactiveOn) return
    const off = getPetEventBus().subscribe((event: PetEvent) => {
      if (event.source === "user") markActivity(event.at)
    })
    return () => off()
  }, [proactiveOn])

  // ── Event comments: bus subscription over the claimed kinds. ───────────────
  useEffect(() => {
    if (!eventCommentsOn) return
    const off = getPetEventBus().subscribe((event: PetEvent) => {
      // A wiser pet comments on more of the (high-frequency) workflow runs.
      const decision = evaluateEventComment(event, {
        wisdom: latest.current.view?.effectiveStats.wisdom ?? 0,
      })
      if (!decision) return
      const fallback = () => {
        if (!mountedRef.current || !latest.current.proactiveOn) return
        const snark = latest.current.view?.effectiveStats.snark ?? 0
        const key = pickBubbleKey(event.kind, event.at, { snark })
        if (!key) return // e.g. workflowRun has no template → silence
        const custom = pickCustomBubble(
          latest.current.appSettings?.petSettings?.customBubbles,
          event.at
        )
        const days = typeof event.meta?.days === "number" ? event.meta.days : 0
        setBubble({ text: custom ?? t(key, { days }), origin: "template" })
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setBubble(null), TEMPLATE_BUBBLE_MS)
      }
      void utter.current(decision, fallback)
    })
    return () => off()
  }, [eventCommentsOn, t, setBubble])

  // ── Idle chatter + time greetings: one shared low-frequency tick. ──────────
  useEffect(() => {
    if (!idleChatterOn && !timeGreetingsOn) return
    const interval = setInterval(() => {
      const current = latest.current
      if (!current.profile || !current.view) return
      const now = Date.now()
      const tz = resolveUserTimeZone(current.appSettings?.profile)
      const state = normalizeProactiveState(current.profile.proactiveState)
      const tier = current.appSettings?.petSettings?.proactive?.tier ?? "normal"

      const greeting = timeGreetingsOn
        ? evaluateGreeting({
            nowMs: now,
            greetedWindows: state.dayKey === localDayKey(now, tz) ? state.greetedWindows : [],
            dayKey: localDayKey(now, tz),
            hour: localHour(now, tz),
          })
        : null
      const idle =
        !greeting && idleChatterOn
          ? evaluateIdle({
              nowMs: now,
              lastActivityAtMs: getLastActivityAtMs(),
              needs: current.view.needs,
              idleThresholdMs: resolveProactiveTuning(tier).idleThresholdMs,
            })
          : null
      const decision = greeting ?? idle
      if (decision) void utter.current(decision, null)
    }, TICK_MS)
    return () => clearInterval(interval)
  }, [idleChatterOn, timeGreetingsOn])

  // Track mount lifetime and clear any pending bubble timer on unmount.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
}
