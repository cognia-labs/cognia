/**
 * A background shell's or monitor's end, as an outbox entry (ADR-0249,
 * ADR-0252 §9).
 *
 * The job supervisor reports an agent-started job's end with the
 * conversation it reports into (the start call carried it), so the entry is
 * written once, from the end alone, keyed by the job or monitor id. An end
 * that arrives twice, or by an event and by reconciliation, writes the same
 * entry. Pure and host-agnostic: the renderer, the headless brain and the CLI
 * share it.
 */

import type {
  BackgroundJobSettlementFacts,
  BackgroundTaskDeliveryState,
  BackgroundTaskHost,
  BackgroundTaskJournalRecord,
} from "./registry-core"

/** A job's end as the supervisor and the in-process registry report it. */
export interface BackgroundJobExitShape {
  jobId: string
  status: string
  exitCode?: number | null
  endedAtMs: number
  startedAtMs?: number
  command?: string
  label?: string
  outputTail?: string
  delivery?: {
    sessionId: string
    runId?: string
    notify?: "on_exit" | "none"
    stoppedBy?: "agent" | "person" | "owner" | "shutdown"
  }
}

/** A settled monitor as the supervisor reports it. */
export interface BackgroundMonitorSettlementShape {
  id: string
  status: string
  condition: { kind: string; [key: string]: unknown }
  createdAtMs: number
  settledAtMs?: number
  detail?: string
  label?: string
  delivery?: { sessionId: string; runId?: string; state?: "pending" | "inline" }
}

/**
 * How far back a consumer reconciles missed ends on start or reconnect. The
 * outbox keeps every job entry this young, so reconciliation never writes
 * (and delivers) an end a second time after pruning dropped it.
 */
export const JOB_RECONCILE_WINDOW_MS = 6 * 60 * 60 * 1000

const SHELL_STATUSES = new Set(["exited", "killed", "interrupted", "failed"])
const MONITOR_STATUSES = new Set(["fired", "unsatisfiable", "cancelled", "expired"])

export function jobOutboxId(jobId: string): string {
  return `shell-job:${jobId}`
}

export function monitorOutboxId(monitorId: string): string {
  return `monitor:${monitorId}`
}

/**
 * Whether the conversation is owed this end (ADR-0249 §5). Not when the agent
 * asked for no report, stopped the shell itself, or its session was torn
 * down or the app quit (nobody is left to tell); not when a blocking Monitor
 * call already returned the outcome, or the watch was cancelled. A person
 * stopping the shell is reported: the agent did not choose it.
 */
export function jobDeliveryState(facts: BackgroundJobSettlementFacts): BackgroundTaskDeliveryState {
  if (facts.kind === "monitor") {
    return facts.deliveredInline || facts.status === "cancelled" ? "skipped" : "pending"
  }
  if (facts.notify === "none") return "skipped"
  if (facts.stoppedBy && facts.stoppedBy !== "person") return "skipped"
  return "pending"
}

/**
 * The outbox entry for an ended agent-started shell, or `null` for one no
 * conversation is owed (started by a schedule, a bridge or a person) or one
 * that has not ended.
 */
export function outboxRecordFromJobExit(
  exit: BackgroundJobExitShape,
  host: BackgroundTaskHost
): BackgroundTaskJournalRecord | null {
  const delivery = exit.delivery
  if (!delivery?.sessionId || !SHELL_STATUSES.has(exit.status)) return null
  const facts: BackgroundJobSettlementFacts = {
    kind: "shell-job",
    ...(delivery.runId ? { runId: delivery.runId } : {}),
    status: exit.status as Extract<BackgroundJobSettlementFacts, { kind: "shell-job" }>["status"],
    ...(typeof exit.exitCode === "number" ? { exitCode: exit.exitCode } : {}),
    command: exit.command ?? "",
    ...(exit.outputTail ? { outputTail: exit.outputTail } : {}),
    notify: delivery.notify ?? "on_exit",
    ...(delivery.stoppedBy ? { stoppedBy: delivery.stoppedBy } : {}),
  }
  const succeeded = exit.status === "exited" && exit.exitCode === 0
  return {
    runId: jobOutboxId(exit.jobId),
    kind: "shell-job",
    subagentId: "",
    prompt: facts.command,
    sessionId: delivery.sessionId,
    host,
    status: succeeded ? "done" : "error",
    startedAt: exit.startedAtMs || exit.endedAtMs,
    settledAt: exit.endedAtMs,
    ...(exit.outputTail ? { resultText: exit.outputTail } : {}),
    ...(succeeded ? {} : { error: shellOutcome(facts) }),
    ...(exit.label ? { label: exit.label } : {}),
    mode: "background",
    deliveryState: jobDeliveryState(facts),
    job: facts,
  }
}

