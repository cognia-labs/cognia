/**
 * Split one step's run events into execution instances.
 *
 * A step can run several times in one run: each retry attempt and each loop
 * iteration is its own execution, and the runtime stamps every event of one
 * execution with the same `stepExecutionId` (`lib/workflow/runtime/event-log.ts`
 * `StepEventMeta`). Reading a step's events by `stepId` alone mixes the first
 * execution's inputs with the last execution's output and usage; grouping by
 * the id keeps each execution's evidence together.
 *
 * Events with no id (rows written before execution identity existed, and
 * step-level events such as an orchestrator skip) fall into one
 * `unattributed` group, so old runs still render.
 */

import type { WorkflowRunEventRow } from "@/types/workflow/visual"

export type StepExecutionStatus = "running" | "completed" | "failed" | "skipped"

export interface StepUsageSnapshot {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
  providerId?: string
  modelId?: string
}

export interface StepExecutionView {
  /** `stepExecutionId`, or `UNATTRIBUTED_EXECUTION_KEY`. */
  key: string
  stepExecutionId?: string
  attempt?: number
  loopId?: string
  iterationIndex?: number
  events: WorkflowRunEventRow[]
  started?: WorkflowRunEventRow
  /** The execution's last terminal event (a handled failure ends in `step_completed`). */
  terminal?: WorkflowRunEventRow
  failed?: WorkflowRunEventRow
  completed?: WorkflowRunEventRow
  skipped?: WorkflowRunEventRow
  status: StepExecutionStatus
  firstTs: number
  lastTs: number
  /** Latest usage snapshot of this execution (snapshots are cumulative per execution). */
  usage?: StepUsageSnapshot
}

export const UNATTRIBUTED_EXECUTION_KEY = "unattributed"

type Meta = {
  stepExecutionId?: unknown
  attempt?: unknown
  loopId?: unknown
  iterationIndex?: unknown
}

function metaOf(event: WorkflowRunEventRow): Meta {
  const payload = event.payload
  return payload && typeof payload === "object" ? (payload as Meta) : {}
}

const TERMINAL = new Set(["step_completed", "step_failed", "step_skipped"])

export interface GroupedStepExecutions {
  /** Executions in first-event order. */
  executions: StepExecutionView[]
  /**
   * Events tied to the step but to no execution (a log written between
   * attempts). Shown with every execution, never counted as one.
   */
  stepLevelEvents: WorkflowRunEventRow[]
}

/** Split one step's events (in time order) into its executions. */
export function groupStepExecutions(events: readonly WorkflowRunEventRow[]): GroupedStepExecutions {
  const groups = new Map<string, StepExecutionView>()
  for (const event of events) {
    const meta = metaOf(event)
    const id = typeof meta.stepExecutionId === "string" ? meta.stepExecutionId : undefined
    const key = id ?? UNATTRIBUTED_EXECUTION_KEY
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        ...(id ? { stepExecutionId: id } : {}),
        events: [],
        status: "running",
        firstTs: event.ts,
        lastTs: event.ts,
      }
      groups.set(key, group)
    }
    group.events.push(event)
    group.lastTs = Math.max(group.lastTs, event.ts)
    if (typeof meta.attempt === "number") group.attempt = meta.attempt
    if (typeof meta.loopId === "string") group.loopId = meta.loopId
    if (typeof meta.iterationIndex === "number") group.iterationIndex = meta.iterationIndex
    switch (event.type) {
      case "step_started":
        group.started ??= event
        break
      case "step_completed":
        group.completed = event
        break
      case "step_failed":
        group.failed = event
        break
      case "step_skipped":
        group.skipped = event
        break
      case "step_usage":
        group.usage = (event.payload as StepUsageSnapshot | undefined) ?? group.usage
        break
    }
    if (TERMINAL.has(event.type)) group.terminal = event
  }
  for (const group of groups.values()) {
    const terminal = group.terminal?.type
    group.status =
      terminal === "step_completed"
        ? "completed"
        : terminal === "step_failed"
          ? "failed"
          : terminal === "step_skipped"
            ? "skipped"
            : "running"
  }
  const unattributed = groups.get(UNATTRIBUTED_EXECUTION_KEY)
  let stepLevelEvents: WorkflowRunEventRow[] = []
  if (unattributed && !unattributed.started && !unattributed.terminal) {
    groups.delete(UNATTRIBUTED_EXECUTION_KEY)
    stepLevelEvents = unattributed.events
  }
  return {
    executions: [...groups.values()].sort((a, b) => a.firstTs - b.firstTs),
    stepLevelEvents,
  }
}

export interface StepExecutionsSummary {
  executionCount: number
  /** First event of the first execution to the last event of the latest. */
  durationMs: number
  /** Status of the latest execution. */
  status: StepExecutionStatus
  totalTokens: number
  inputTokens: number
  outputTokens: number
  /** Sum of the executions' known costs; undefined when none reported one. */
  costUsd?: number
}

/** Aggregate over every execution, kept apart from any single execution's details. */
export function summarizeStepExecutions(
  executions: readonly StepExecutionView[]
): StepExecutionsSummary | null {
  const latest = executions.at(-1)
  if (!latest) return null
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let costUsd: number | undefined
  for (const execution of executions) {
    const usage = execution.usage
    if (!usage) continue
    totalTokens += usage.totalTokens ?? 0
    inputTokens += usage.inputTokens ?? 0
    outputTokens += usage.outputTokens ?? 0
    if (typeof usage.costUsd === "number") costUsd = (costUsd ?? 0) + usage.costUsd
  }
  const first = executions[0]
  const end = Math.max(...executions.map((execution) => execution.lastTs))
  return {
    executionCount: executions.length,
    durationMs: Math.max(0, end - first.firstTs),
    status: latest.status,
    totalTokens,
    inputTokens,
    outputTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}
