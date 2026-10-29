"use client"

/**
 * One transcript row for a run of task bookkeeping calls (`TodoWrite`, or
 * consecutive `TaskCreate` / `TaskUpdate` / `TaskList`): what the run changed —
 * "Done: Run the tests · Started: Deploy · 4/6" — expanding to the list as it
 * stood after it. The whole current list lives in the dock's Tasks panel; the
 * row of the latest change links there.
 *
 * Before/after come from the session's task timeline (`useSessionTaskTimeline`)
 * keyed by tool call id. A message rendered outside its session's store (a
 * shared or imported transcript) falls back to the run's last `TodoWrite`
 * snapshot, shown as the whole list.
 */

import { useMemo, useState } from "react"
import { ListChecksIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { ToolRowShell, type ToolDotStatus } from "@/components/chat/message-parts/tool-row"
import { Button } from "@/components/ui/button"
import { useSessionTaskTimeline } from "@/hooks/chat/use-session-tasks"
import { revealSessionPanel } from "@/lib/artifacts/reveal"
import { SESSION_TASKS_PANEL_ID } from "@/lib/artifacts/session-workbench-scope-key"
import {
  diffTaskSnapshots,
  taskToolKind,
  type SessionTaskTimeline,
  type TaskSnapshotChange,
} from "@/lib/chat/session-tasks"
import { parseTodoInput } from "@/lib/chat/todos"
import { taskItemLabel, type TaskViewItem } from "@/lib/tasks/task-view"
import { cn } from "@/lib/utils"
import { TaskListView } from "./task-list-view"

interface TaskToolPartLike {
  type?: string
  toolName?: string
  toolCallId?: string
  state?: string
  input?: unknown
}

export interface TaskUpdateRowProps {
  /** The conversation whose timeline holds these calls. */
  sessionId?: string | null
  parts: readonly unknown[]
  className?: string
}

/** Before of the first call and after of the last one the timeline knows. */
export function resolveTaskRunChange(
  parts: readonly TaskToolPartLike[],
  timeline: Pick<SessionTaskTimeline, "byToolCallId">
): TaskSnapshotChange | null {
  const known = parts
    .map((part) => (part.toolCallId ? timeline.byToolCallId.get(part.toolCallId) : undefined))
    .filter((change): change is TaskSnapshotChange => Boolean(change))
  if (known.length > 0) {
    const first = known[0]!
    const last = known[known.length - 1]!
    // A run that switched families compares only within the last one.
    const before = first.family === last.family ? first.before : []
    return { before, after: last.after, family: last.family }
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (taskToolKind(part) !== "todo_write") continue
    const todos = parseTodoInput(part.input)
    if (!todos) continue
    return {
      before: [],
      after: todos.map((todo, index) => ({
        id: `todo-${index}`,
        title: todo.content,
        status: todo.status,
        ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
      })),
      family: "todo",
    }
  }
  return null
}

function firstWithMore(items: readonly TaskViewItem[]): { title: string; more: number } {
  return { title: taskItemLabel(items[0]!), more: items.length - 1 }
}

export function TaskUpdateRow({ sessionId, parts, className }: TaskUpdateRowProps) {
  const t = useTranslations("tasks.update")
  const tasksT = useTranslations("tasks")
  const [open, setOpen] = useState(false)
  const timeline = useSessionTaskTimeline(sessionId)
  const typedParts = parts as readonly TaskToolPartLike[]
  const change = useMemo(() => resolveTaskRunChange(typedParts, timeline), [typedParts, timeline])

  const streaming = typedParts.some(
    (part) => part.state === "input-streaming" || part.state === "input-available"
  )
  const lastToolCallId = timeline.current?.lastToolCallId
  const latest =
    Boolean(sessionId && lastToolCallId) &&
    typedParts.some((part) => part.toolCallId === lastToolCallId)

  const summary: string[] = []
  let done = 0
  let total = 0
  if (change) {
    const diff = diffTaskSnapshots(change.before, change.after, change.family)
    done = diff.done
    total = diff.total
    if (change.before.length === 0 && change.after.length > 0) {
      summary.push(t("created", { total }))
    } else {
      if (diff.completed.length > 0) {
        const { title, more } = firstWithMore(diff.completed)
        summary.push(
          more > 0
            ? t("completedMany", { title, more, total: diff.completed.length })
            : t("completed", { title })
        )
      }
      if (diff.started.length > 0)
        summary.push(t("started", { title: firstWithMore(diff.started).title }))
      if (diff.added.length > 0) summary.push(t("added", { count: diff.added.length }))
      if (diff.removed.length > 0) summary.push(t("removed", { count: diff.removed.length }))
      if (summary.length === 0) summary.push(t("unchanged"))
    }
  } else {
    summary.push(t("viewed"))
  }

  const dot: ToolDotStatus = streaming
    ? "running"
    : total > 0 && done === total
      ? "complete"
      : "pending"
  const text = summary.join(" · ")
  const items = change?.after ?? []

  return (
    <ToolRowShell
      className={cn("mb-1 w-full", className)}
      status={dot}
      open={open}
      onToggle={items.length > 0 ? () => setOpen((v) => !v) : undefined}
      ariaLabel={`${t("label")}: ${text}`}
      title={text}
      testId="task-update-row"
      dataKind="tasks"
      icon={<ListChecksIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      target={<span className="min-w-0 flex-1 truncate text-xs text-foreground/80">{text}</span>}
      meta={
        total > 0 ? (
          <span className="tabular-nums" data-testid="task-update-progress">
            {tasksT("progress", { done, total })}
          </span>
        ) : undefined
      }
    >
      {items.length > 0 ? (
        <div className="mb-1 space-y-1.5 border-l pl-3 pt-1">
          <TaskListView items={items} />
          {latest && sessionId ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="-ml-2 h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => revealSessionPanel(sessionId, SESSION_TASKS_PANEL_ID)}
              data-testid="task-update-open-panel"
            >
              {t("openPanel")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </ToolRowShell>
  )
}
