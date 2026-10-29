"use client"

/**
 * The run controls of a session's executing / paused plan (ADR-0045): pause,
 * resume, cancel, and the decisions on an in-session plan halted on a step
 * (retry / skip / mark done / resume).
 *
 * Shared by the two surfaces that act on a running plan: the halt card above
 * the composer (`PlanHaltDock`) and the Tasks panel in the dock. Both drive the
 * same runtime calls, so a decision taken in either reads the same.
 *
 * An in-session plan is driven one chat turn at a time, so its decisions need a
 * chat surface to send the next turn (`canDispatch`). A turn still streaming on
 * the session when the user acts on a halt is stopped first — it is the
 * stalled turn the halt is about.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useOptionalClaudeChat } from "@/hooks/chat/use-claude-chat"
import { getPlanRuntime, type PlanContinueOutcome } from "@/lib/agent/plan/runtime"
import { readChatHandoff } from "@/lib/agent/plan/chat-handoff"
import { resolvePlanStrategy } from "@/lib/agent/plan/strategy"
import { chatPlanStepHooks } from "@/lib/agent/plan/turn-driver"
import { useChatStore } from "@/stores/chat"
import type { AgentPlan, PlanStepContinueAction, PlanStepHalt } from "@/types/agent/plan"

export interface PlanRunControls {
  busy: boolean
  /** Driven as visible chat turns (vs the headless orchestrator). */
  inSession: boolean
  /** The step an in-session plan is halted on, when paused on one. */
  halt: PlanStepHalt | undefined
  /** Handed to one implementing chat turn (`chat-handoff.ts`), not stepped. */
  handoff: boolean
  /** A chat surface is mounted that can send the plan's next turn. */
  canDispatch: boolean
  pause: () => void
  resume: () => void
  cancel: () => void
  continueWith: (action: PlanStepContinueAction) => void
  /** A handed-off plan: the user says it is done. */
  markDone: () => void
}

export function usePlanRunControls(
  sessionId: string,
  plan: AgentPlan | undefined
): PlanRunControls {
  const t = useTranslations("plan")
  const chat = useOptionalClaudeChat()
  const [busy, setBusy] = useState(false)

  const inSession = plan ? resolvePlanStrategy(plan) === "in_session" : false
  const halt = plan && plan.status === "paused" && inSession ? plan.stepHalt : undefined
  const handoff = plan ? readChatHandoff(plan) !== null : false

  const run = async (action: () => Promise<unknown>) => {
    if (busy || !plan) return
    setBusy(true)
    try {
      await action()
    } catch {
      toast.error(t("stepFailure.actionFailed"))
    } finally {
      setBusy(false)
    }
  }

  const stopStalledTurn = async () => {
    const status = useChatStore.getState().sessions[sessionId]?.status
    if (chat && (status === "streaming" || status === "awaiting_approval")) {
      await chat.stop(sessionId)
    }
  }

  /** Send the turn the runtime prepared; a refused send halts the step again. */
  const dispatch = async (planId: string, outcome: PlanContinueOutcome) => {
    if (outcome.kind !== "continue" || !chat) return
    try {
      await chat.send(outcome.userMessage, undefined, {
        sessionId,
        skipUserAppend: true,
        throwOnError: true,
      })
    } catch (error) {
      await getPlanRuntime().failInSessionStep(planId, {
        stepId: outcome.stepId,
        cause: "dispatch_failed",
        detail: error instanceof Error ? error.message : String(error),
        capturedGenerationId: outcome.generationId,
      })
    }
  }

  const continueWith = (action: PlanStepContinueAction) =>
    void run(async () => {
      if (!plan) return
      if (halt) await stopStalledTurn()
      const outcome = await getPlanRuntime().continueInSessionPlan(plan.id, action, {
        hooks: chatPlanStepHooks(plan.id, sessionId),
      })
      await dispatch(plan.id, outcome)
    })

  return {
    busy,
    inSession,
    halt,
    handoff,
    canDispatch: Boolean(chat),
    pause: () => void run(() => getPlanRuntime().pausePlan(plan!.id)),
    resume: () =>
      inSession ? continueWith("resume") : void run(() => getPlanRuntime().resumePlan(plan!.id)),
    cancel: () =>
      void run(async () => {
        if (halt) await stopStalledTurn()
        await getPlanRuntime().cancelPlan(plan!.id)
        // A handed-off plan IS the running turn: cancelling it stops the turn.
        if (handoff) await stopStalledTurn()
      }),
    continueWith,
    markDone: () => void run(() => getPlanRuntime().completeChatHandoff(plan!.id)),
  }
}
