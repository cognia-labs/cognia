/**
 * The session's current task list, derived from the transcript.
 *
 * The agent keeps its own task list with one of two tool families:
 *
 *   - `TodoWrite` — stateless; every call carries the full list.
 *   - `TaskCreate` / `TaskUpdate` / `TaskList` — incremental; `TaskCreate`
 *     returns a stable id, `TaskUpdate` patches (or deletes) one task by id,
 *     and `TaskList` returns the whole graph. Both the Claude Agent SDK and the
 *     sidecar's core tools (`sidecar/src/tools/builtin/core-files/tasks.ts`)
 *     emit these.
 *
 * Both are folded here, in transcript order, into one list of
 * {@link TaskViewItem}s. The family called last wins; the two are never
 * merged, because their ids cannot be matched up. The list is session-level:
 * a later turn that writes no tasks does not clear it.
 *
 * Every task tool call also gets a before/after snapshot, so the transcript
 * can render one line saying what that call changed instead of redrawing the
 * whole list each time.
 *
 * Pure. Per-message extraction is memoized on the message object: a streamed
 * frame replaces only the message being written, so a long history is not
 * re-walked on every frame.
 */

import type { UIMessage } from "ai"

import { parseTodoInput } from "@/lib/chat/todos"
import type { TaskViewItem, TaskViewStatus } from "@/lib/tasks/task-view"

export type TaskToolKind = "todo_write" | "task_create" | "task_update" | "task_list"

const TASK_TOOL_NAMES: Record<string, TaskToolKind> = {
  TodoWrite: "todo_write",
  TaskCreate: "task_create",
  TaskUpdate: "task_update",
  TaskList: "task_list",
}

/**
 * Namespaces the host registers its own task tools under. A third-party MCP
 * server's `TodoWrite` is someone else's tool and stays a generic tool card.
 */
const HOST_TOOL_PREFIXES = ["mcp__cognia-tools__", "mcp__cognia-plugin-tools__"]

function bareToolName(part: { type?: unknown; toolName?: unknown }): string | null {
  const type = part.type
  if (typeof type !== "string") return null
  let name: string | null = null
  if (type === "dynamic-tool") name = typeof part.toolName === "string" ? part.toolName : null
  else if (type.startsWith("tool-")) name = type.slice("tool-".length)
  if (!name) return null
  for (const prefix of HOST_TOOL_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return name
}

/** The task tool a message part calls, or null for anything else. */
export function taskToolKind(part: unknown): TaskToolKind | null {
  if (!part || typeof part !== "object") return null
  const name = bareToolName(part as { type?: unknown; toolName?: unknown })
  return name ? (TASK_TOOL_NAMES[name] ?? null) : null
}

export type TaskFamily = "todo" | "tasks"

interface TaskToolEvent {
  kind: TaskToolKind
  toolCallId: string
  messageId: string
  input: unknown
  output: unknown
  failed: boolean
}

const eventCache = new WeakMap<UIMessage, TaskToolEvent[]>()

function extractEvents(message: UIMessage): TaskToolEvent[] {
  const cached = eventCache.get(message)
  if (cached) return cached
  const events: TaskToolEvent[] = []
  if (message.role === "assistant") {
    message.parts?.forEach((part, index) => {
      const kind = taskToolKind(part)
      if (!kind) return
      const p = part as {
        toolCallId?: unknown
        input?: unknown
        output?: unknown
        state?: unknown
      }
      events.push({
        kind,
        toolCallId:
          typeof p.toolCallId === "string" && p.toolCallId
            ? p.toolCallId
            : `${message.id}:${index}`,
        messageId: message.id,
        input: p.input,
        output: p.output,
        failed: p.state === "output-error",
      })
    })
  }
  eventCache.set(message, events)
  return events
}

// ── output parsing (SDK text and sidecar JSON) ─────────────────────────────

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string") return null
  const text = value.trim()
  if (!text.startsWith("{")) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Tool output as text: plain strings, or MCP-style `[{type:"text",text}]` content. */
function outputText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const texts = value
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : ""
      )
      .filter(Boolean)
    return texts.length > 0 ? texts.join("\n") : null
  }
  return null
}

