"use client"

// Structured card for the plan-mode signal tools `exit_plan_mode` (cognia,
// also namespaced `mcp__cognia-tools__exit_plan_mode`) and the native Anthropic
// `ExitPlanMode`. Both pass the final plan as one markdown string in
// `input.plan`.
//
// Compact by design: the plan's title, where the plan it became stands now
// (status, step count) and a way into the dock's Tasks panel, which holds the
// live plan. The body is one disclosure away and renders through the same
// read-only `PlanDocument` the panel uses — from the tool input, so the
// transcript keeps what was proposed even after the plan is edited or deleted.

import { useState } from "react"
import type { ToolUIPart } from "ai"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon, PanelRightOpenIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { PlanDocument } from "@/components/agent/plan/plan-document"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { planDocTitle } from "@/lib/agent/plan/plan-doc"
import { revealSessionPanel } from "@/lib/artifacts/reveal"
import { SESSION_TASKS_PANEL_ID } from "@/lib/artifacts/session-workbench-scope-key"
import { listPlansBySession } from "@/lib/db/plans"
import { cn } from "@/lib/utils"
import { DEFAULT_PLAN_CONFIG, type AgentPlan } from "@/types/agent/plan"

/** The plan captured from this call: by its tool call id, else by its body. */
export function findCapturedPlan(
  plans: readonly AgentPlan[] | undefined,
  toolCallId: string | undefined,
  planText: string
): AgentPlan | undefined {
  if (!plans) return undefined
  const meta = (plan: AgentPlan) => plan.metadata as { toolUseId?: unknown; planText?: unknown }
  return (
    (toolCallId ? plans.find((plan) => meta(plan).toolUseId === toolCallId) : undefined) ??
    plans.find((plan) => {
      const text = meta(plan).planText
      return typeof text === "string" && text.trim() === planText
    })
  )
}

/** The proposal as the tool carried it, in the shape `PlanDocument` reads. */
function proposalFromTool(
  toolCallId: string | undefined,
  sessionId: string | undefined,
  title: string,
  planText: string
): AgentPlan {
  return {
    id: `tool:${toolCallId ?? "plan"}`,
    sessionId: sessionId ?? "",
    title,
    source: "exit_plan_mode",
    executionMode: "auto",
    steps: [],
    status: "draft",
    totalSteps: 0,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "",
    createdAt: 0,
    updatedAt: 0,
    metadata: { planText },
  }
}

export function PlanCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
  const t = useTranslations("plan")
  const [open, setOpen] = useState(false)
  const input = (part.input ?? {}) as { plan?: unknown }
  const planText = typeof input.plan === "string" ? input.plan.trim() : ""
  const plans = useLiveQuery(
    () => (sessionId && planText ? listPlansBySession(sessionId) : Promise.resolve([])),
    [sessionId, planText]
  )
  const captured = findCapturedPlan(plans, part.toolCallId, planText)
  const title = planDocTitle(planText) ?? captured?.title ?? t("card.untitled")

  if (!planText) return null

  return (
    <div data-testid="mcp-plan-card" className="my-1 rounded-md border border-border/60">
      <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="mcp-plan-toggle"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-90"
            )}
            aria-hidden
          />
          <span className="min-w-0 truncate">{title}</span>
        </button>
        {captured && (
          <>
            {captured.totalSteps > 0 && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {t("composer.stepCount", { count: captured.totalSteps })}
              </span>
            )}
            <Badge
              variant="secondary"
              className="shrink-0 text-[10px]"
              data-testid="mcp-plan-status"
            >
              {t(`status.${captured.status}`)}
            </Badge>
          </>
        )}
        {sessionId && captured && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label={t("card.openInPanel")}
            title={t("card.openInPanel")}
            onClick={() => revealSessionPanel(sessionId, SESSION_TASKS_PANEL_ID)}
            data-testid="mcp-plan-open-panel"
          >
            <PanelRightOpenIcon className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>
      {open && (
        // Capped so a long plan scrolls inside the card instead of stretching
        // the transcript; the document scrolls natively (selection-safe).
        <div
          className="flex max-h-80 min-h-0 flex-col border-t border-border/60 bg-background"
          data-testid="mcp-plan-body"
        >
          <PlanDocument
            plan={proposalFromTool(part.toolCallId, sessionId, title, planText)}
            showTitle={false}
          />
        </div>
      )}
    </div>
  )
}
