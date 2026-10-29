"use client"

/**
 * Thin progress bar shared by every task list header (agent tasks, plan
 * tracker, ACP plans). Accessible as a `progressbar` with the done/total text
 * as its value.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

export interface TaskProgressBarProps {
  done: number
  total: number
  /** Amber fill when the list is stopped or failed. */
  tone?: "default" | "warning"
  className?: string
}

export function TaskProgressBar({
  done,
  total,
  tone = "default",
  className,
}: TaskProgressBarProps) {
  const t = useTranslations("tasks")
  const pct = total > 0 ? Math.round((Math.min(done, total) / total) * 100) : 0
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={t("progressLabel", { done, total })}
      data-testid="task-progress-bar"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] motion-reduce:transition-none",
          tone === "warning" ? "bg-amber-500" : "bg-primary"
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
