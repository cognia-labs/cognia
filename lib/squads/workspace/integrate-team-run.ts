/**
 * `merge-all` for an Agent Team run (ADR-0227 §5): every successful
 * teammate's detached environment becomes a changeset, each changeset goes
 * through the review gate, and the ones that pass are integrated by the
 * host's queue — one transaction per repository, verified as composed,
 * published by compare-and-swap.
 *
 * ADR-0111 left this mode refused because no host-side transaction existed;
 * the queue is that transaction, so this module only decides WHAT goes in:
 *
 * - **Order.** Changesets are captured in task-dependency order, so each one
 *   declares the changesets of the tasks it depends on, and the host composes
 *   them in that order (and refuses a cycle).
 * - **Who waits.** A changeset that owes a human approval, or whose review
 *   asked for changes, is not integrated unattended. Neither is anything that
 *   depends on it, in its repository or another one, and neither is anything
 *   whose prerequisite failed, was blocked, or did not merge. Each held
 *   changeset carries a record naming the prerequisite it waits on.
 * - **Across repositories.** The host composes one repository at a time, so a
 *   changeset only declares the prerequisites in its own repository. Edges
 *   between repositories (a task depending on a task in another repository, or
 *   a repository binding's `dependsOn`) are enforced here: repositories
 *   integrate in dependency order, and a consumer only goes in once every
 *   provider it depends on has merged.
 * - **Where it lands.** By default a branch this run creates,
 *   `agent/<run>/integrated`, starting at the source checkout's HEAD — an
 *   unattended team never moves a branch nobody named. `target: "base"`
 *   integrates into the branch the source checkout is on, and only when it is
 *   on one.
 */

import type { ChangesetReviewResult } from "@/lib/scm/review/review-changeset"
import { requiredChecksFor } from "@/lib/scm/review/review-changeset"
import type {
  IntegrateChangesetsInput,
  IntegrationOutcome,
} from "@/lib/scm/integration/orchestrator"
import { scmErrorCode, type ScmHost } from "@/lib/scm/host"
import type {
  AgentChangeset,
  IntegrationConflictPolicy,
  IntegrationStrategy,
} from "@/lib/scm/types"

import { sanitizePromotionSegment } from "./promotion"

export type AgentTeamIntegrationTarget = "branch" | "base"

export interface AgentTeamIntegrationConfig {
  target: AgentTeamIntegrationTarget
  strategy: IntegrationStrategy
  onConflict: IntegrationConflictPolicy
  /** Profiles every changeset of the run owes, on top of each target's policy. */
  requiredChecks: string[]
}

export const DEFAULT_AGENT_TEAM_INTEGRATION: Readonly<AgentTeamIntegrationConfig> = Object.freeze({
  target: "branch",
  strategy: "merge",
  onConflict: "skip",
  requiredChecks: [],
})

/** One teammate's environment in one repository, ready to become a changeset. */
export interface TeamIntegrationCandidate {
  key: string
  taskId: string
  teammateName: string
  logicalRootId: string
  sourceRoot: string
  workspaceId: string
}

export interface AgentTeamIntegrationDeps {
  host: ScmHost
  review: (changesetId: string) => Promise<ChangesetReviewResult>
  integrate: (input: IntegrateChangesetsInput) => Promise<IntegrationOutcome>
  /** Current branch of a checkout, or null when HEAD is detached. */
  currentBranch: (sourceRoot: string) => Promise<string | null>
  /** Create `name` at `from` without checking it out; resolves when it exists. */
  createBranch: (sourceRoot: string, name: string, from: string) => Promise<void>
  /** Whether a local branch exists already. */
  branchExists: (sourceRoot: string, name: string) => Promise<boolean>
  signal: AbortSignal
}

