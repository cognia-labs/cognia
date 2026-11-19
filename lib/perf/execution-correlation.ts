/** Explicit joins between encrypted captures and canonical execution evidence.
 * Time overlap is not proof of resource ownership. Scope always comes from the
 * selected account/target database, never from association metadata or a URL.
 */
import type { CogniaDB } from "@/lib/db/schema"
import { isTerminalRunStatus } from "@/types/execution/run"
import { isAgentTraceSpanActive } from "@cognia/agent-trace/emitter"

export interface PerformanceExecutionContext {
  runId?: string
  traceId?: string
}

export interface PerformanceExecutionAssociation extends PerformanceExecutionContext {
  version: 1
  relationship: "explicit"
  sessionId?: string
  turnId?: string
  attemptId?: string
  spanId?: string
  executionStartedAt?: number
  executionEndedAt?: number
}

export function executionIdentity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined
}

export function parseExecutionAssociation(value: unknown): PerformanceExecutionAssociation | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (row.version !== 1 || row.relationship !== "explicit") return null
  const result: PerformanceExecutionAssociation = { version: 1, relationship: "explicit" }
  for (const key of ["runId", "traceId", "sessionId", "turnId", "attemptId", "spanId"] as const) {
    if (row[key] === undefined) continue
    const id = executionIdentity(row[key])
    if (!id) return null
    result[key] = id
  }
  for (const key of ["executionStartedAt", "executionEndedAt"] as const) {
    const time = row[key]
    if (typeof time === "number" && Number.isFinite(time) && time >= 0) result[key] = time
  }
  return result.runId || result.traceId ? result : null
}

export function associationMatches(
  association: PerformanceExecutionAssociation | null | undefined,
  context: PerformanceExecutionContext
): boolean {
  return Boolean(
    association &&
    (context.runId || context.traceId) &&
    (!context.runId || association.runId === context.runId) &&
    (!context.traceId || association.traceId === context.traceId)
  )
}

export async function resolveExecutionAssociation(
  db: CogniaDB,
  context: PerformanceExecutionContext
): Promise<{
  association: PerformanceExecutionAssociation
  active: boolean
} | null> {
  const runId = executionIdentity(context.runId)
  const traceId = executionIdentity(context.traceId)
  if ((!runId && !traceId) || (context.runId && !runId) || (context.traceId && !traceId))
    return null
  let run = runId ? await db.executionRuns.get(runId) : undefined
  if (runId && !run) return null
  const spans = await db.agentTraces
    .where(traceId ? "traceId" : "runId")
    .equals(traceId ?? runId!)
    .toArray()
  const candidates = spans.filter((span) => !runId || span.runId === runId)
  const span = candidates.sort(
    (a, b) =>
      Number(Boolean(a.parentSpanId)) - Number(Boolean(b.parentSpanId)) || b.startTime - a.startTime
  )[0]
  if (traceId && !span) return null
  if (!run && span?.runId) run = await db.executionRuns.get(span.runId)
  const association = parseExecutionAssociation({
    version: 1,
    relationship: "explicit",
    runId: run?.id ?? span?.runId,
    sessionId: run?.sessionId ?? span?.sessionId,
    traceId: span?.traceId,
    spanId: span?.spanId,
    turnId: span?.turnId,
    attemptId: span?.attemptId,
    executionStartedAt: run?.startedAt ?? span?.startTime,
    executionEndedAt: run?.endedAt ?? span?.endTime,
  })
  if (!association) return null
  return {
    association,
    active: run
      ? !isTerminalRunStatus(run.status) && run.endedAt === undefined
      : Boolean(span?.status === "pending" && isAgentTraceSpanActive(span.spanId, span.traceId)),
  }
}
