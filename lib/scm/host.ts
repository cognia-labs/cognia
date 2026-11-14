/**
 * The host commands behind agent changesets and the integration queue
 * (ADR-0227). Every state and gate is the host's; this is the typed door.
 *
 * Writes go through `approvalAwareTransport`, the same seam task-workspace
 * writes use, so a paired client holds the remote-control admin lease for
 * them and a turn-scoped caller keeps the lease of its turn.
 */

import { approvalAwareTransport } from "@/lib/task-workspace/user-action"
import type { TaskWorkspaceOrigin } from "@/lib/task-workspace/types"

import type {
  AgentChangeset,
  CaptureChangeset,
  ChangesetCheck,
  ChangesetFilter,
  ChangesetReview,
  EligibilityGap,
  IntegrationAnalysis,
  IntegrationRun,
  IntegrationRunFilter,
  PrepareIntegration,
} from "./types"

export interface ChangesetEligibility {
  eligible: boolean
  gaps: EligibilityGap[]
}

/** The host surface the changeset pipeline and the integration orchestrator need. */
export interface ScmHost {
  captureChangeset(input: CaptureChangeset): Promise<AgentChangeset>
  getChangeset(changesetId: string): Promise<AgentChangeset | null>
  listChangesets(filter?: ChangesetFilter): Promise<AgentChangeset[]>
  markChangesetReady(changesetId: string): Promise<AgentChangeset>
  recordChangesetReview(changesetId: string, review: ChangesetReview): Promise<AgentChangeset>
  recordChangesetCheck(changesetId: string, check: ChangesetCheck): Promise<AgentChangeset>
  approveChangeset(changesetId: string, headSha: string, approver: string): Promise<AgentChangeset>
  abandonChangeset(changesetId: string): Promise<AgentChangeset>
  changesetEligibility(changesetId: string): Promise<ChangesetEligibility>

  analyzeIntegration(
    changesetIds: string[],
    targetRef?: string | null
  ): Promise<IntegrationAnalysis>
  prepareIntegration(input: PrepareIntegration): Promise<IntegrationRun>
  /**
   * `hold.executorStopUnprovenUntil`: the executor behind this check has not
   * proven it stopped and may write into the integration worktree until then
   * (its deadline). The Host refuses abort, drop and publish until that time.
   */
  recordIntegrationCheck(
    integrationId: string,
    candidateSha: string,
    check: ChangesetCheck,
    hold?: { executorStopUnprovenUntil: number }
  ): Promise<IntegrationRun>
  publishIntegration(
    integrationId: string,
    candidateSha: string,
    requiredChecks: string[]
  ): Promise<IntegrationRun>
  rebuildIntegration(integrationId: string): Promise<IntegrationRun>
  dropIntegrationItem(integrationId: string, changesetId: string): Promise<IntegrationRun>
  /** `executorStopped`: a person confirms a held run's executor has stopped. */
  abortIntegration(
    integrationId: string,
    options?: { executorStopped?: boolean }
  ): Promise<IntegrationRun>
  rollbackIntegration(integrationId: string): Promise<IntegrationRun>
  getIntegration(integrationId: string): Promise<IntegrationRun | null>
  listIntegrations(filter?: IntegrationRunFilter): Promise<IntegrationRun[]>
}

/** Command names; the host registers each one (Tauri, Companion, headless). */
export const SCM_HOST_COMMANDS = {
  captureChangeset: "task_workspace_changeset_capture",
  getChangeset: "task_workspace_changeset_get",
  listChangesets: "task_workspace_changeset_list",
  markChangesetReady: "task_workspace_changeset_mark_ready",
  recordChangesetReview: "task_workspace_changeset_record_review",
  recordChangesetCheck: "task_workspace_changeset_record_check",
  approveChangeset: "task_workspace_changeset_approve",
  abandonChangeset: "task_workspace_changeset_abandon",
  changesetEligibility: "task_workspace_changeset_eligibility",
  analyzeIntegration: "task_workspace_integration_analyze",
  prepareIntegration: "task_workspace_integration_prepare",
  recordIntegrationCheck: "task_workspace_integration_record_check",
  publishIntegration: "task_workspace_integration_publish",
  rebuildIntegration: "task_workspace_integration_rebuild",
  dropIntegrationItem: "task_workspace_integration_drop_item",
  abortIntegration: "task_workspace_integration_abort",
  rollbackIntegration: "task_workspace_integration_rollback",
  getIntegration: "task_workspace_integration_get",
  listIntegrations: "task_workspace_integration_list",
} as const satisfies Record<keyof ScmHost, string>

type Call = <T>(command: string, args: Record<string, unknown>) => Promise<T>

/** Hosts whose calls follow whichever Host is selected when each call is made. */
const followsSelectedHost = new WeakSet<ScmHost>()

/** The production host over the routed transport. `call` is a test seam. */
export function createScmHost(call?: Call): ScmHost {
  const host = buildScmHost(call ?? ((command, args) => approvalAwareTransport.call(command, args)))
  if (!call) followsSelectedHost.add(host)
  return host
}

