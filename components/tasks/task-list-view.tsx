"use client"

/**
 * The shared task checklist. Draws {@link TaskViewItem}s from any producer
 * (agent todos, plan steps, ACP entries) the same way: status glyph, the
 * active form while an item runs, a struck-through title once done, and an
 * optional detail line (e.g. why a plan step failed).
 *
 * Long lists fold their completed items into one "N completed" row so the
 * open work stays in view; the row expands them in place.
 */

import { useState, type ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { taskItemLabel, type TaskViewItem } from "@/lib/tasks/task-view"
import { TaskStatusIcon } from "./task-status-icon"

/** Lists longer than this fold their completed items by default. */
export const TASK_LIST_FOLD_THRESHOLD = 8

export interface TaskListViewProps {
  items: readonly TaskViewItem[]
  /** The item to emphasise (e.g. a plan's current step). */
  currentId?: string | null
  /** Extra content at the end of a row (e.g. a plan step's status badge). */
  renderTrailing?: (item: TaskViewItem) => ReactNode
  /** Fold completed items above this many rows (0 disables folding). */
  foldThreshold?: number
  density?: "default" | "compact"
  className?: string
  testId?: string
}

export function TaskListView({
  items,
  currentId,
  renderTrailing,
  foldThreshold = TASK_LIST_FOLD_THRESHOLD,
  density = "default",
  className,
  testId = "task-list",
}: TaskListViewProps) {
  const t = useTranslations("tasks")
  const [showCompleted, setShowCompleted] = useState(false)
  const completedCount = items.filter((item) => item.status === "completed").length
  const foldable = foldThreshold > 0 && items.length > foldThreshold && completedCount > 0
  const folded = foldable && !showCompleted
  const visible = folded ? items.filter((item) => item.status !== "completed") : items

  return (
    <ul
      className={cn(density === "compact" ? "space-y-0.5" : "space-y-1.5", className)}
      data-testid={testId}
    >
      {foldable && (
        <li>
          <button
            type="button"
            onClick={() => setShowCompleted((v) => !v)}
            aria-expanded={!folded}
            className="flex w-full items-center gap-2 rounded text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            data-testid="task-list-completed-toggle"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
                !folded && "rotate-90"
              )}
              aria-hidden
            />
            <span>{t("completedFold", { count: completedCount })}</span>
          </button>
        </li>
      )}
      {visible.map((item) => {
        const current = currentId != null && item.id === currentId
        return (
          <li
            key={item.id}
            className={cn(
              "flex items-start gap-2 text-xs",
              density === "compact" && "leading-tight"
            )}
            data-status={item.status}
            data-current={current ? "true" : undefined}
            data-testid="task-list-item"
          >
            <span className="mt-px">
              <TaskStatusIcon status={item.status} labelled />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words",
                item.status === "completed" && "text-muted-foreground line-through",
                (item.status === "skipped" || item.status === "cancelled") &&
                  "text-muted-foreground",
                (item.status === "in_progress" || current) && "font-medium text-foreground"
              )}
            >
              {taskItemLabel(item)}
              {item.detail && (
                <span
                  className="mt-0.5 block text-[11px] font-normal text-destructive"
                  data-testid="task-list-item-detail"
                >
                  {item.detail}
                </span>
              )}
            </span>
            {renderTrailing?.(item)}
          </li>
        )
      })}
    </ul>
  )
}
