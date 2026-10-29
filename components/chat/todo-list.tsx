"use client"

/**
 * `<TodoList>` — the structured checklist rendered from Claude's `TodoWrite`
 * tool snapshot. Extracted from the transcript renderer so the same list is
 * reused by the Run Panel's Plan section, keeping a single visual treatment for
 * plan progress wherever it appears.
 */
import { useMemo, useState } from "react"
import { ListChecksIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { ToolRowShell, type ToolDotStatus } from "@/components/chat/message-parts/tool-row"
import { TaskListView } from "@/components/tasks/task-list-view"
import { cn } from "@/lib/utils"
import { countCompletedTodos, type TodoEntry } from "@/lib/chat/todos"
import type { TaskViewItem } from "@/lib/tasks/task-view"

export interface TodoListProps {
  todos: readonly TodoEntry[]
  /** Whether the collapsible opens by default (transcript: true). */
  defaultOpen?: boolean
  className?: string
}

export function TodoList({ todos, defaultOpen = true, className }: TodoListProps) {
  const t = useTranslations("chat.message")
  const [open, setOpen] = useState(defaultOpen)
  const completed = countCompletedTodos(todos)
  const items = useMemo<TaskViewItem[]>(
    () =>
      todos.map((todo, i) => ({
        id: `todo-${i}`,
        title: todo.content,
        status: todo.status,
        ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
      })),
    [todos]
  )
  const title = t("todoPlanTitle", { done: completed, total: todos.length })
  // The plan snapshot is an activity row like the tool calls around it: the
  // dot breathes while any item is in progress and settles green once all are
  // done; the checklist expands under the left rule.
  const status: ToolDotStatus =
    completed === todos.length
      ? "complete"
      : todos.some((todo) => todo.status === "in_progress")
        ? "running"
        : "pending"
  return (
    <ToolRowShell
      className={cn("mb-2 w-full", className)}
      status={status}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      ariaLabel={title}
      testId="todo-list"
      lead={<span className="shrink-0 text-xs font-medium text-foreground/80">{title}</span>}
      icon={<ListChecksIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      target={<span className="flex-1" />}
    >
      <TaskListView items={items} className="mb-1 border-l pl-3 pt-1" />
    </ToolRowShell>
  )
}
