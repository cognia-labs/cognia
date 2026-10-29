"use client"

/**
 * The decision an executing plan needs from the user, above the composer.
 *
 * A running plan's progress lives in the dock's Tasks panel (and as a chip on
 * the run panel); only a plan that STOPPED and waits on a decision claims the
 * slot beside the composer: an in-session plan halted on a step (written by
 * the step watchdog, a refused send, or the boot recovery) renders
 * {@link PlanStepFailureCard} with retry / skip / mark done / cancel. The
 * actions are the same `usePlanRunControls` the Tasks panel uses.
 *
 * Every chat view mounts this dock, so it also runs the once-per-load recovery
 * of in-session steps orphaned by an app restart (`ensurePlanStepRecovery`):
 * only a chat view can drive an in-session plan.
 */

import { useEffect } from "react"

import { usePlanRunControls } from "@/hooks/agent/use-plan-run-controls"
import { useSessionPlan } from "@/hooks/agent/use-session-plan"
import { ensurePlanStepRecovery } from "@/lib/agent/plan/step-recovery"
import { PlanStepFailureCard } from "./plan-step-failure-card"

export interface PlanHaltDockProps {
  sessionId: string
}

export function PlanHaltDock({ sessionId }: PlanHaltDockProps) {
  const plan = useSessionPlan(sessionId)
  const controls = usePlanRunControls(sessionId, plan)

  useEffect(() => {
    void ensurePlanStepRecovery()
  }, [])

  if (!plan || !controls.halt) return null

  return (
    <div className="pb-2" data-testid="plan-halt-dock">
      <PlanStepFailureCard
        plan={plan}
        halt={controls.halt}
        busy={controls.busy}
        canDispatch={controls.canDispatch}
        onRetry={() => controls.continueWith("retry")}
        onSkip={() => controls.continueWith("skip")}
        onMarkDone={() => controls.continueWith("complete")}
        onResume={() => controls.continueWith("resume")}
        onCancel={controls.cancel}
      />
    </div>
  )
}
