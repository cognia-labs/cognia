"use client"

/**
 * The one status glyph for every task list (agent todos, plan steps, ACP plan
 * entries, AI-shell steps). Covers the whole {@link TaskViewStatus} vocabulary,
 * so no surface keeps a private map that silently lacks a state.
 */

import {
  BanIcon,
  CheckCircle2Icon,
  CircleIcon,
  ClockIcon,
  MinusCircleIcon,
  PauseCircleIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import type { TaskViewStatus } from "@/lib/tasks/task-view"

const GLYPH: Record<TaskViewStatus, { icon: LucideIcon; className: string }> = {
  pending: { icon: CircleIcon, className: "text-muted-foreground" },
  in_progress: { icon: ClockIcon, className: "text-amber-600 motion-safe:animate-pulse" },
  completed: { icon: CheckCircle2Icon, className: "text-green-600" },
  failed: { icon: XCircleIcon, className: "text-rose-600" },
  skipped: { icon: MinusCircleIcon, className: "text-muted-foreground" },
  cancelled: { icon: XCircleIcon, className: "text-muted-foreground" },
  blocked: { icon: BanIcon, className: "text-amber-600" },
  stopped: { icon: PauseCircleIcon, className: "text-amber-600" },
}

export interface TaskStatusIconProps {
  status: TaskViewStatus
  className?: string
  /** Announce the status to assistive tech (off when the row says it in text). */
  labelled?: boolean
}

export function TaskStatusIcon({ status, className, labelled = false }: TaskStatusIconProps) {
  const t = useTranslations("tasks.status")
  const { icon: Icon, className: tone } = GLYPH[status] ?? GLYPH.pending
  return (
    <span className="inline-flex shrink-0" data-testid="task-status-icon" data-status={status}>
      <Icon className={cn("size-3.5 shrink-0", tone, className)} aria-hidden />
      {labelled && <span className="sr-only">{t(status)}</span>}
    </span>
  )
}