/** The outbox entry for a settled agent-registered monitor, or `null`. */
export function outboxRecordFromMonitor(
  monitor: BackgroundMonitorSettlementShape,
  host: BackgroundTaskHost
): BackgroundTaskJournalRecord | null {
  const delivery = monitor.delivery
  if (!delivery?.sessionId || !MONITOR_STATUSES.has(monitor.status)) return null
  const facts: BackgroundJobSettlementFacts = {
    kind: "monitor",
    ...(delivery.runId ? { runId: delivery.runId } : {}),
    status: monitor.status as Extract<BackgroundJobSettlementFacts, { kind: "monitor" }>["status"],
    condition: describeCondition(monitor.condition),
    ...(monitor.detail ? { detail: monitor.detail } : {}),
    deliveredInline: delivery.state === "inline",
  }
  const settledAt = monitor.settledAtMs ?? monitor.createdAtMs
  return {
    runId: monitorOutboxId(monitor.id),
    kind: "monitor",
    subagentId: "",
    prompt: facts.condition,
    sessionId: delivery.sessionId,
    host,
    status: monitor.status === "fired" ? "done" : "error",
    startedAt: monitor.createdAtMs,
    settledAt,
    ...(monitor.detail ? { resultText: monitor.detail } : {}),
    ...(monitor.status === "fired" ? {} : { error: `monitor ${monitor.status}` }),
    ...(monitor.label ? { label: monitor.label } : {}),
    mode: "background",
    deliveryState: jobDeliveryState(facts),
    job: facts,
  }
}

/** The supervisor id an outbox entry stands for (`shell-job:<id>` → `<id>`). */
export function supervisorIdOf(
  record: Pick<BackgroundTaskJournalRecord, "runId" | "kind">
): string {
  const prefix = record.kind === "shell-job" ? "shell-job:" : "monitor:"
  return record.runId.startsWith(prefix) ? record.runId.slice(prefix.length) : record.runId
}

export function isJobOutboxKind(kind: BackgroundTaskJournalRecord["kind"]): boolean {
  return kind === "shell-job" || kind === "monitor"
}

function shellOutcome(facts: Extract<BackgroundJobSettlementFacts, { kind: "shell-job" }>): string {
  if (facts.status === "killed")
    return facts.stoppedBy === "person" ? "stopped by a person" : "stopped"
  if (facts.status === "interrupted") return "interrupted: the host restarted"
  if (facts.status === "failed") return "failed to run"
  return `exited with code ${facts.exitCode ?? "unknown"}`
}

function describeCondition(condition: BackgroundMonitorSettlementShape["condition"]): string {
  const field = (key: string) =>
    typeof condition[key] === "string" ? (condition[key] as string) : undefined
  switch (condition.kind) {
    case "jobExit":
      return `job ${field("jobId") ?? "?"} exits`
    case "jobOutput":
      return `job ${field("jobId") ?? "?"} prints /${field("pattern") ?? ""}/`
    case "shellPredicate":
      return `\`${field("command") ?? ""}\` succeeds`
    case "upstream":
      return `${field("source") ?? "upstream"} ${field("id") ?? "?"} finishes`
    default:
      return condition.kind
  }
}

/**
 * The sidecar's `background_job_settled` frame: an in-process shell's end, on
 * a host with no job supervisor (ADR-0249 §6). Its `sessionId` is the
 * conversation; the settlement has the supervisor's `JobExit` shape. Read
 * with a guard rather than through the frame union, which is the plugin
 * contract's.
 */
export function jobExitFromSettledFrame(frame: unknown): BackgroundJobExitShape | null {
  if (!frame || typeof frame !== "object") return null
  const candidate = frame as { type?: unknown; settlement?: unknown }
  if (candidate.type !== "background_job_settled") return null
  const settlement = candidate.settlement as Partial<BackgroundJobExitShape> | undefined
  if (
    !settlement ||
    typeof settlement.jobId !== "string" ||
    typeof settlement.status !== "string" ||
    typeof settlement.endedAtMs !== "number"
  )
    return null
  return settlement as BackgroundJobExitShape
}
