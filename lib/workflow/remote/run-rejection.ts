/**
 * How a Host says "this run will not happen", and how a client reads it back.
 *
 * The Host's workflow run commands (`./host-commands.ts`) throw a
 * {@link WorkflowRunRejectedError}, whose message starts with
 * {@link WORKFLOW_RUN_REJECTED_SENTINEL}. The companion RPC maps that onto a
 * 422 `workflow_run_rejected` with the sentinel stripped
 * (`crates/cognia-companion-rpc/src/rpc.rs`), so a queued run that cannot
 * happen is given up on instead of retried, and a client can tell a refusal
 * (a reason to show) from a transport failure (something to retry).
 *
 * Kept apart from the commands themselves so a client surface can read a
 * refusal without loading the orchestrator.
 */

export const WORKFLOW_RUN_REJECTED_SENTINEL = "[WORKFLOW_RUN_REJECTED]"

/** The RPC error code a refused workflow run arrives under. */
export const WORKFLOW_RUN_REJECTED_CODE = "workflow_run_rejected"

/** Why a run was not started. Admission codes pass through verbatim. */
export type WorkflowRunRejectionReason =
  | "workflow_not_found"
  | "workflow_invalid"
  | "step_not_found"
  | "run_not_started"
  | "invalid_request"
  | (string & {})

export class WorkflowRunRejectedError extends Error {
  readonly retryable = false

  constructor(
    readonly reason: WorkflowRunRejectionReason,
    readonly detail: string
  ) {
    super(`${WORKFLOW_RUN_REJECTED_SENTINEL} ${reason}: ${detail}`)
    this.name = "WorkflowRunRejectedError"
  }
}

/**
 * Read a refusal back out of whatever message reached the client: the raw
 * sentinel message (an in-process call) or the 422 detail the RPC carried,
 * which has the sentinel trimmed off.
 */
export function parseWorkflowRunRejection(
  message: string
): { reason: WorkflowRunRejectionReason; detail: string } | null {
  const body = message.startsWith(WORKFLOW_RUN_REJECTED_SENTINEL)
    ? message.slice(WORKFLOW_RUN_REJECTED_SENTINEL.length).trim()
    : message.trim()
  const match = /^([a-z][a-z0-9_-]*): ([\s\S]*)$/.exec(body)
  if (!match) return null
  return { reason: match[1], detail: match[2] }
}

/**
 * A refusal the Host answered, or `null` for anything else (a transport
 * failure, a bug). Over the companion plane it is the 422 error code; in
 * process it is the sentinel message.
 */
export function workflowRunRefusalOf(error: unknown): { reason: string; detail: string } | null {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  if (code !== WORKFLOW_RUN_REJECTED_CODE && !message.startsWith(WORKFLOW_RUN_REJECTED_SENTINEL)) {
    return null
  }
  return parseWorkflowRunRejection(message) ?? { reason: "run_not_started", detail: message }
}
