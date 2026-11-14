/**
 * Drives one integration through the host's queue (ADR-0227 §2).
 *
 * The host owns every git operation and every state; this owns the order and
 * the two decisions that need the renderer's ports:
 *
 * - **Verification of the exact candidate.** The required acceptance checks
 *   run against the candidate SHA in the integration worktree, through the
 *   same ADR-0188 port a changeset's checks use, and are recorded against
 *   that SHA. Publish is refused by the host unless they passed there.
 * - **Recovery.** A publish refused because the target moved rebuilds on the
 *   new tip and verifies again, a bounded number of times. A candidate that
 *   fails verification with several changesets in it drops the most recently
 *   composed one, rebuilds and re-verifies, until one culprit is isolated and
 *   the rest integrate — or nothing is left. A conflict-only or failed run is
 *   aborted so its changesets return to the queue.
 *
 * Nothing here retries a refusal it does not understand: an uncoded host
 * error, an ineligible changeset, a dirty checked-out target. Those come back
 * to the person, who is the only one who can fix them.
 */

import type { AcceptancePort } from "@cognia/router-fusion"

import { scmErrorCode, type ScmHost } from "../host"
import {
  composedItems,
  type IntegrationAnalysis,
  type IntegrationConflictPolicy,
  type IntegrationRun,
  type IntegrationStrategy,
  type PrepareIntegration,
} from "../types"
import { runChangesetChecks, unmetChecks } from "../verify/changeset-checks"
import type { WorkspaceReviewPolicyParseResult } from "../review/review-policy"

/** Publishes refused because the target moved, retried at most this many times. */
export const MAX_STALE_REBUILDS = 3
/**
 * A hold whose executor deadline is unknown lasts the Host's longest (it
 * clamps to the same day); only a person's confirmation releases it sooner.
 */
export const EXECUTOR_HOLD_FALLBACK_MS = 24 * 60 * 60 * 1000

export interface IntegrateChangesetsInput {
  changesetIds: string[]
  targetRef: string
  strategy: IntegrationStrategy
  onConflict: IntegrationConflictPolicy
  /** Profiles the candidate must pass: the target policy's plus every changeset's. */
  requiredChecks: string[]
  provisioning?: PrepareIntegration["provisioning"]
  signal: AbortSignal
}

export interface IntegrateChangesetsDeps {
  host: ScmHost
  /** Policy at this prepared/rebuilt run's immutable expectedOldSha. */
  readPolicyAtRef: (run: IntegrationRun) => Promise<WorkspaceReviewPolicyParseResult>
  /**
   * The acceptance port, given the run so its `rootForRevision` can answer
   * the candidate's worktree. Null when no port can be built; a run with
   * required checks then never publishes.
   */
  acceptancePortFor: ((run: IntegrationRun) => AcceptancePort) | null
  executorStopUnproven?: () => boolean
  /** While the stop is unproven, the time by which the Host has killed the executor. */
  executorStopRetainUntil?: () => number | null
  now?: () => number
}

export type IntegrationOutcomeKind =
  /** The target moved to the verified candidate. */
  | "published"
  /** Nothing could be composed: every changeset conflicted, or stop-on-conflict hit one. */
  | "conflicted"
  /** Verification failed and no subset of the changesets passed. */
  | "failed"
  /** The run was refused or stopped for a reason a person must resolve. */
  | "blocked"

export interface IntegrationOutcome {
  kind: IntegrationOutcomeKind
  analysis: IntegrationAnalysis
  run: IntegrationRun | null
  /** Changesets dropped as the culprit of a failed verification, in drop order. */
  dropped: string[]
  /** Host error code (or `checks_unmet`, `aborted`) when `blocked`/`failed`. */
  reason?: string
  message?: string
}

/** The run's own `rootForRevision`: the candidate lives in its integration worktree. */
export function integrationRootForRevision(
  run: Pick<IntegrationRun, "candidateSha" | "worktreePath">
) {
  return async (revision: string): Promise<string | null> =>
    run.candidateSha && revision === run.candidateSha ? run.worktreePath : null
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message)
  return String(error)
}

