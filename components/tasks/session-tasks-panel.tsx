"use client"

/**
 * The dock's Tasks panel — everything the conversation is working through, in
 * one place, top to bottom:
 *
 *   1. Current tasks — the agent's own task list (`TodoWrite` or the
 *      incremental `Task*` tools, `useSessionTasks`). A finished list folds to
 *      "last tasks" so it stops claiming attention.
 *   2. The open plan (ADR-0045) — awaiting approval: the full approval card on
 *      the decision owner's handlers (`plan-decision-store`); approved /
 *      executing / paused: the live tracker and run controls, with the plan
 *      document one disclosure away.
 *   3. Earlier plans — the session's other plans, each expanding to its
 *      read-only document and event trail.
 *
 * The same panel is the desktop dock tab and the mobile / tablet Sheet tab. It
 * scrolls as a whole and lays out against its own width (container queries),
 * since the dock is resizable.
 */

import { useMemo, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon, ListChecksIcon, MessageSquareIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { PlanApprovalCard } from "@/components/agent/plan/plan-approval-card"
import { PlanDocument } from "@/components/agent/plan/plan-document"
import { PlanRunSection } from "@/components/agent/plan/plan-run-section"
import { WritePlanButton } from "@/components/agent/plan/write-plan-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useSessionTasks } from "@/hooks/chat/use-session-tasks"
import { applyPlanEditPatch } from "@/lib/agent/plan/draft-edit"
import { resolvePlanHtmlStyle } from "@/lib/agent/plan/plan-html"
import { jumpToSessionMessage } from "@/lib/chat/cross-session-jump"
import { listPlanEvents, listPlansBySession } from "@/lib/db/plans"
import { cn } from "@/lib/utils"
import { usePlanDecisionOwner } from "@/stores/agent/plan-decision-store"
import { useSettingsStore } from "@/stores/settings"
import { OPEN_PLAN_STATUSES, type AgentPlan, type PlanEditPatch } from "@/types/agent/plan"
import { TaskListView } from "./task-list-view"
import { TaskProgressBar } from "./task-progress-bar"

export interface SessionTasksPanelProps {
  sessionId: string
}

export function SessionTasksPanel({ sessionId }: SessionTasksPanelProps) {
  const t = useTranslations("tasks.panel")
  const tasks = useSessionTasks(sessionId)
  const plans = useLiveQuery(() => listPlansBySession(sessionId), [sessionId])
  const openPlan = useMemo(
    () => plans?.find((plan) => OPEN_PLAN_STATUSES.includes(plan.status)),
    [plans]
  )
  const earlier = useMemo(
    () => plans?.filter((plan) => plan.id !== openPlan?.id) ?? [],
    [plans, openPlan]
  )

  if (!plans) return null // live query still resolving
  const empty = !tasks && plans.length === 0

  return (
    <div
      className="@container/tasks flex h-full min-h-0 flex-col bg-background"
      data-testid="session-tasks-panel"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3">
        {tasks && (
          <CurrentTasks
            sessionId={sessionId}
            tasks={tasks}
            title={
              tasks.finished ? t("lastTitle", { count: tasks.progress.total }) : t("currentTitle")
            }
          />
        )}
        {openPlan && <OpenPlan sessionId={sessionId} plan={openPlan} />}
        {earlier.length > 0 && (
          <section className="space-y-1.5" data-testid="session-tasks-history">
            <SectionTitle>{t("historyTitle")}</SectionTitle>
            {earlier.map((plan) => (
              <EarlierPlan key={plan.id} plan={plan} />
            ))}
          </section>
        )}
        {empty && (
          <div
            className="flex flex-col items-start gap-2 py-6 text-xs text-muted-foreground"
            data-testid="session-tasks-empty"
          >
            <p>{t("empty")}</p>
            <WritePlanButton sessionId={sessionId} variant="outline" />
          </div>
        )}
      </div>
    </div>
  )
}

function SectionTitle({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground/85">
        {children}
      </h3>
      {trailing}
    </div>
  )
}

function CurrentTasks({
  sessionId,
  tasks,
  title,
}: {
  sessionId: string
  tasks: NonNullable<ReturnType<typeof useSessionTasks>>
  title: string
}) {
  const t = useTranslations("tasks")
  // A finished list is history: folded until asked for.
  const [expanded, setExpanded] = useState(false)
  const open = !tasks.finished || expanded
  const { done, total } = tasks.progress

  return (
    <section className="space-y-2" data-testid="session-tasks-current">
      <div className="flex min-w-0 items-center gap-2">
        {tasks.finished ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            data-testid="session-tasks-last-toggle"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
                open && "rotate-90"
              )}
              aria-hidden
            />
            <span className="truncate">{title}</span>
          </button>
        ) : (
          <h3 className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold text-foreground/85">
            <ListChecksIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{title}</span>
          </h3>
        )}
        {tasks.stopped && (
          <Badge
            variant="outline"
            className="shrink-0 border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-400"
          >
            {t("status.stopped")}
          </Badge>
        )}
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {t("progress", { done, total })}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 text-muted-foreground"
          aria-label={t("panel.locate")}
          title={t("panel.locate")}
          onClick={() => void jumpToSessionMessage(sessionId, tasks.lastMessageId)}
          data-testid="session-tasks-locate"
        >
          <MessageSquareIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      {open && (
        <>
          {!tasks.finished && (
            <TaskProgressBar
              done={done}
              total={total}
              tone={tasks.stopped ? "warning" : "default"}
            />
          )}
          <TaskListView items={tasks.items} />
        </>
      )}
    </section>
  )
}

