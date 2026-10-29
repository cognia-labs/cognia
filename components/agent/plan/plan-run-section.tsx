"use client"

/**
 * An executing / paused plan in the Tasks panel: the live step tracker and its
 * run controls (pause / resume / cancel).
 *
 * A plan halted on a step is decided in the card above the composer
 * (`PlanHaltDock`), where the next turn is sent from; here the halted step
 * shows its error inline and only Cancel stays offered, so the two surfaces
 * never ask the same question twice.
 */

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { usePlanRunControls } from "@/hooks/agent/use-plan-run-controls"
import type { AgentPlan } from "@/types/agent/plan"
import { PlanTrackerPanel } from "./plan-tracker-panel"

export interface PlanRunSectionProps {
  sessionId: string
  plan: AgentPlan
}

export function PlanRunSection({ sessionId, plan }: PlanRunSectionProps) {
  const t = useTranslations("plan")
  const controls = usePlanRunControls(sessionId, plan)
  const live = plan.status === "executing" || plan.status === "paused"

  return (
    <div className="space-y-2" data-testid="plan-run-section">
      <PlanTrackerPanel plan={plan} />
      {live && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {controls.halt ? (
            <span className="mr-auto text-[11px] text-muted-foreground">
              {t("tracker.haltedHint")}
            </span>
          ) : plan.status === "executing" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={controls.busy}
              onClick={controls.pause}
              data-testid="plan-tracker-pause"
            >
              {t("tracker.pause")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              // An in-session plan needs a chat surface to send the resumed turn.
              disabled={controls.busy || (controls.inSession && !controls.canDispatch)}
              onClick={controls.resume}
              data-testid="plan-tracker-resume"
            >
              {t("tracker.resume")}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={controls.busy}
            onClick={controls.cancel}
            data-testid="plan-tracker-cancel"
          >
            {t("tracker.cancel")}
          </Button>
        </div>
      )}
    </div>
  )
}
