/**
 * Pure parsing for Claude's `TodoWrite` tool payload — shared by the session
 * task derivation (`session-tasks.ts`) and the run-record aggregator. No React,
 * no I/O, so the snapshot semantics are unit tested in isolation.
 */

/** One todo item from a `TodoWrite` snapshot. */
export interface TodoEntry {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm?: string
}

const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"])

/**
 * Parse a `TodoWrite` tool input into a todo list, or `null` when the payload
 * holds no usable entry (caller then falls through to generic rendering).
 * `TodoWrite` is an authoritative full snapshot: each call carries the
 * complete list, so a later snapshot fully replaces an earlier one.
 *
 * Tolerant per entry: the input streams in, and one half-written or malformed
 * entry must not flip the whole list back to a generic tool card. Entries
 * without string `content` are skipped; an unknown status reads as `pending`.
 */
export function parseTodoInput(input: unknown): TodoEntry[] | null {
  if (!input || typeof input !== "object") return null
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return null
  const out: TodoEntry[] = []
  for (const t of todos) {
    if (!t || typeof t !== "object") continue
    const content = (t as { content?: unknown }).content
    if (typeof content !== "string" || !content.trim()) continue
    const status = (t as { status?: unknown }).status
    const activeForm = (t as { activeForm?: unknown }).activeForm
    out.push({
      content,
      status:
        typeof status === "string" && TODO_STATUSES.has(status)
          ? (status as TodoEntry["status"])
          : "pending",
      activeForm: typeof activeForm === "string" && activeForm ? activeForm : undefined,
    })
  }
  return out.length > 0 ? out : null
}

/** Count of completed todos in a snapshot. */
export function countCompletedTodos(todos: readonly TodoEntry[]): number {
  return todos.filter((t) => t.status === "completed").length
}
