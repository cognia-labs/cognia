"use client"
import { memo } from "react"

import { GoalStatusPill } from "@/components/goal/goal-status-pill"
import { LoopStatusPill } from "@/components/loop/loop-status-pill"
import { PlanModeBanner } from "@/components/chat/plan-mode-banner"

import { Collapse } from "./collapse"

/**
 * The self-hiding status bands under the attachments: the goal (ADR-0019), the
 * open `/loop`, and the plan-mode banner. Each reads its own store; the only
 * thing the composer tells them is which conversation they belong to.
 */
export const ComposerStatusBands = memo(function ComposerStatusBands({
  sessionId,
}: {
  sessionId: string | null
}) {
  return (
    <>
      {/* ADR-0019 — active/paused goal status + controls; self-hides when none. */}
      <Collapse>
        <GoalStatusPill sessionId={sessionId} />
      </Collapse>
      {/* /loop status + controls; self-hides when no open loop. */}
      <Collapse>
        <LoopStatusPill sessionId={sessionId} />
      </Collapse>
      {/* Plan-mode state banner; self-hides outside plan mode. */}
      <Collapse>
        <PlanModeBanner />
      </Collapse>
    </>
  )
})
