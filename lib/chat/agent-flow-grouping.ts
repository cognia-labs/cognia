/**
 * Pure segmentation of an assistant message's parts into render segments for
 * the agent-flow display: runs of ≥2 consecutive tool calls collapse into one
 * "activity group", everything else stays a single segment.
 *
 * Grouping is *mode-aware*. In `standard` / `detailed` every tool (bar
 * TodoWrite) folds. In `simplified` only context-gathering reads fold (the
 * TUI's `groupContextRuns` philosophy) — see {@link isContextFoldPart} — so
 * edits, writes and commands stand as their own prominent rows.
 *
 * Sub-agent parts are transparent to grouping — they render once as a dispatch
 * tree at the message level, so they neither join nor break a tool run.
 *
 * Task bookkeeping calls (`TodoWrite`, `TaskCreate` / `TaskUpdate` /
 * `TaskList`, in any spelling the host registers, `dynamic-tool` included)
 * never fold into an activity group: a run of them becomes one `tasks`
 * segment, which the renderer draws as a single "what changed in the task
 * list" row instead of one card per call.
 */

import { taskToolKind } from "./session-tasks"
import { isContextFoldPart } from "./tool-summary"
import type { AgentFlowMode } from "@/types/appearance"

export const MIN_GROUP_SIZE = 2

export interface PartEntry<P> {
  part: P
  /** Original index in `message.parts` (used for stable keys). */
  index: number
}

export type AgentFlowSegment<P> =
  | { kind: "single"; entry: PartEntry<P> }
  | { kind: "group"; entries: PartEntry<P>[] }
  | { kind: "tasks"; entries: PartEntry<P>[] }

/** True for a task-list bookkeeping call (see the module note). */
export function isTaskToolPart<P extends { type?: string; toolName?: string }>(part: P): boolean {
  return taskToolKind(part) !== null
}

/**
 * True for any tool-call part type — `tool-*`, plus the AI SDK's
 * `dynamic-tool` shape for a tool the client never declared statically (it
 * carries the name on `part.toolName`). Both reach the renderer: imported
 * sessions and CLI handoff transcripts can hold `dynamic-tool` parts.
 */
export function isToolPartType(type: string | undefined): boolean {
  return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool")
}

/** True for tool parts that participate in activity grouping. */
export function isGroupableToolType(type: string | undefined): boolean {
  if (!isToolPartType(type)) return false
  // Task bookkeeping renders as its own task row, not a tool card.
  return taskToolKind({ type }) === null
}

/**
 * Part-level companion to {@link isGroupableToolType}; also sees the name a
 * `dynamic-tool` part carries on `toolName`.
 */
export function isGroupableToolPart<P extends { type?: string; toolName?: string }>(
  part: P
): boolean {
  return isToolPartType(part?.type) && !isTaskToolPart(part)
}

/** AI SDK structural/control part types the renderer draws nothing for. */
export const SILENT_CONTROL_PART_TYPES: ReadonlySet<string> = new Set(["step-start", "step-finish"])

/**
 * True for parts that render nothing inline, so they are transparent to
 * grouping — they neither emit a segment nor break a run.
 *
 * The empty-`text` case is load-bearing: a model that emits no prose between
 * two tool calls still produces a zero-length text part, which would otherwise
 * flush the run and split one activity group into two.
 *
 * Sub-agent parts render once as a dispatch tree at the message level, never
 * inline, so they are transparent here too.
 */
export function isTransparentPart<P extends { type?: string }>(part: P): boolean {
  const type = part?.type
  if (!type) return true
  if (type === "subagent") return true
  if (SILENT_CONTROL_PART_TYPES.has(type)) return true
  if (type === "text") return !((part as { text?: string }).text ?? "").trim()
  return false
}

/**
 * True when a message carries tool calls and nothing a reader could act on —
 * no prose, no artifact, no sources. Such a turn has nothing to copy, quote,
 * read aloud or turn into a card, so the renderer gives it no action bar.
 */
export function isToolOnlyFlow<P extends { type?: string }>(parts: P[]): boolean {
  let sawTool = false
  for (const part of parts) {
    if (isTransparentPart(part)) continue
    if (!isToolPartType(part?.type)) return false
    sawTool = true
  }
  return sawTool
}

export function groupAgentParts<P extends { type?: string }>(
  parts: P[],
  mode: AgentFlowMode = "standard"
): AgentFlowSegment<P>[] {
  // Simplified mode adopts the TUI's selective folding: only context-gathering
  // reads (read/search/glob/list/web) fold; every other tool breaks the run and
  // stands alone. Standard/detailed keep the "any tool folds" behaviour.
  //
  // Both predicates take the whole part, not its type: `dynamic-tool` carries
  // its name on `toolName`, so a type-only check would silently refuse to fold
  // every imported / CLI-handoff read burst in simplified mode.
  const isGroupable: (part: P) => boolean =
    mode === "simplified" ? isContextFoldPart : isGroupableToolPart

  const segments: AgentFlowSegment<P>[] = []
  let run: PartEntry<P>[] = []
  let taskRun: PartEntry<P>[] = []

  const flush = () => {
    if (run.length >= MIN_GROUP_SIZE) {
      segments.push({ kind: "group", entries: run })
    } else {
      for (const entry of run) segments.push({ kind: "single", entry })
    }
    run = []
  }
  const flushTasks = () => {
    if (taskRun.length > 0) segments.push({ kind: "tasks", entries: taskRun })
    taskRun = []
  }

  parts.forEach((part, index) => {
    if (isTransparentPart(part)) return
    if (isTaskToolPart(part as P & { toolName?: string })) {
      flush()
      taskRun.push({ part, index })
      return
    }
    flushTasks()
    if (isGroupable(part)) {
      run.push({ part, index })
      return
    }
    flush()
    segments.push({ kind: "single", entry: { part, index } })
  })
  flush()
  flushTasks()

  return segments
}
