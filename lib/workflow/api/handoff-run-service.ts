/**
 * The target Host's side of a handed-off run (ADR-0136 placement contract).
 *
 * Another Host, authenticated as a paired device whose id the RPC layer
 * injects (`callerDeviceId`, never the payload's), hands this Host work it
 * already admitted. Every run it hands over is admitted here under the caller
 * `host:<callerDeviceId>`, and that caller is the only one these commands
 * answer for: a Host reads and cancels the runs it handed over, nothing else.
 *
 * - `workflow_app_handoff_create` admits exactly the locked version a Workflow
 *   App release selected, idempotent by the serving invocation id, with the
 *   App's own entrypoint and run id. The App's quota was counted on the
 *   serving Host; nothing here reserves it again.
 * - `workflow_handoff_run_get` reports the run, its usage, an optional event
 *   page and an optional disclosure verdict (the run's personal taint lives
 *   here, so the verdict is made here).
 * - `workflow_handoff_run_cancel` cancels it.
 */

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import { getWorkflowDeploymentById, getWorkflowVersion } from "@/lib/db/workflow-deployments"
import { checkPersonalSink } from "@/lib/execution/personal-sink"
import { workflowExecutionRunId } from "@/lib/execution/workflow-bridge"
import {
  executeWorkflowVersion,
  WorkflowAdmissionError,
} from "@/lib/workflow/runtime/execution-authority"
import type {
  HandoffRunCancelReply,
  HandoffRunDisclosure,
  HandoffRunGetRequest,
  HandoffRunReply,
  HandoffRunUsage,
  WorkflowAppHandoffCreateReply,
  WorkflowAppHandoffCreateRequest,
} from "@/lib/workflow/runtime/app-run-handoff"
import {
  cancelWorkflowApiRun,
  getWorkflowApiRun,
  listWorkflowApiEvents,
} from "./workflow-api-service"

/** The invocation caller a handed-over run is admitted under on this Host. */
export function handoffCaller(callerDeviceId: string): string {
  return `host:${callerDeviceId}`
}

function refused(code: string, message: string, retryable = false): WorkflowAppHandoffCreateReply {
  return { outcome: "refused", refusal: { code, message, retryable } }
}

/** Admit the exact release-locked version another Host already admitted as an App run. */
export async function createWorkflowAppRunHandoff(input: {
  accountId: string
  callerDeviceId: string
  request: WorkflowAppHandoffCreateRequest
}): Promise<WorkflowAppHandoffCreateReply> {
  const { request } = input
  if (input.accountId !== getActiveAccountId()) {
    return refused("deployment_not_found", "Workflow deployment was not found")
  }
  const version = await getWorkflowVersion(request.versionId)
  if (
    !version ||
    version.workflowId !== request.workflowId ||
    version.accountId !== input.accountId
  ) {
    return refused("version_not_found", "This Host does not have the release's workflow version")
  }
  if (version.digest !== request.expectedVersionDigest) {
    return refused(
      "deployment_digest_mismatch",
      "This Host's copy of the release's workflow version differs"
    )
  }
  const deployment = await getWorkflowDeploymentById(request.deploymentId, input.accountId)
  if (
    !deployment ||
    deployment.status !== "active" ||
    deployment.workflowId !== request.workflowId
  ) {
    return refused("deployment_not_found", "Workflow deployment was not found")
  }

  let admit: (runId: string) => void = () => undefined
  const admitted = new Promise<string>((resolve) => {
    admit = resolve
  })
  const execution = executeWorkflowVersion({
    workflowId: request.workflowId,
    versionId: request.versionId,
    deploymentId: request.deploymentId,
    deploymentRevision: request.deploymentRevision,
    ...(request.dependencyLock ? { dependencyLock: request.dependencyLock } : {}),
    // The App's entrypoint; the caller is the Host that admitted it, so this
    // Host's own App quota (keyed on `app:` callers) never counts it again.
    entrypoint: "http",
    caller: handoffCaller(input.callerDeviceId),
    idempotencyKey: request.idempotencyKey,
    requestedRunId: request.runId,
    authorizedScopes: ["workflow:run"],
    triggerKind: "trigger.manual",
    payload: request.payload,
    triggeredBy: {
      source: "api",
      deviceId: input.callerDeviceId,
      ...(request.initiator ? { initiator: request.initiator } : {}),
    },
    onAdmitted: admit,
  })
  // A run that fails after admission reports through its status, not here.
  void execution.catch(() => undefined)
  let runId: string
  try {
    runId = await Promise.race([execution.then((result) => result.runId), admitted])
  } catch (error) {
    if (error instanceof WorkflowAdmissionError) {
      return refused(
        error.code.replaceAll("-", "_"),
        error.message,
        error.code === "workflow-concurrency-limit"
      )
    }
    throw error
  }
  const run = await getDb().workflowRuns.get(runId)
  return { outcome: "accepted", runId, status: run?.status ?? "pending" }
}