function OpenPlan({ sessionId, plan }: { sessionId: string; plan: AgentPlan }) {
  const t = useTranslations("tasks.panel")
  const tPlan = useTranslations("plan")
  const owner = usePlanDecisionOwner(sessionId, plan.id)
  const settings = useSettingsStore((s) => s.settings?.planSettings)
  const [showDocument, setShowDocument] = useState(false)

  if (plan.status === "awaiting_approval" && owner) {
    const { handlers } = owner
    return (
      <section className="space-y-2" data-testid="session-tasks-plan">
        <SectionTitle>{t("planTitle")}</SectionTitle>
        <PlanApprovalCard
          fill
          plan={plan}
          disabled={owner.busy}
          refining={owner.refining}
          onApprove={handlers.approve}
          onKeepPlanning={handlers.keepPlanning}
          onReject={handlers.reject}
          onOpenEditor={handlers.openEditor}
          onRefine={handlers.refine}
          onEdit={handlers.edit}
          interactiveView={settings?.interactiveHtmlView === true}
          interactiveStyle={resolvePlanHtmlStyle(settings?.interactiveHtmlStyle)}
        />
      </section>
    )
  }

  if (plan.status === "awaiting_approval" || plan.status === "draft") {
    // No pane here owns this conversation's decisions: the document stays
    // editable (the same write path the card uses), the decisions do not.
    const editable = plan.status === "awaiting_approval"
    const onEdit = editable ? (patch: PlanEditPatch) => applyPlanEditPatch(plan, patch) : undefined
    return (
      <section className="space-y-2" data-testid="session-tasks-plan">
        <SectionTitle
          trailing={
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {tPlan(`status.${plan.status}`)}
            </Badge>
          }
        >
          {t("planTitle")}
        </SectionTitle>
        {editable && <p className="text-[11px] text-muted-foreground">{t("decisionsElsewhere")}</p>}
        <DocumentFrame>
          <PlanDocument plan={plan} editable={editable} onEdit={onEdit} showTitle />
        </DocumentFrame>
      </section>
    )
  }

  return (
    <section className="space-y-2" data-testid="session-tasks-plan">
      <SectionTitle>{t("planTitle")}</SectionTitle>
      <PlanRunSection sessionId={sessionId} plan={plan} />
      <Disclosure
        open={showDocument}
        onToggle={() => setShowDocument((v) => !v)}
        label={t("showDocument")}
        testId="session-tasks-plan-document-toggle"
      />
      {showDocument && (
        <DocumentFrame>
          <PlanDocument plan={plan} showTitle={false} />
        </DocumentFrame>
      )}
    </section>
  )
}

function EarlierPlan({ plan }: { plan: AgentPlan }) {
  const tPlan = useTranslations("plan")
  const [open, setOpen] = useState(false)
  const events = useLiveQuery(
    () => (open ? listPlanEvents(plan.id, 50) : Promise.resolve([])),
    [open, plan.id]
  )
  return (
    <div className="rounded-md border border-border/60" data-testid="session-tasks-earlier-plan">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-90"
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-medium">{plan.title}</span>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {tPlan(`status.${plan.status}`)}
        </Badge>
      </button>
      {open && (
        <DocumentFrame className="border-t border-border/60">
          <PlanDocument plan={plan} showTitle={false} events={events} />
        </DocumentFrame>
      )}
    </div>
  )
}

function Disclosure({
  open,
  onToggle,
  label,
  testId,
}: {
  open: boolean
  onToggle: () => void
  label: string
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex items-center gap-1.5 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid={testId}
    >
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
          open && "rotate-90"
        )}
        aria-hidden
      />
      {label}
    </button>
  )
}

/**
 * A plan document inside the scrolling panel: capped so a long document
 * scrolls in place (its outline strip stays sticky) instead of pushing the
 * rest of the panel away. The document paints no background; this frame does.
 */
function DocumentFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex max-h-[min(70dvh,40rem)] min-h-0 flex-col bg-background", className)}>
      {children}
    </div>
  )
}
