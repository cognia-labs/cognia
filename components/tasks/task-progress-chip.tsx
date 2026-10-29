"use client"

/**
 * The one-line task progress that rides the run panel above the composer —
 * "Step 3/7 · Run the tests" — on every form factor. The full list lives in
 * the dock's Tasks panel; the chip opens it (the desktop dock, or the Sheet on
 * a phone / tablet).
 *
 * It speaks for the open work only: an executing / paused plan first, else the
 * agent's own task list while it is unfinished. A finished list, or none,
 * renders nothing.
 */

import { ListChecksIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { useSessionPlan } from "@/hooks/agent/use-session-plan"
import { useSessionTasks } from "@/hooks/chat/use-session-tasks"
import { readChatHandoff } from "@/lib/agent/plan/chat-handoff"
import { revealSessionPanel } from "@/lib/artifacts/reveal"
import { SESSION_TASKS_PANEL_ID } from "@/lib/artifacts/session-workbench-scope-key"
import { taskItemLabel } from "@/lib/tasks/task-view"
import { cn } from "@/lib/utils"

export interface TaskChipModel {
  text: string
  tone: "default" | "warning"
}

/** What the chip says for `sessionId`, or null when there is no open work. */
export function useSessionTaskChip(sessionId: string | null | undefined): TaskChipModel | null {
  const t = useTranslations("tasks.chip")
  const plan = useSessionPlan(sessionId ?? undefined)
  const tasks = useSessionTasks(sessionId)

  // A plan handed to one chat turn moves no steps; the agent's own list is its
  // progress, so the chip speaks for that list under the plan's name.
  if (plan && readChatHandoff(plan) && (plan.status === "executing" || plan.status === "paused")) {
    if (plan.status === "paused") return { text: t("planHandoffPaused"), tone: "warning" }
    if (tasks && !tasks.finished && tasks.progress.current) {
      const { done, total, current } = tasks.progress
      return { text: t("tasks", { done, total, step: taskItemLabel(current) }), tone: "default" }
    }
    return { text: t("planHandoff"), tone: "default" }
  }
  if (plan && (plan.status === "executing" || plan.status === "paused")) {
    const done = plan.completedSteps
    const total = plan.totalSteps
    if (plan.status === "paused") return { text: t("planPaused", { done, total }), tone: "warning" }
    const step = plan.steps.find((s) => s.id === plan.currentStepId)
    return {
      text: step
        ? t("planStep", { done, total, step: step.title })
        : t("planRunning", { done, total }),
      tone: "default",
    }
  }
  if (tasks && !tasks.finished) {
    const { done, total, current } = tasks.progress
    if (tasks.stopped) return { text: t("stopped", { done, total }), tone: "warning" }
    return {
      text: current
        ? t("tasks", { done, total, step: taskItemLabel(current) })
        : `${done}/${total}`,
      tone: "default",
    }
  }
  return null
}

export interface TaskProgressChipProps {
  sessionId: string
  model: TaskChipModel
  className?: string
}

export function TaskProgressChip({ sessionId, model, className }: TaskProgressChipProps) {
  const t = useTranslations("tasks.chip")
  return (
    <button
      type="button"
      onClick={() => revealSessionPanel(sessionId, SESSION_TASKS_PANEL_ID)}
      aria-label={`${t("open")}: ${model.text}`}
      title={model.text}
      className={cn(
        "-mx-1 flex min-h-6 min-w-0 items-center gap-1.5 rounded px-1 text-left text-[11px] hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        model.tone === "warning" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
        className
      )}
      data-testid="task-progress-chip"
      data-tone={model.tone}
    >
      <ListChecksIcon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate tabular-nums">{model.text}</span>
    </button>
  )
}