/** The id `TaskCreate` assigned: `{task:{id}}` JSON, or SDK text "Task #3 created …". */
export function parseCreatedTaskId(output: unknown): string | null {
  const text = outputText(output)
  const json = parseJsonObject(text ?? output)
  const task = json?.task
  if (task && typeof task === "object") {
    const id = (task as { id?: unknown }).id
    if (typeof id === "string" && id) return id
    if (typeof id === "number") return String(id)
  }
  if (text) {
    const match = /#([\w-]+)/.exec(text) ?? /\btask\s+([\w-]+)\s+created/i.exec(text)
    if (match?.[1]) return match[1]
  }
  return null
}

function taskStatusFrom(value: unknown): TaskViewStatus | null {
  if (value === "pending" || value === "in_progress" || value === "completed") return value
  return null
}

interface ListedTask {
  id: string
  subject: string
  status: TaskViewStatus
}

/** A `TaskList` result: `{tasks:[…]}` JSON, or SDK lines like "#1 [completed] Subject". */
export function parseTaskListOutput(output: unknown): ListedTask[] | null {
  const text = outputText(output)
  const json = parseJsonObject(text ?? output)
  if (json && Array.isArray(json.tasks)) {
    const out: ListedTask[] = []
    for (const raw of json.tasks) {
      if (!raw || typeof raw !== "object") continue
      const t = raw as { id?: unknown; subject?: unknown; status?: unknown }
      const id = typeof t.id === "number" ? String(t.id) : t.id
      if (typeof id !== "string" || typeof t.subject !== "string") continue
      out.push({ id, subject: t.subject, status: taskStatusFrom(t.status) ?? "pending" })
    }
    return out
  }
  if (!text) return null
  const out: ListedTask[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*#?([\w-]+)\.?\s*\[(pending|in_progress|completed)\]\s*(.+?)\s*$/.exec(line)
    if (match) out.push({ id: match[1]!, status: match[2] as TaskViewStatus, subject: match[3]! })
  }
  return out.length > 0 ? out : /no tasks/i.test(text) ? [] : null
}

// ── fold ────────────────────────────────────────────────────────────────────

export interface TaskSnapshotChange {
  before: readonly TaskViewItem[]
  after: readonly TaskViewItem[]
  family: TaskFamily
}

export interface SessionTaskList {
  family: TaskFamily
  items: readonly TaskViewItem[]
  /** The task tool call that last changed the list. */
  lastToolCallId: string
  lastMessageId: string
}

export interface SessionTaskTimeline {
  current: SessionTaskList | null
  /** Before/after of the family's list around each task tool call. */
  byToolCallId: ReadonlyMap<string, TaskSnapshotChange>
}

const EMPTY: readonly TaskViewItem[] = []