/** Why a changeset that could otherwise integrate is waiting. */
export type TeamIntegrationHoldCause =
  /** The prerequisite owes a human approval or a check that has not passed. */
  | "provider_awaiting_approval"
  /** A reviewer asked for changes to the prerequisite. */
  | "provider_changes_requested"
  /** The prerequisite is itself held by one of its own prerequisites. */
  | "provider_held"
  /** The prerequisite's teammate, capture or review failed. */
  | "provider_failed"
  /** The prerequisite's repository could not be integrated (e.g. a detached base). */
  | "provider_blocked"
  /** The prerequisite went to its queue but did not merge (conflict, drop, stale). */
  | "provider_not_merged"
  /** Repositories depend on each other in a cycle; the later one cannot wait for the earlier. */
  | "dependency_cycle"

/** One held changeset and the prerequisite it waits on. */
export interface TeamIntegrationHold {
  key: string
  changesetId: string
  cause: TeamIntegrationHoldCause
  provider: {
    /** Candidate key, or null for a teammate that never produced a candidate. */
    key: string | null
    logicalRootId: string | null
    taskId: string
    changesetId: string | null
  }
}

/** Edges `integrateTeamRun` reads besides the task graph. */
export interface TeamIntegrationGraph {
  /** logicalRootId → the logicalRootIds it depends on (repository bindings' `dependsOn`). */
  repositoryDependencies?: Readonly<Record<string, readonly string[]>>
  /** Tasks whose teammate did not succeed, so they never became candidates. */
  unsuccessfulTasks?: readonly string[]
}

export interface TeamRootIntegrationResult {
  logicalRootId: string
  targetRef: string
  /** Branch this run created to integrate into, when `target` is `branch`. */
  createdBranch: string | null
  outcome: IntegrationOutcome["kind"] | "nothingToIntegrate"
  integrationId: string | null
  resultSha: string | null
  merged: string[]
  conflicted: string[]
  dropped: string[]
  /** Owes a human approval (or depends on one that does). */
  awaitingApproval: string[]
  changesRequested: string[]
  /** Candidates with nothing to capture: the teammate changed nothing. */
  unchanged: string[]
  /** Candidates whose capture or review failed, with the host's code. */
  failed: Array<{ key: string; reason: string }>
  /** Changesets held for a prerequisite, each with the one it waits on. */
  holds: TeamIntegrationHold[]
  reason?: string
}

export interface AgentTeamIntegrationResult {
  roots: TeamRootIntegrationResult[]
  /** Every changeset this run captured, by candidate key. */
  changesets: Record<string, string>
}

/**
 * `agent/<run>/integrated`, suffixed per repository when the run has several.
 *
 * @internal Test seam: exported for its unit tests, not for production callers.
 */
export function integrationBranchName(
  runId: string,
  logicalRootId: string,
  multiRoot: boolean
): string {
  const base = `agent/${sanitizePromotionSegment(runId)}/integrated`
  return multiRoot ? `${base}-${sanitizePromotionSegment(logicalRootId)}` : base
}

/**
 * Candidates in an order where every task comes after the tasks it depends
 * on. A cycle is not broken here: its members keep their input order and the
 * host's analysis reports the cycle.
 *
 * @internal Test seam: exported for its unit tests, not for production callers.
 */