/** Every call on the Host `origin` names, whichever Host is selected meanwhile. */
export function scmHostForOrigin(origin: TaskWorkspaceOrigin): ScmHost {
  return buildScmHost((command, args) => approvalAwareTransport.call(command, args, origin))
}

/**
 * For one operation that must stay on one Host (a check acquires, pins and
 * archives its checkout there): a host that follows the selection is bound
 * to `origin`; a caller's own host is kept as it is.
 */
export function bindScmHostToOrigin(host: ScmHost, origin: TaskWorkspaceOrigin): ScmHost {
  return followsSelectedHost.has(host) ? scmHostForOrigin(origin) : host
}

/**
 * A Host older than an optional argument refuses the whole request with
 * `contract_input_violation`: its input contracts are closed. Only then is
 * the request sent again without that argument.
 */
async function olderHostFallback<T>(attempt: Promise<T>, withoutArgument: () => Promise<T>) {
  try {
    return await attempt
  } catch (error) {
    if (scmErrorCode(error) !== "contract_input_violation") throw error
    return withoutArgument()
  }
}

function buildScmHost(call: Call): ScmHost {
  const c = SCM_HOST_COMMANDS
  return {
    captureChangeset: (input) => call(c.captureChangeset, { input }),
    getChangeset: (changesetId) => call(c.getChangeset, { changesetId }),
    listChangesets: (filter = {}) => call(c.listChangesets, { filter }),
    markChangesetReady: (changesetId) => call(c.markChangesetReady, { changesetId }),
    recordChangesetReview: (changesetId, review) =>
      call(c.recordChangesetReview, { changesetId, review }),
    recordChangesetCheck: (changesetId, check) =>
      call(c.recordChangesetCheck, { changesetId, check }),
    approveChangeset: (changesetId, headSha, approver) =>
      call(c.approveChangeset, { changesetId, headSha, approver }),
    abandonChangeset: (changesetId) => call(c.abandonChangeset, { changesetId }),
    changesetEligibility: (changesetId) => call(c.changesetEligibility, { changesetId }),
    analyzeIntegration: (changesetIds, targetRef = null) =>
      call(c.analyzeIntegration, { changesetIds, targetRef }),
    prepareIntegration: (input) => call(c.prepareIntegration, { input }),
    recordIntegrationCheck: (integrationId, candidateSha, check, hold) => {
      const record = { integrationId, candidateSha, check }
      if (!hold) return call(c.recordIntegrationCheck, record)
      return olderHostFallback(
        call(c.recordIntegrationCheck, {
          ...record,
          executorStopUnprovenUntil: hold.executorStopUnprovenUntil,
        }),
        // The answer carries no hold; the orchestrator keeps it in this client.
        () => call(c.recordIntegrationCheck, record)
      )
    },
    publishIntegration: (integrationId, candidateSha, requiredChecks) =>
      call(c.publishIntegration, { integrationId, candidateSha, requiredChecks }),
    rebuildIntegration: (integrationId) => call(c.rebuildIntegration, { integrationId }),
    dropIntegrationItem: (integrationId, changesetId) =>
      call(c.dropIntegrationItem, { integrationId, changesetId }),
    abortIntegration: (integrationId, options) => {
      if (!options?.executorStopped) return call(c.abortIntegration, { integrationId })
      return olderHostFallback(
        call(c.abortIntegration, { integrationId, executorStopped: true }),
        // A Host that cannot take the confirmation never stored a hold either.
        () => call(c.abortIntegration, { integrationId })
      )
    },
    rollbackIntegration: (integrationId) => call(c.rollbackIntegration, { integrationId }),
    getIntegration: (integrationId) => call(c.getIntegration, { integrationId }),
    listIntegrations: (filter = {}) => call(c.listIntegrations, { filter }),
  }
}

/**
 * Host error codes the orchestrator branches on. The host maps every
 * `IntegrationError` / `ChangesetError` variant to a `cognia_core::CommandError`
 * whose `code` is the variant in snake_case.
 */
export type ScmHostErrorCode =
  | "target_moved"
  | "target_checked_out_dirty"
  | "stale_candidate"
  | "stale_head"
  | "ineligible"
  | "checks"
  | "busy"
  | "cycles"
  | "dependency"
  | "rollback_conflict"
  | "attempts_exhausted"
  | "invalid_state"
  | "changeset_state"
  | "conflict"
  | "nothing_to_capture"
  | "not_found"
  | "invalid_request"
  /** The Host's closed input contract refused an argument it predates. */
  | "contract_input_violation"

/**
 * The typed code of a host error, or null. The host serializes
 * `IntegrationError` as `{ code, message, retryable }`; a plain string
 * error (an older host, a transport fault) has no code and is never retried.
 */
export function scmErrorCode(error: unknown): ScmHostErrorCode | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code
    return typeof code === "string" ? (code as ScmHostErrorCode) : null
  }
  return null
}