/** Fold every task tool call of the transcript, oldest first. */
export function deriveSessionTasks(messages: readonly UIMessage[]): SessionTaskTimeline {
  let todoItems: readonly TaskViewItem[] = EMPTY
  // Insertion order of a Map is the creation order the list renders in.
  let taskItems = new Map<string, TaskViewItem>()
  let family: TaskFamily | null = null
  let last: { toolCallId: string; messageId: string } | null = null
  const byToolCallId = new Map<string, TaskSnapshotChange>()

  const taskList = (): readonly TaskViewItem[] => [...taskItems.values()]

  for (const message of messages) {
    for (const event of extractEvents(message)) {
      if (event.failed) continue
      if (event.kind === "todo_write") {
        const parsed = parseTodoInput(event.input)
        if (!parsed) continue
        const before = todoItems
        todoItems = parsed.map((todo, i) => ({
          id: `todo-${i}`,
          title: todo.content,
          status: todo.status,
          ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
        }))
        family = "todo"
        last = { toolCallId: event.toolCallId, messageId: event.messageId }
        byToolCallId.set(event.toolCallId, { before, after: todoItems, family: "todo" })
        continue
      }

      const before = taskList()
      const input = (event.input ?? {}) as Record<string, unknown>
      let changed = false
      if (event.kind === "task_create") {
        const subject = typeof input.subject === "string" ? input.subject.trim() : ""
        if (!subject) continue
        // In flight: no id yet. A provisional key keeps the row on screen; the
        // next derivation (output arrived) replaces it with the real id.
        const id = parseCreatedTaskId(event.output) ?? `pending:${event.toolCallId}`
        const activeForm = typeof input.activeForm === "string" ? input.activeForm : undefined
        taskItems.set(id, {
          id,
          title: subject,
          status: "pending",
          ...(activeForm ? { activeForm } : {}),
        })
        changed = true
      } else if (event.kind === "task_update") {
        const id =
          typeof input.taskId === "string"
            ? input.taskId
            : typeof input.taskId === "number"
              ? String(input.taskId)
              : null
        if (!id) continue
        if (input.status === "deleted") {
          changed = taskItems.delete(id)
        } else {
          const existing = taskItems.get(id)
          const subject = typeof input.subject === "string" ? input.subject.trim() : ""
          const status = taskStatusFrom(input.status)
          // A task created before the loaded history: keep it visible by id.
          const base: TaskViewItem = existing ?? {
            id,
            title: subject || `#${id}`,
            status: "pending",
          }
          const next: TaskViewItem = {
            ...base,
            ...(subject ? { title: subject } : {}),
            ...(status ? { status } : {}),
          }
          if (input.activeForm === null) delete next.activeForm
          else if (typeof input.activeForm === "string") next.activeForm = input.activeForm
          taskItems.set(id, next)
          changed = true
        }
      } else {
        const listed = parseTaskListOutput(event.output)
        if (!listed) continue
        const previous = taskItems
        taskItems = new Map(
          listed.map((t) => {
            const prior = previous.get(t.id)
            return [
              t.id,
              {
                id: t.id,
                title: t.subject,
                status: t.status,
                ...(prior?.activeForm ? { activeForm: prior.activeForm } : {}),
              },
            ]
          })
        )
        changed = true
      }
      if (!changed) continue
      family = "tasks"
      last = { toolCallId: event.toolCallId, messageId: event.messageId }
      byToolCallId.set(event.toolCallId, { before, after: taskList(), family: "tasks" })
    }
  }

  const items = family === "todo" ? todoItems : family === "tasks" ? taskList() : EMPTY
  return {
    current:
      family && last && items.length > 0
        ? { family, items, lastToolCallId: last.toolCallId, lastMessageId: last.messageId }
        : null,
    byToolCallId,
  }
}

// ── diff ────────────────────────────────────────────────────────────────────

export interface TaskListDiff {
  completed: TaskViewItem[]
  started: TaskViewItem[]
  added: TaskViewItem[]
  removed: TaskViewItem[]
  /** The list after the change. */
  done: number
  total: number
}

/**
 * What changed between two snapshots. Items are matched by id for the
 * incremental family and by title for `TodoWrite` (its ids are positional,
 * and a rewritten list reorders freely).
 */
export function diffTaskSnapshots(
  before: readonly TaskViewItem[],
  after: readonly TaskViewItem[],
  family: TaskFamily
): TaskListDiff {
  const key = (item: TaskViewItem) => (family === "todo" ? item.title : item.id)
  const prior = new Map(before.map((item) => [key(item), item]))
  const nextKeys = new Set(after.map(key))
  const completed: TaskViewItem[] = []
  const started: TaskViewItem[] = []
  const added: TaskViewItem[] = []
  for (const item of after) {
    const old = prior.get(key(item))
    if (!old) {
      added.push(item)
      continue
    }
    if (item.status === old.status) continue
    if (item.status === "completed") completed.push(item)
    else if (item.status === "in_progress") started.push(item)
  }
  return {
    completed,
    started,
    added,
    removed: before.filter((item) => !nextKeys.has(key(item))),
    done: after.filter((item) => item.status === "completed").length,
    total: after.length,
  }
}