export function orderByDependencies(
  candidates: readonly TeamIntegrationCandidate[],
  dependencies: Readonly<Record<string, readonly string[]>>
): TeamIntegrationCandidate[] {
  const byTask = new Map<string, TeamIntegrationCandidate[]>()
  for (const candidate of candidates) {
    const list = byTask.get(candidate.taskId) ?? []
    list.push(candidate)
    byTask.set(candidate.taskId, list)
  }
  const ordered: TeamIntegrationCandidate[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (taskId: string) => {
    if (visited.has(taskId) || visiting.has(taskId)) return
    visiting.add(taskId)
    for (const dependency of dependencies[taskId] ?? []) {
      if (byTask.has(dependency)) visit(dependency)
    }
    visiting.delete(taskId)
    visited.add(taskId)
    ordered.push(...(byTask.get(taskId) ?? []))
  }
  for (const candidate of candidates) visit(candidate.taskId)
  return ordered
}

function isWaiting(result: ChangesetReviewResult): "approval" | "changes" | null {
  const review = result.changeset.review
  if (!review || review.headSha !== result.changeset.headSha) return "approval"
  if (review.verdict === "requestChanges") return "changes"
  if (review.verdict !== "approve" || review.requiresHumanApproval) return "approval"
  const unmet = result.changeset.requiredChecks
    .concat(result.policy?.requiredChecks ?? [])
    .some(
      (profile) =>
        !result.changeset.checks.some(
          (check) =>
            check.profileId === profile &&
            check.headSha === result.changeset.headSha &&
            check.outcome === "passed"
        )
    )
  return unmet ? "approval" : null
}

async function resolveTarget(
  runId: string,
  logicalRootId: string,
  sourceRoot: string,
  multiRoot: boolean,
  config: AgentTeamIntegrationConfig,
  deps: AgentTeamIntegrationDeps
): Promise<{ targetRef: string; createdBranch: string | null } | { refused: string }> {
  const current = await deps.currentBranch(sourceRoot)
  if (config.target === "base") {
    if (!current) return { refused: "base_detached" }
    return { targetRef: `refs/heads/${current}`, createdBranch: null }
  }
  const name = integrationBranchName(runId, logicalRootId, multiRoot)
  if (await deps.branchExists(sourceRoot, name)) {
    // A rerun of the same run integrates on top of what it already published.
    return { targetRef: `refs/heads/${name}`, createdBranch: null }
  }
  await deps.createBranch(sourceRoot, name, "HEAD")
  return { targetRef: `refs/heads/${name}`, createdBranch: name }
}

/**
 * Repositories in an order where each comes after the repositories it depends
 * on. A cycle keeps input order; whichever member comes later holds its
 * consumers as `dependency_cycle`.
 */
function orderRoots(
  rootIds: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const ordered: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (rootId: string) => {
    if (visited.has(rootId) || visiting.has(rootId)) return
    visiting.add(rootId)
    for (const provider of edges.get(rootId) ?? []) visit(provider)
    visiting.delete(rootId)
    visited.add(rootId)
    ordered.push(rootId)
  }
  for (const rootId of rootIds) visit(rootId)
  return ordered
}

type CandidateState =
  | { kind: "blocked" }
  | { kind: "unchanged" }
  | { kind: "failed" }
  | { kind: "captured"; changesetId: string }

export async function integrateTeamRun(
  runId: string,
  candidates: readonly TeamIntegrationCandidate[],
  dependencies: Readonly<Record<string, readonly string[]>>,
  config: AgentTeamIntegrationConfig,
  deps: AgentTeamIntegrationDeps,
  graph: TeamIntegrationGraph = {}
): Promise<AgentTeamIntegrationResult> {
  const roots = new Map<string, TeamIntegrationCandidate[]>()
  const byTask = new Map<string, TeamIntegrationCandidate[]>()
  for (const candidate of candidates) {
    const list = roots.get(candidate.logicalRootId) ?? []
    list.push(candidate)
    roots.set(candidate.logicalRootId, list)
    byTask.set(candidate.taskId, [...(byTask.get(candidate.taskId) ?? []), candidate])
  }
  const multiRoot = roots.size > 1
  const unsuccessful = new Set(graph.unsuccessfulTasks ?? [])

  // Every prerequisite of a candidate, in any repository: the candidates of
  // the tasks it depends on, and every candidate of the repositories its own
  // repository depends on.
  const providersOf = (candidate: TeamIntegrationCandidate): TeamIntegrationCandidate[] => {
    const providers = new Map<string, TeamIntegrationCandidate>()
    for (const taskId of dependencies[candidate.taskId] ?? []) {
      for (const provider of byTask.get(taskId) ?? []) providers.set(provider.key, provider)
    }
    for (const rootId of graph.repositoryDependencies?.[candidate.logicalRootId] ?? []) {
      if (rootId === candidate.logicalRootId) continue
      for (const provider of roots.get(rootId) ?? []) providers.set(provider.key, provider)
    }
    providers.delete(candidate.key)
    return [...providers.values()]
  }

  const rootEdges = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    for (const provider of providersOf(candidate)) {
      if (provider.logicalRootId === candidate.logicalRootId) continue
      const edges = rootEdges.get(candidate.logicalRootId) ?? new Set<string>()
      edges.add(provider.logicalRootId)
      rootEdges.set(candidate.logicalRootId, edges)
    }
  }

  const changesetByKey: Record<string, string> = {}
  const states = new Map<string, CandidateState>()
  const candidateByChangeset = new Map<string, TeamIntegrationCandidate>()
  const ready = new Set<string>()
  /** Held changesets, and why each one is held itself. */
  const held = new Map<string, "approval" | "changes" | "failed" | "dependency">()
  const merged = new Set<string>()
  const doneRoots = new Set<string>()
  const results = new Map<string, TeamRootIntegrationResult>()
  for (const logicalRootId of roots.keys()) {
    results.set(logicalRootId, {
      logicalRootId,
      targetRef: "",
      createdBranch: null,
      outcome: "nothingToIntegrate",
      integrationId: null,
      resultSha: null,
      merged: [],
      conflicted: [],
      dropped: [],
      awaitingApproval: [],
      changesRequested: [],
      unchanged: [],
      failed: [],
      holds: [],
    })
  }

  /** Why `candidate` must wait for `provider`, or null when it need not. */
  const holdCause = (
    candidate: TeamIntegrationCandidate,
    provider: TeamIntegrationCandidate
  ): TeamIntegrationHoldCause | null => {
    const state = states.get(provider.key)
    if (!state) return "dependency_cycle"
    if (state.kind === "unchanged") return null
    if (state.kind === "failed") return "provider_failed"
    if (state.kind === "blocked") return "provider_blocked"
    const reason = held.get(state.changesetId)
    if (reason === "approval") return "provider_awaiting_approval"
    if (reason === "changes") return "provider_changes_requested"
    if (reason === "failed") return "provider_failed"
    if (reason === "dependency") return "provider_held"
    // Same repository: the queue composes it in order with its prerequisite.
    if (provider.logicalRootId === candidate.logicalRootId) return null
    if (!doneRoots.has(provider.logicalRootId)) return "dependency_cycle"
    return merged.has(state.changesetId) ? null : "provider_not_merged"
  }

  /** The first prerequisite that keeps `candidate` out, or null when none does. */
  const prerequisiteHold = (
    candidate: TeamIntegrationCandidate
  ): Omit<TeamIntegrationHold, "key" | "changesetId"> | null => {
    for (const taskId of dependencies[candidate.taskId] ?? []) {
      if (unsuccessful.has(taskId) && !byTask.has(taskId)) {
        return {
          cause: "provider_failed",
          provider: { key: null, logicalRootId: null, taskId, changesetId: null },
        }
      }
    }
    for (const provider of providersOf(candidate)) {
      const cause = holdCause(candidate, provider)
      if (!cause) continue
      const state = states.get(provider.key)
      return {
        cause,
        provider: {
          key: provider.key,
          logicalRootId: provider.logicalRootId,
          taskId: provider.taskId,
          changesetId: state?.kind === "captured" ? state.changesetId : null,
        },
      }
    }
    return null
  }

  for (const logicalRootId of orderRoots([...roots.keys()], rootEdges)) {
    const rootCandidates = roots.get(logicalRootId) ?? []
    const result = results.get(logicalRootId)!
    const sourceRoot = rootCandidates[0].sourceRoot

    const target = await resolveTarget(runId, logicalRootId, sourceRoot, multiRoot, config, deps)
    if ("refused" in target) {
      result.outcome = "blocked"
      result.reason = target.refused
      for (const candidate of rootCandidates) states.set(candidate.key, { kind: "blocked" })
      doneRoots.add(logicalRootId)
      continue
    }
    result.targetRef = target.targetRef
    result.createdBranch = target.createdBranch

    // ── capture, in dependency order ─────────────────────────────────────────
    // A changeset declares only the prerequisites the host can compose with
    // it: those in its own repository.
    const changesetByTask = new Map<string, string[]>()
    const captured: AgentChangeset[] = []
    for (const candidate of orderByDependencies(rootCandidates, dependencies)) {
      if (deps.signal.aborted) break
      const dependsOn = (dependencies[candidate.taskId] ?? []).flatMap(
        (taskId) => changesetByTask.get(taskId) ?? []
      )
      try {
        const changeset = await deps.host.captureChangeset({
          workspaceId: candidate.workspaceId,
          targetRef: target.targetRef,
          title: `${candidate.teammateName}: ${candidate.taskId}`,
          dependsOn,
          requiredChecks: config.requiredChecks,
        })
        captured.push(changeset)
        changesetByKey[candidate.key] = changeset.changesetId
        candidateByChangeset.set(changeset.changesetId, candidate)
        states.set(candidate.key, { kind: "captured", changesetId: changeset.changesetId })
        changesetByTask.set(candidate.taskId, [
          ...(changesetByTask.get(candidate.taskId) ?? []),
          changeset.changesetId,
        ])
      } catch (error) {
        if (scmErrorCode(error) === "nothing_to_capture") {
          result.unchanged.push(candidate.key)
          states.set(candidate.key, { kind: "unchanged" })
        } else {
          result.failed.push({
            key: candidate.key,
            reason: scmErrorCode(error) ?? "capture_failed",
          })
          states.set(candidate.key, { kind: "failed" })
        }
      }
    }

    // ── review; hold back what owes a person, and what depends on it ─────────
    const requiredChecks = new Set(config.requiredChecks)
    for (const changeset of captured) {
      let reviewed: ChangesetReviewResult
      try {
        reviewed = await deps.review(changeset.changesetId)
      } catch (error) {
        result.failed.push({
          key: candidateByChangeset.get(changeset.changesetId)?.key ?? changeset.changesetId,
          reason: scmErrorCode(error) ?? "review_failed",
        })
        held.set(changeset.changesetId, "failed")
        continue
      }
      for (const profile of requiredChecksFor(reviewed.changeset, reviewed.policy))
        requiredChecks.add(profile)
      const waiting = isWaiting(reviewed)
      if (waiting === "changes") {
        result.changesRequested.push(changeset.changesetId)
        held.set(changeset.changesetId, "changes")
      } else if (waiting === "approval") {
        result.awaitingApproval.push(changeset.changesetId)
        held.set(changeset.changesetId, "approval")
      } else {
        ready.add(changeset.changesetId)
      }
    }
    // Anything whose prerequisite is not going in waits with it, until no
    // more changes: a hold can make another changeset's prerequisite held.
    let changed = true
    while (changed) {
      changed = false
      for (const changeset of captured) {
        if (!ready.has(changeset.changesetId)) continue
        const candidate = candidateByChangeset.get(changeset.changesetId)!
        const hold = prerequisiteHold(candidate)
        if (!hold) continue
        ready.delete(changeset.changesetId)
        held.set(changeset.changesetId, "dependency")
        result.awaitingApproval.push(changeset.changesetId)
        result.holds.push({ key: candidate.key, changesetId: changeset.changesetId, ...hold })
        changed = true
      }
    }

    const integrable = captured
      .filter((changeset) => ready.has(changeset.changesetId))
      .map((c) => c.changesetId)
    if (integrable.length === 0 || deps.signal.aborted) {
      doneRoots.add(logicalRootId)
      continue
    }

    const outcome = await deps.integrate({
      changesetIds: integrable,
      targetRef: target.targetRef,
      strategy: config.strategy,
      onConflict: config.onConflict,
      requiredChecks: [...requiredChecks],
      signal: deps.signal,
    })
    result.outcome = outcome.kind
    result.integrationId = outcome.run?.integrationId ?? null
    result.resultSha = outcome.run?.resultSha ?? null
    result.dropped = outcome.dropped
    if (outcome.reason) result.reason = outcome.reason
    for (const item of outcome.run?.items ?? []) {
      if (
        outcome.kind === "published" &&
        (item.outcome === "merged" || item.outcome === "rerereResolved")
      ) {
        result.merged.push(item.changesetId)
        merged.add(item.changesetId)
      }
      if (item.outcome === "conflicted") result.conflicted.push(item.changesetId)
    }
    doneRoots.add(logicalRootId)
  }

  return {
    roots: [...roots.keys()].map((logicalRootId) => results.get(logicalRootId)!),
    changesets: changesetByKey,
  }
}