/** The run, if `callerDeviceId`'s Host handed it over to this Host's active account. */
async function ownedHandoffRun(
  accountId: string,
  callerDeviceId: string,
  runId: string
): Promise<boolean> {
  if (accountId !== getActiveAccountId()) return false
  const run = await getDb().workflowRuns.get(runId)
  const invocationId = run?.executionBinding?.invocationId
  if (!invocationId) return false
  const invocation = await getDb().workflowInvocations.get(invocationId)
  return (
    invocation?.accountId === accountId &&
    invocation.runId === runId &&
    invocation.caller === handoffCaller(callerDeviceId)
  )
}

async function runUsage(runId: string): Promise<HandoffRunUsage> {
  const rows = await getDb().sessionUsage.where("runId").equals(runId).toArray()
  return {
    tokens: rows.reduce(
      (total, row) =>
        total + row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
      0
    ),
    costUsd: rows.reduce((total, row) => total + row.costUsd, 0),
    costKnown: rows.every((row) => row.costKnown !== false),
  }
}

async function judgeDisclosure(
  runId: string,
  disclosure: { payload: string; label: string }
): Promise<HandoffRunDisclosure> {
  try {
    const decision = await checkPersonalSink(
      { executionRunId: workflowExecutionRunId(runId) },
      { kind: "unknown", label: disclosure.label },
      disclosure.payload,
      { kind: "public-share", workflowRunId: runId }
    )
    if (decision.outcome === "allow") return { outcome: "allow" }
    return {
      outcome: "withhold",
      reason: "reason" in decision ? decision.reason : "sink-cannot-narrow",
      persons: decision.persons,
    }
  } catch (error) {
    return {
      outcome: "withhold",
      reason: error instanceof Error ? error.message : "Personal sink unavailable",
      persons: [],
    }
  }
}

/** Status (and optionally events and a disclosure verdict) of a handed-over run. */
export async function getHandoffRun(input: {
  accountId: string
  callerDeviceId: string
  request: HandoffRunGetRequest
}): Promise<HandoffRunReply> {
  const { request } = input
  if (!(await ownedHandoffRun(input.accountId, input.callerDeviceId, request.runId))) {
    return { run: null }
  }
  const scopes = ["workflow:read"] as const
  const [run, usage, events, disclosure] = await Promise.all([
    getWorkflowApiRun({ accountId: input.accountId, runId: request.runId, scopes }),
    runUsage(request.runId),
    request.afterSequence !== undefined
      ? listWorkflowApiEvents({
          accountId: input.accountId,
          runId: request.runId,
          scopes,
          afterSequence: request.afterSequence,
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
        })
      : Promise.resolve(undefined),
    request.disclosure
      ? judgeDisclosure(request.runId, request.disclosure)
      : Promise.resolve(undefined),
  ])
  return {
    run,
    usage,
    ...(events ? { events } : {}),
    ...(disclosure ? { disclosure } : {}),
  }
}

/** Cancel a handed-over run on behalf of the Host that handed it over. */
export async function cancelHandoffRun(input: {
  accountId: string
  callerDeviceId: string
  runId: string
}): Promise<HandoffRunCancelReply> {
  if (!(await ownedHandoffRun(input.accountId, input.callerDeviceId, input.runId))) {
    return { runId: input.runId, found: false, cancelled: false, mode: "not-found" }
  }
  const result = await cancelWorkflowApiRun({
    accountId: input.accountId,
    runId: input.runId,
    caller: handoffCaller(input.callerDeviceId),
    scopes: ["workflow:run"],
  })
  return { runId: input.runId, found: true, cancelled: result.cancelled, mode: result.mode }
}
