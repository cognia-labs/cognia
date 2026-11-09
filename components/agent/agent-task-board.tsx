"use client"

/**
 * The single-agent task board (the agents console's `?mode=tasks`, ADR-0220).
 *
 * Columns, drag and drop, keyboard movement, the drag overlay and the empty
 * states come from the shared `components/board/kanban-board.tsx`; what a
 * drop means comes from `lib/agent-tasks/board-model.ts` (the shared reducer
 * bound to `AGENT_TASK_MOVE_RULES`). Every move a person makes, by drag or by
 * a card button, goes through `applyAgentTaskMove`, so stopping or resuming
 * work pauses, deletes or resumes the Scheduler task with it.
 */

import { useCallback, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  CalendarClockIcon,
  HistoryIcon,
  LinkIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PlayIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  KanbanBoard,
  type KanbanColumnModel,
  type KanbanDragState,
} from "@/components/board/kanban-board"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { SkillSuggestionCard } from "@/components/chat/skill-suggestion-card"
import { IssuePriorityIcon, IssueStatusIcon } from "@/components/issues/issue-glyphs"
import {
  addAgentTaskComment,
  createAgentTask,
  listAgentTaskAttempts,
  listAgentTasks,
  reorderAgentTasks,
} from "@/lib/db/agent-tasks"
import {
  AgentTaskMoveDeniedError,
  applyAgentTaskMove,
  cancelAgentTask,
  ensureAgentTaskSchedule,
  pauseAgentTask,
  resumeAgentTask,
  runAgentTaskNow,
} from "@/lib/agent-tasks/runtime"
import {
  buildAgentTaskColumns,
  reorderAgentTaskColumn,
  resolveAgentTaskDrop,
  resolveAgentTaskDropPreview,
} from "@/lib/agent-tasks/board-model"
import { allowedAgentTaskMoves } from "@/lib/agent-tasks/state-machine"
import { columnDropId } from "@/lib/board/dnd"
import {
  agentTaskPriorityToIssuePriority,
  agentTaskStatusToIssueStatus,
} from "@/lib/issues/sources/agent-status-map"
import { cn } from "@/lib/utils"
import type { AgentTask, AgentTaskPriority, AgentTaskStatus } from "@/types/agent/agent-task"

type TaskColumnModel = KanbanColumnModel<AgentTaskStatus, AgentTask>
type TaskDrag = KanbanDragState<AgentTask>

const EMPTY_TASKS: AgentTask[] = []
const taskId = (task: AgentTask) => task.id
const taskLabel = (task: AgentTask) => task.title
const columnClassName = () => "rounded-lg bg-muted/40"

/** A toast for a move that failed: the guard's own reason when it refused. */
function useMoveErrorToast() {
  const t = useTranslations("agentTaskBoard")
  return useCallback(
    (error: unknown) => {
      if (error instanceof AgentTaskMoveDeniedError) {
        toast.error(t(`denied.${error.reason}`))
        return
      }
      toast.error(t("error", { message: error instanceof Error ? error.message : String(error) }))
    },
    [t]
  )
}

/** The pointer-following clone: just enough of the card to recognise it. */
function TaskCardPreview({ task }: { task: AgentTask }) {
  return (
    <Card className="w-62 cursor-grabbing gap-0 p-2.5 shadow-lg" data-testid="agent-task-overlay">
      <span className="flex items-start gap-1.5">
        <span className="mt-px shrink-0">
          <IssuePriorityIcon priority={agentTaskPriorityToIssuePriority(task.priority)} />
        </span>
        <span className="line-clamp-2 text-[13px] font-medium leading-snug">{task.title}</span>
      </span>
    </Card>
  )
}