export async function integrateChangesets(
  input: IntegrateChangesetsInput,
  deps: IntegrateChangesetsDeps
): Promise<IntegrationOutcome> {
  const { host } = deps
  const now = deps.now ?? Date.now
  const dropped: string[] = []

  const analysis = await host.analyzeIntegration(input.changesetIds, input.targetRef)
  if (input.signal.aborted) {
    return { kind: "blocked", analysis, run: null, dropped, reason: "aborted" }
  }
  if (analysis.cycles.length > 0) {
    return { kind: "blocked", analysis, run: null, dropped, reason: "cycles" }
  }

  let run: IntegrationRun
  try {
    run = await host.prepareIntegration({
      changesetIds: analysis.order,
      requiredChecks: input.requiredChecks,
      targetRef: input.targetRef,
      strategy: input.strategy,
      onConflict: input.onConflict,
      ...(input.provisioning ? { provisioning: input.provisioning } : {}),
    })
  } catch (error) {
    return {
      kind: "blocked",
      analysis,
      run: null,
      dropped,
      reason: scmErrorCode(error) ?? "host_error",
      message: errorMessage(error),
    }
  }

  let staleRebuilds = 0
  const abortRun = async (current: IntegrationRun): Promise<IntegrationRun> => {
    try {
      return await host.abortIntegration(current.integrationId)
    } catch {
      return current
    }
  }

  /** Abort the run, so its changesets return to the queue, and say why. */
  const giveBack = async (
    kind: IntegrationOutcomeKind,
    reason?: string,
    message?: string
  ): Promise<IntegrationOutcome> => ({
    kind,
    analysis,
    run: await abortRun(run),
    dropped,
    ...(reason ? { reason } : {}),
    ...(message !== undefined ? { message } : {}),
  })
  // A cancel (the person, a repository switch, an unmount) can land while any
  // step below is awaited. It is checked again after each await and before
  // every step that changes the run or the target, not only once per pass
  // (postfix review P06). A publish whose compare-and-swap committed has
  // happened: it is reported as published whatever the signal says after.
  const cancelled = () => giveBack("blocked", "aborted")

  for (;;) {
    if (input.signal.aborted) return cancelled()
    if (run.state === "conflicted" || run.state === "failed") {
      // Nothing composed (all conflicted / all dropped). Give the queue back.
      return run.state === "conflicted"
        ? giveBack("conflicted")
        : giveBack("failed", "checks_unmet")
    }
    if (run.state !== "prepared" || !run.candidateSha) {
      return {
        kind: "blocked",
        analysis,
        run,
        dropped,
        reason: "invalid_state",
        message: `integration is ${run.state}`,
      }
    }
    const candidateSha = run.candidateSha
    let policy: WorkspaceReviewPolicyParseResult
    try {
      policy = await deps.readPolicyAtRef(run)
    } catch (error) {
      return giveBack("blocked", "policy_unavailable", errorMessage(error))
    }
    if (input.signal.aborted) return cancelled()
    if (!policy.ok) {
      return giveBack(
        "blocked",
        "policy_invalid",
        policy.problems.map((problem) => `${problem.pointer}: ${problem.message}`).join("; ")
      )
    }
    // A failed/missing head check cannot be replaced by a passing candidate
    // check. The policy-only obligation was never stored on the changeset.
    try {
      if (policy.policy.requiredChecks.length > 0) {
        for (const item of composedItems(run)) {
          const changeset = await host.getChangeset(item.changesetId)
          if (
            !changeset ||
            changeset.headSha !== item.headSha ||
            unmetChecks(policy.policy.requiredChecks, changeset.checks, item.headSha).length > 0
          ) {
            return giveBack(
              "blocked",
              "checks_unmet",
              `changeset ${item.changesetId} has unmet target policy checks`
            )
          }
        }
      }
    } catch (error) {
      return giveBack("blocked", "policy_unavailable", errorMessage(error))
    }
    if (input.signal.aborted) return cancelled()
    // The host's list also carries each composed changeset's own checks.
    const requiredChecks = [
      ...new Set([
        ...input.requiredChecks,
        ...(run.requiredChecks ?? []),
        ...policy.policy.requiredChecks,
      ]),
    ]

    // ── verify the exact candidate ───────────────────────────────────────────
    if (requiredChecks.length > 0) {
      if (!deps.acceptancePortFor) {
        return giveBack("blocked", "checks_unmet", "no acceptance port can verify the candidate")
      }
      const checks = await runChangesetChecks({
        port: deps.acceptancePortFor(run),
        runId: `integration:${run.integrationId}`,
        revision: candidateSha,
        profileIds: requiredChecks,
        signal: input.signal,
        now,
      })
      for (const check of checks) {
        run = await host.recordIntegrationCheck(run.integrationId, candidateSha, check)
      }
      if (deps.executorStopUnproven?.()) {
        // Keep its worktree: dropping, rebuilding or aborting can replace files
        // that an executor with a lost transport response may still write.
        // The hold is stored on the Host, so a retry, a restart's recovery or
        // a person's Abort cannot release it before the executor's deadline.
        const last = checks[checks.length - 1]
        if (last) {
          run = await host.recordIntegrationCheck(run.integrationId, candidateSha, last, {
            executorStopUnprovenUntil:
              deps.executorStopRetainUntil?.() ?? now() + EXECUTOR_HOLD_FALLBACK_MS,
          })
        }
        return { kind: "blocked", analysis, run, dropped, reason: "executor_stop_unproven" }
      }
      // A cancelled check reports nothing about the candidate: no culprit to drop.
      if (input.signal.aborted) return cancelled()
      const unmet = unmetChecks(requiredChecks, run.checks, candidateSha)
      if (unmet.length > 0) {
        const composed = composedItems(run)
        const culprit = composed[composed.length - 1]
        if (!culprit) return giveBack("failed", "checks_unmet")
        // Drop the last composed changeset: if the rest pass, it was the one;
        // if they do not, the next iteration drops the one before it.
        run = await host.dropIntegrationItem(run.integrationId, culprit.changesetId)
        dropped.push(culprit.changesetId)
        if (input.signal.aborted) return cancelled()
        if (run.state === "stale") run = await host.rebuildIntegration(run.integrationId)
        continue
      }
    }

    // ── publish by compare-and-swap ──────────────────────────────────────────
    if (input.signal.aborted) return cancelled()
    try {
      run = await host.publishIntegration(run.integrationId, candidateSha, requiredChecks)
      return { kind: "published", analysis, run, dropped }
    } catch (error) {
      const code = scmErrorCode(error)
      if (
        (code === "target_moved" || code === "stale_candidate") &&
        staleRebuilds < MAX_STALE_REBUILDS
      ) {
        staleRebuilds += 1
        const current = await host.getIntegration(run.integrationId)
        if (!current) throw error
        run = current
        if (input.signal.aborted) return cancelled()
        if (current.state === "stale") run = await host.rebuildIntegration(run.integrationId)
        continue
      }
      return {
        kind: "blocked",
        analysis,
        run: (await host.getIntegration(run.integrationId)) ?? run,
        dropped,
        reason: code ?? "host_error",
        message: errorMessage(error),
      }
    }
  }
}