function TaskCard({ task }: { task: AgentTask }) {
  const t = useTranslations("agentTaskBoard")
  const [comment, setComment] = useState("")
  const [expanded, setExpanded] = useState(false)
  const attempts = useLiveQuery(() => listAgentTaskAttempts(task.id), [task.id]) ?? []
  // Sortable under the task id; only the title button carries the drag
  // listeners, so the action buttons and the comment box stay clickable.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })
  const showMoveError = useMoveErrorToast()
  const run = async (operation: () => Promise<unknown>) => {
    try {
      await operation()
    } catch (error) {
      showMoveError(error)
    }
  }

  const actionClass = "h-6 px-2 text-[11px]"

  return (
    <Card
      ref={setNodeRef}
      className={cn("gap-2 p-2.5 shadow-none", isDragging && "opacity-50")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`agent-task-${task.id}`}
    >
      <button
        type="button"
        className="flex w-full cursor-grab items-start gap-1.5 text-left active:cursor-grabbing"
        aria-label={task.title}
        {...listeners}
        {...attributes}
      >
        <span className="mt-px shrink-0" title={t(`priority.${task.priority}`)}>
          <IssuePriorityIcon priority={agentTaskPriorityToIssuePriority(task.priority)} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[13px] font-medium leading-snug">{task.title}</span>
          {task.description && (
            <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
              {task.description}
            </span>
          )}
        </span>
      </button>
      {(task.scheduledFor || task.dependencies.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-5 text-[11px] text-muted-foreground">
          {task.scheduledFor && (
            <span className="inline-flex items-center gap-1">
              <CalendarClockIcon className="size-3" aria-hidden />
              {new Date(task.scheduledFor).toLocaleString()}
            </span>
          )}
          {task.dependencies.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <LinkIcon className="size-3" aria-hidden />
              {t("dependencyCount", { count: task.dependencies.length })}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-1">
        {(["pending", "failed"] as AgentTaskStatus[]).includes(task.status) && (
          <Button
            size="sm"
            className={actionClass}
            onClick={() => void run(() => runAgentTaskNow(task.id))}
          >
            <PlayIcon className="size-3" /> {task.status === "failed" ? t("retry") : t("start")}
          </Button>
        )}
        {task.status === "paused" && (
          <Button
            size="sm"
            className={actionClass}
            onClick={() => void run(() => resumeAgentTask(task.id))}
          >
            {t("resume")}
          </Button>
        )}
        {task.status === "in_progress" && (
          <Button
            size="sm"
            variant="outline"
            className={actionClass}
            onClick={() => void run(() => pauseAgentTask(task.id))}
          >
            {t("pause")}
          </Button>
        )}
        {task.status === "review" && (
          <>
            <Button
              size="sm"
              className={actionClass}
              onClick={() => void run(() => applyAgentTaskMove(task.id, "completed"))}
            >
              {t("approve")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={actionClass}
              onClick={() => void run(() => applyAgentTaskMove(task.id, "failed"))}
            >
              {t("reject")}
            </Button>
          </>
        )}
        {allowedAgentTaskMoves(task.status).includes("cancelled") && (
          <Button
            size="sm"
            variant="ghost"
            className={cn(actionClass, "text-muted-foreground")}
            onClick={() => void run(() => cancelAgentTask(task.id))}
          >
            {t("cancel")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 gap-1 px-1.5 text-[11px] text-muted-foreground tabular-nums"
          aria-label={t("details", { attempts: attempts.length, comments: task.comments.length })}
          aria-expanded={expanded}
          title={t("details", { attempts: attempts.length, comments: task.comments.length })}
          onClick={() => setExpanded((value) => !value)}
        >
          <HistoryIcon className="size-3" aria-hidden />
          {attempts.length}
          <MessageSquareIcon className="ml-1 size-3" aria-hidden />
          {task.comments.length}
        </Button>
      </div>
      {expanded && (
        <div className="space-y-2 border-t pt-2">
          {attempts.map((attempt) => (
            <div key={attempt.id} className="space-y-1">
              <p className="text-[10px] text-muted-foreground">
                {t("attempt", {
                  number: attempt.attemptNo,
                  status: t(`attemptStatus.${attempt.status}`),
                })}
              </p>
              <SkillSuggestionCard
                source={{
                  kind: "run",
                  runId: attempt.id,
                  ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
                }}
                outcome={{
                  completed: attempt.status === "completed" || attempt.status === "review",
                  turns: attempt.result?.trim() ? 2 : 0,
                  errorCount: 0,
                  denialCount: 0,
                  toolCallTotal: attempt.result?.trim() ? 2 : 0,
                  passedTests: 0,
                  failedTests: 0,
                  commitCount: 0,
                }}
              />
            </div>
          ))}
          {task.comments.map((entry) => (
            <p key={entry.id} className="rounded bg-muted px-2 py-1 text-[10px]">
              {entry.text}
            </p>
          ))}
          <div className="flex gap-1">
            <Input
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={t("commentPlaceholder")}
              className="h-7 text-[11px]"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={!comment.trim()}
              onClick={() =>
                void run(async () => {
                  await addAgentTaskComment(task.id, {
                    id: crypto.randomUUID(),
                    author: "user",
                    text: comment,
                  })
                  setComment("")
                })
              }
            >
              {t("comment")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

/**
 * The durable-task form for one agent: title, priority, description, approval
 * policy, schedule and dependencies. Shared by the board below and by the
 * agents console's "Assign work" dialog (ADR-0220), so both create a task the
 * same way, scheduling included.
 */
export function AgentTaskCreateForm({
  agentId,
  onCreated,
  className,
}: {
  agentId: string
  onCreated?: (task: AgentTask) => void
  className?: string
}) {
  const t = useTranslations("agentTaskBoard")
  const tasks = useLiveQuery(() => listAgentTasks(agentId), [agentId]) ?? EMPTY_TASKS
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<AgentTaskPriority>("normal")
  const [approvalPolicy, setApprovalPolicy] = useState<AgentTask["approvalPolicy"]>("on-risk")
  const [scheduledFor, setScheduledFor] = useState("")
  const [dependencies, setDependencies] = useState<string[]>([])

  const create = async () => {
    try {
      const task = await createAgentTask({
        agentId,
        title,
        description,
        priority,
        approvalPolicy,
        dependencies,
        scheduledFor: scheduledFor ? new Date(scheduledFor).getTime() : undefined,
      })
      if (task.scheduledFor) await ensureAgentTaskSchedule(task.id)
      setTitle("")
      setDescription("")
      setScheduledFor("")
      setDependencies([])
      onCreated?.(task)
    } catch (error) {
      toast.error(t("error", { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  return (
    <div
      className={cn(
        "grid gap-2 rounded-lg border border-transparent bg-muted/50 p-3 sm:grid-cols-2",
        className
      )}
      data-testid="agent-task-create-form"
    >
      <div className="space-y-1">
        <Label htmlFor={`agent-task-title-${agentId}`}>{t("titleLabel")}</Label>
        <Input
          id={`agent-task-title-${agentId}`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("priorityLabel")}</Label>
        <Select value={priority} onValueChange={(value) => setPriority(value as AgentTaskPriority)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["low", "normal", "high", "critical"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {t(`priority.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={`agent-task-description-${agentId}`}>{t("descriptionLabel")}</Label>
        <Textarea
          id={`agent-task-description-${agentId}`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("approvalLabel")}</Label>
        <Select
          value={approvalPolicy}
          onValueChange={(value) => setApprovalPolicy(value as AgentTask["approvalPolicy"])}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["auto", "on-risk", "manual"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {t(`approval.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`agent-task-schedule-${agentId}`}>{t("scheduleLabel")}</Label>
        <Input
          id={`agent-task-schedule-${agentId}`}
          type="datetime-local"
          value={scheduledFor}
          onChange={(event) => setScheduledFor(event.target.value)}
        />
      </div>
      {tasks.length > 0 && (
        <div className="space-y-1 sm:col-span-2">
          <Label>{t("dependenciesLabel")}</Label>
          <div className="flex flex-wrap gap-2">
            {tasks.map((task) => (
              <label key={task.id} className="flex items-center gap-1 text-xs">
                <Checkbox
                  checked={dependencies.includes(task.id)}
                  onCheckedChange={(checked) =>
                    setDependencies((current) =>
                      checked ? [...current, task.id] : current.filter((id) => id !== task.id)
                    )
                  }
                />
                {task.title}
              </label>
            ))}
          </div>
        </div>
      )}
      <Button disabled={!title.trim()} onClick={() => void create()} className="sm:col-span-2">
        {t("create")}
      </Button>
    </div>
  )
}

export function AgentTaskBoard({
  agentId,
  showCreateForm = true,
  emptyState,
  className,
}: {
  agentId: string
  /**
   * Give the board a bounded height (e.g. `min-h-0 flex-1` in a flex column)
   * and the columns fill it, each scrolling its own cards.
   */
  className?: string
  /** The agents console opens the form from its header instead (ADR-0220). */
  showCreateForm?: boolean
  /**
   * Shown instead of the board's own empty panel. The default panel points at
   * the inline form above it, which a host without the form must not say.
   */
  emptyState?: React.ReactNode
}) {
  const t = useTranslations("agentTaskBoard")
  const tasks = useLiveQuery(() => listAgentTasks(agentId), [agentId]) ?? EMPTY_TASKS
  const showMoveError = useMoveErrorToast()
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const columns = useMemo<TaskColumnModel[]>(
    () =>
      buildAgentTaskColumns(tasks).map((column) => ({ id: column.status, items: column.tasks })),
    [tasks]
  )

  const columnLabel = useCallback((status: AgentTaskStatus) => t(`status.${status}`), [t])

  // Only the card's own column and the guard's targets stay open mid-drag.
  const isDimmed = useCallback((column: TaskColumnModel, drag: TaskDrag) => {
    const active = drag.activeItem
    if (!active || active.status === column.id) return false
    return !allowedAgentTaskMoves(active.status).includes(column.id)
  }, [])

  /** Cross-column only: the sortable strategy's gap already shows a reorder. */
  const insertionIndex = useCallback(
    (column: TaskColumnModel, drag: TaskDrag) => {
      const active = drag.activeItem
      if (!active || active.status === column.id) return null
      const preview = resolveAgentTaskDropPreview(drag.activeId, drag.overId, tasksById)
      return preview !== null && preview.status === column.id ? preview.index : null
    },
    [tasksById]
  )

  const handleDrop = (activeId: string, overId: string | null) => {
    const action = resolveAgentTaskDrop(activeId, overId, tasksById)
    if (!action) return
    if (action.type === "denied") {
      toast.error(t(`denied.${action.reason}`))
      return
    }
    const write =
      action.type === "reorder"
        ? reorderAgentTasks(reorderAgentTaskColumn(tasksById, action.itemId, action.targetIndex))
        : applyAgentTaskMove(action.itemId, action.to, undefined, action.targetIndex)
    void write.catch(showMoveError)
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-4", className)} data-testid="agent-task-board">
      {showCreateForm ? <AgentTaskCreateForm agentId={agentId} /> : null}
      <KanbanBoard<AgentTaskStatus, AgentTask>
        columns={columns}
        itemId={taskId}
        itemLabel={taskLabel}
        columnLabel={columnLabel}
        dropId={columnDropId}
        renderColumnIcon={(column) => (
          <IssueStatusIcon status={agentTaskStatusToIssueStatus(column.id)} className="size-3.5" />
        )}
        columnClassName={columnClassName}
        renderCard={(task) => <TaskCard key={task.id} task={task} />}
        renderOverlay={(task) => <TaskCardPreview task={task} />}
        isDimmed={isDimmed}
        insertionIndex={insertionIndex}
        onDrop={handleDrop}
        emptyState={
          emptyState ?? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <ListTodoIcon className="mx-auto mb-2 size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t("emptyTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("emptyDescription")}</p>
            </div>
          )
        }
        emptyText={t("emptyColumn")}
        testId="agent-task-columns"
        testIdPrefix="agent-task"
        className="min-h-0 flex-1 p-0 pb-1"
      />
    </div>
  )
}
