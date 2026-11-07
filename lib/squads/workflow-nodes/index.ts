/**
 * The Agent Team's workflow node implementations (ADR-0217).
 *
 * `lib/workflow` registers the team node kinds so every workflow host knows
 * them, but it never imports team code: each executor runs through the
 * installable port in `lib/workflow/nodes/teams/team-runtime-port.ts`. This
 * module is what the team side installs there (see `./install.ts`), which
 * keeps the dependency one-way — team → workflow — and breaks the cycle the
 * workflow orchestrator used to close through `built-ins → teams → runtime`.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import type { TeamWorkflowNodes } from "@/lib/workflow/nodes/teams/team-runtime-port"
import { nonRetryable } from "@/lib/workflow/nodes/shared/executor-support"
import { runTeamCompose, runTeamDelegate, runTeamMessage, runTeamStatus } from "./team-ops"
import { isTerminalRunStatus } from "@/types/execution/run"

/** Use the same roster, capability overlays and effective backing profiles as dispatch. */
export async function resolveTeamKnowledgeBaseIds(teamId: string): Promise<readonly string[]> {
  const [
    { useAgentTeamStore },
    { resolveCharacterById },
    { resolveTeammateCapabilities },
    { teammateBaseAgentId },
  ] = await Promise.all([
    import("@/stores/squads/agent-team-store/store"),
    import("@/lib/db/characters"),
    import("../teammate/capability-resolver"),
    import("../teammate/teammate-character"),
  ])
  const state = useAgentTeamStore.getState()
  const team = state.getTeam(teamId)
  if (!team) throw nonRetryable(`team ${teamId} not found during knowledge admission`)
  const characterIds = new Set(
    state
      .getTeammates(teamId)
      .map((teammate) => teammateBaseAgentId(resolveTeammateCapabilities(team, teammate)))
      .filter((id): id is string => id !== undefined)
  )
  const knowledgeBaseIds = new Set<string>()
  for (const characterId of characterIds) {
    const character = await resolveCharacterById(characterId)
    if (!character)
      throw nonRetryable(
        `team ${teamId} backing agent ${characterId} not found during knowledge admission`
      )
    for (const knowledgeBaseId of character.knowledgeBaseIds ?? [])
      knowledgeBaseIds.add(knowledgeBaseId)
  }
  return [...knowledgeBaseIds]
}

// ── action.team.run ───────────────────────────────────────────────────────
// Starts a Squad run through the one launch seam (`startSquadRun`, ADR-0252
// §5) and waits for it to end. The workflow run is the Squad run's parent, so
// a stop of the workflow reaches it and the run tree shows it under the node.
// Returns the Squad run's id so the UI can navigate to it.
export async function runTeamNode(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as { teamId?: string; goal?: string }
  const teamId = params.teamId?.trim()
  if (!teamId) throw nonRetryable("action.team.run requires 'teamId'")

  const [
    { useAgentTeamStore },
    { buildSquadStartInput },
    { runSquadToEnd },
    { workflowSquadSurface },
  ] = await Promise.all([
    import("@/stores/squads/agent-team-store/store"),
    import("../squad/build-start-input"),
    import("../squad/run-squad-to-end"),
    import("./workflow-squad-surface"),
  ])
  if (!useAgentTeamStore.getState().getTeam(teamId)) throw nonRetryable(`team ${teamId} not found`)

  const end = await runSquadToEnd(
    buildSquadStartInput({
      squadId: teamId,
      ...(params.goal?.trim() ? { goal: params.goal.trim() } : {}),
      surface: await workflowSquadSurface(ctx),
    }),
    { ...(ctx.signal ? { signal: ctx.signal } : {}) }
  ).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    const wrapped = new Error(`action.team.run: ${message}`) as Error & { retryable?: boolean }
    wrapped.retryable = false
    throw wrapped
  })

  return {
    output: {
      teamId,
      teamRunId: end.start.runId,
      status: end.outcome,
      reason: end.reason,
    },
  }
}

// ── action.team.task.dispatch ─────────────────────────────────────────────
// Per ADR-0022 §3.6. Synthesizer-emitted node: one per AgentTeamTask. Looks
// up the per-run TeamRunContext (registered by the synthesizer before
// runWorkflow) and delegates to the shared `dispatchTeammate` primitive, which
// claims a teammate, runs one turn (tool-enabled via the sidecar on desktop,
// text-only fallback on web/mobile), validates output, and records pool /
// budget / hooks. The same primitive powers the ultracode `pattern.*` nodes.
//
// The workflow waits for settlement and checks this task's entire child history
// before retrying, including when the pool rotates to another teammate.
export async function assertTeamDispatchRetry(
  ctx: StepExecutionContext,
  executionSettled = true
): Promise<void> {
  const { getTeamRunContext } = await import("../team-run-context")
  const team = getTeamRunContext(ctx.runId)
  if (!team) throw nonRetryable("stop_unconfirmed")
  const taskId = (ctx.params as { taskId?: string }).taskId
  if (!taskId) throw nonRetryable("stop_unconfirmed")
  const [{ getDurableTeamCoordinator }, { assessStoredTaskRecovery }] = await Promise.all([
    import("../durable/durable-runtime"),
    import("@cognia/agent-orchestration/coordinator"),
  ])
  const store = getDurableTeamCoordinator().store
  const [{ parkActiveSquadRun }, { isTerminalTeamStatus }] = await Promise.all([
    import("../squad/squad-run-records"),
    import("@cognia/agent-orchestration/rules"),
  ])
  const run = await store.getRun(team.runId)
  if (!run || run.stop?.state === "requested" || run.stop?.state === "unconfirmed")
    throw Object.assign(nonRetryable("stop_unconfirmed"), {
      name: "NeedsHumanError",
      needsHuman: true,
    })
  const eligibility = await assessStoredTaskRecovery(store, team.runId, taskId, Date.now())
  if (isTerminalTeamStatus(run.status) && eligibility.eligible) return
  if (eligibility.eligible && executionSettled) return
  const reason = eligibility.eligible ? "stop_unconfirmed" : eligibility.reason
  // A stop can finish while recovery reads children/checkpoints. Compare the
  // snapshot and canonical terminal state inside the same write transaction.
  if (!(await parkActiveSquadRun(team.runId, reason, Date.now(), run))) {
    const latest = await store.getRun(team.runId)
    if (latest && latest.stop?.state !== "requested" && latest.stop?.state !== "unconfirmed") {
      if (isTerminalTeamStatus(latest.status) && eligibility.eligible) return
      const [{ getDb }, { agentTeamExecutionRunId }] = await Promise.all([
        import("@/lib/db/schema"),
        import("@/lib/execution/agent-team-bridge"),
      ])
      const execution = await getDb().executionRuns.get(agentTeamExecutionRunId(team.runId))
      if (execution && isTerminalRunStatus(execution.status) && eligibility.eligible) return
    }
  }
  throw Object.assign(nonRetryable(reason), { name: "NeedsHumanError", needsHuman: true })
}

export async function dispatchTeamTask(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as {
    teamId?: string
    taskId?: string
    title?: string
    description?: string
    expectedOutput?: string
    assignedTo?: string
    dependencies?: string[]
    access?: "read" | "write"
    taskKind?: "general" | "code" | "ui"
    repositoryId?: string
    fileOwnership?: string[]
  }
  if (!params.teamId || !params.taskId) {
    throw nonRetryable("action.team.task.dispatch requires 'teamId' and 'taskId'")
  }
  const teamId = params.teamId
  const taskId = params.taskId
  const [
    { getTeamRunContext },
    { buildTeammatePrompt },
    { dispatchTeammate },
    { readDependencyResults, autoPublishTaskResult },
    { resolvePrompt },
    { loadPromptOverrideSnapshot },
    { TEAMMATE_UPSTREAM_RESULTS_PROMPT, teamPromptContext },
  ] = await Promise.all([
    import("@/lib/squads/team-run-context"),
    import("@/lib/squads/agent-team-runtime-deps"),
    import("@/lib/squads/teammate/dispatch-teammate"),
    import("@/lib/squads/memory/shared-memory-orchestrator"),
    import("@/lib/prompts/resolve"),
    import("@/lib/prompts/snapshot"),
    import("@/lib/squads/team-prompts"),
  ])
  const teamCtx = getTeamRunContext(ctx.runId)
  if (!teamCtx) {
    throw nonRetryable(
      `action.team.task.dispatch: no TeamRunContext registered for runId=${ctx.runId}`
    )
  }

  const task = {
    id: taskId,
    title: params.title ?? taskId,
    description: params.description ?? "",
    expectedOutput: params.expectedOutput,
  } as Parameters<typeof buildTeammatePrompt>[2]

  // Blackboard read: pull the results of this task's upstream dependencies so
  // the teammate builds on prior work instead of starting cold. Dependency
  // nodes always finish first (they're DAG predecessors), so their
  // `task:<id>` entries are on the board by the time this node runs.
  const depIds = Array.isArray(params.dependencies)
    ? params.dependencies.filter((d): d is string => typeof d === "string" && d.length > 0)
    : []
  const upstream = readDependencyResults(teamId, depIds)
  // One snapshot for the step (ADR-0236): the upstream heading and the
  // teammate prompt (built later, inside the claim callback) read the same
  // revision set.
  const promptSnapshot = await loadPromptOverrideSnapshot().catch(() => null)
  const promptContext = teamPromptContext(teamCtx.team)
  const upstreamBlock =
    upstream.length > 0
      ? [
          resolvePrompt(TEAMMATE_UPSTREAM_RESULTS_PROMPT, {
            context: promptContext,
            snapshot: promptSnapshot,
          }).text,
          ...upstream.map(
            (u) =>
              `### ${u.taskTitle ?? u.taskId}${u.writerName ? ` (by ${u.writerName})` : ""}\n${u.value}`
          ),
          "",
        ].join("\n\n")
      : ""

  const access = params.access === "read" ? "read" : "write"
  const taskKind =
    params.taskKind === "ui" || params.taskKind === "general" ? params.taskKind : "code"
  const result = await dispatchTeammate(teamCtx, {
    taskId,
    // Persona-aware prompt built from the teammate the pool actually claims,
    // prefixed with any upstream dependency results.
    prompt: (teammate) => {
      const base = buildTeammatePrompt(teamCtx.team, teammate, task, { snapshot: promptSnapshot })
      return upstreamBlock ? `${upstreamBlock}\n${base}` : base
    },
    signal: ctx.signal,
    validateOutput: true,
    recordToStore: true,
    access,
    taskKind,
    ...(typeof params.repositoryId === "string" ? { repositoryId: params.repositoryId } : {}),
    ...(Array.isArray(params.fileOwnership)
      ? {
          fileOwnership: params.fileOwnership.filter(
            (path): path is string => typeof path === "string" && path.length > 0
          ),
        }
      : {}),
    // Skill-aware claim: prefer the teammate the task was assigned to.
    ...(params.assignedTo ? { preferTeammateId: params.assignedTo } : {}),
  })

  // Blackboard write: publish this task's result under `task:<taskId>` so
  // downstream teammates can read it. PII-gated + best-effort — a blackboard
  // write must never fail the task itself.
  try {
    autoPublishTaskResult(
      { id: teamId },
      { id: taskId, title: params.title ?? taskId },
      result.text,
      { id: result.teammateId, name: result.teammateName }
    )
  } catch {
    /* never fail a completed task on a blackboard write */
  }

  return {
    output: {
      text: result.text,
      teammateId: result.teammateId,
      teammateName: result.teammateName,
      // What this task was dispatched as. A lead review's revision re-dispatch
      // reads them back, so a revision runs with the same access and answers
      // to the same evidence gate as the work it revises.
      access,
      taskKind,
      tokenUsage: result.usage,
      attempt: 1,
      // ADR-0090 Phase 6: surface a degraded dispatch (lesser rail than the
      // teammate's configuration asked for) on the workflow event stream.
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
    },
  }
}

// ── action.team.task.review ───────────────────────────────────────────────
// Per ADR-0071. Synthesizer-emitted: one per task when `taskReview.enabled`,
// placed between a task's dispatch node and that task's dependents, so an
// unapproved task blocks downstream work at the SCHEDULER — dependents are not
// runnable, rather than downstream nodes being trusted to check a flag.
//
// The lead judges the worker's output plus a deterministic diff of what the
// task actually changed, and returns approved / changes_requested. A
// changes_requested re-dispatches the SAME worker into the SAME worktree with
// the lead's feedback, then reviews again, up to the budget frozen at synthesis.
//
// Not retryable: every failure mode here (exhausted budget, missing worker,
// reviewer failure) is a decision that unreviewed work must not land. Retrying
// would re-run the worker against the same wall and, worse, could let a flaky
// reviewer eventually rubber-stamp.
export async function reviewTeamTask(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as {
    teamId?: string
    taskId?: string
    title?: string
    description?: string
    expectedOutput?: string
    dispatchNodeId?: string
    maxRevisions?: number
  }
  if (!params.teamId || !params.taskId || !params.dispatchNodeId) {
    throw nonRetryable("action.team.task.review requires 'teamId', 'taskId' and 'dispatchNodeId'")
  }
  const { teamId, taskId } = params
  const [
    { getTeamRunContext },
    { dispatchTeammate, UnavailableRequiredTeammateError },
    { buildReviewEvidence },
    { DEFAULT_TASK_REVIEW_MAX_REVISIONS },
    { resolvePromptAsync },
    { REVIEW_REVISION_REQUEST_PROMPT, teamPromptContext },
  ] = await Promise.all([
    import("@/lib/squads/team-run-context"),
    import("@/lib/squads/teammate/dispatch-teammate"),
    import("@/lib/squads/ledger/review-evidence"),
    import("@/lib/squads/gates/task-review-policy"),
    import("@/lib/prompts/resolve"),
    import("@/lib/squads/team-prompts"),
  ])

  const teamCtx = getTeamRunContext(ctx.runId)
  if (!teamCtx) {
    throw nonRetryable(
      `action.team.task.review: no TeamRunContext registered for runId=${ctx.runId}`
    )
  }
  // Fail closed. Review is on, so work that reaches here has to be reviewed;
  // silently skipping would be the worst outcome — an unreviewed task
  // presented as approved.
  if (!teamCtx.lead || !teamCtx.runLeadReview) {
    throw nonRetryable(
      "action.team.task.review: task review is enabled but no lead/reviewer is wired for this run"
    )
  }
  const runLeadReview = teamCtx.runLeadReview
  const lead = teamCtx.lead

  const task = {
    id: taskId,
    title: params.title ?? taskId,
    description: params.description ?? "",
    ...(params.expectedOutput ? { expectedOutput: params.expectedOutput } : {}),
  }

  // The dispatch node's output carries both the deliverable and its author —
  // the author is what makes "send it back to whoever wrote it" possible.
  const upstream = ctx.upstream[params.dispatchNodeId] as
    | {
        text?: string
        teammateId?: string
        teammateName?: string
        access?: unknown
        taskKind?: unknown
      }
    | undefined
  if (!upstream || typeof upstream.text !== "string") {
    throw nonRetryable(
      `action.team.task.review: no output from dispatch node "${params.dispatchNodeId}"`
    )
  }
  // A revision is the same task: same access, same evidence gate. Without
  // these a read-only research task was revised with write access and then
  // refused for lacking a code diff. An output from before the dispatch node
  // recorded them falls back to the dispatch node's own defaults.
  const revisionAccess = upstream.access === "read" ? "read" : "write"
  const revisionTaskKind =
    upstream.taskKind === "ui" || upstream.taskKind === "general" ? upstream.taskKind : "code"

  let workerOutput = upstream.text
  let workerId = upstream.teammateId
  let workerName = upstream.teammateName
  // Schema-validated at the node boundary (`z.number().int().min(0)`), and
  // baked in by the synthesizer — no clamping needed here.
  const maxRevisions = params.maxRevisions ?? DEFAULT_TASK_REVIEW_MAX_REVISIONS
  let previousFeedback: string | undefined

  const fail = (reason: string): never => {
    teamCtx.storeWriter.setTaskStatus(taskId, "failed", undefined, reason)
    throw nonRetryable(`action.team.task.review: ${reason}`)
  }

  for (let revision = 0; revision <= maxRevisions; revision++) {
    const executionRoot = teamCtx.workspaceController?.getDispatchExecutionRoot(taskId)
    const workingDirBase = executionRoot ? await reviewBaseFor(teamCtx, taskId) : null
    const evidence = await buildReviewEvidence({
      ...(executionRoot ? { workingDir: executionRoot } : {}),
      ...(workingDirBase ? { workingDirBase } : {}),
      taskId,
    })
    const durableEvidence = await (
      await import("@/lib/db/agent-team-runtime")
    ).listAgentTeamEvidence(ctx.runId)
    const durableEvidenceIds = durableEvidence
      .filter((item) => item.taskId === taskId)
      .map((item) => item.id)

    // Registry reviews normally inspect the still-live detached environment;
    // a commit SHA remains optional until explicit branch promotion.
    const reviewedCommitSha = evidence.commitSha

    let verdict: { verdict: "approved" | "changes_requested"; feedback: string }
    try {
      verdict = await runLeadReview({
        team: teamCtx.team,
        lead,
        task: durableEvidenceIds.length > 0 ? { ...task, evidenceIds: durableEvidenceIds } : task,
        ...(workerName ? { workerName } : {}),
        workerOutput,
        evidence,
        revision,
        ...(previousFeedback ? { previousFeedback } : {}),
        signal: ctx.signal,
      })
    } catch (err) {
      // A reviewer/provider failure is not an approval.
      return fail(
        `the lead could not review this task (${err instanceof Error ? err.message : String(err)})`
      )
    }

    teamCtx.storeWriter.addMessage({
      teamId,
      senderId: lead.id,
      type: "direct",
      ...(workerId ? { recipientId: workerId } : {}),
      content: `[review] ${verdict.verdict === "approved" ? "Approved" : "Changes requested"}: ${verdict.feedback}`,
      taskId,
    })
    teamCtx.storeWriter.addEvent?.({
      type: verdict.verdict === "approved" ? "plan_approved" : "plan_rejected",
      teamId,
      teammateId: lead.id,
      taskId,
      data: { scope: "task-review", revision, feedback: verdict.feedback },
      timestamp: new Date(),
    })

    if (verdict.verdict === "approved") {
      // The human board gate composes with this one: an automated approval
      // hands the card to a human when they asked for the last word,
      // otherwise it completes it.
      const requireHumanReview =
        teamCtx.team?.config?.governancePolicy?.approval?.requireResultReview === true
      teamCtx.storeWriter.setTaskStatus(
        taskId,
        requireHumanReview ? "review" : "completed",
        workerOutput
      )
      return {
        output: {
          text: workerOutput,
          verdict: "approved",
          revisions: revision,
          reviewedCommitSha,
          ...(workerId ? { teammateId: workerId } : {}),
          ...(workerName ? { teammateName: workerName } : {}),
        },
      }
    }

    previousFeedback = verdict.feedback
    if (revision === maxRevisions) break

    if (!workerId) {
      return fail("the original worker is unknown, so the lead's changes cannot be applied")
    }
    try {
      // Resolved once per revision round (ADR-0236), in the team's project.
      const revisionPrompt = (
        await resolvePromptAsync(REVIEW_REVISION_REQUEST_PROMPT, {
          context: teamPromptContext(teamCtx.team),
          values: { taskTitle: task.title, feedback: verdict.feedback },
        })
      ).text
      ctx.signal?.throwIfAborted()
      const revised = await dispatchTeammate(teamCtx, {
        taskId,
        prompt: revisionPrompt,
        signal: ctx.signal,
        validateOutput: true,
        recordToStore: true,
        // Same author, same worktree: a revision addresses feedback on a diff
        // this teammate wrote, so substituting anyone else is meaningless.
        requireTeammateId: workerId,
        workspaceKey: taskId,
        access: revisionAccess,
        taskKind: revisionTaskKind,
      })
      workerOutput = revised.text
      workerId = revised.teammateId
      workerName = revised.teammateName
    } catch (err) {
      if (err instanceof UnavailableRequiredTeammateError) {
        return fail(`the original worker is no longer available to revise this task`)
      }
      return fail(
        `the revision dispatch failed (${err instanceof Error ? err.message : String(err)})`
      )
    }
  }

  return fail(
    `the lead still requested changes after ${maxRevisions} revision(s): ${previousFeedback ?? "no feedback recorded"}`
  )
}

/**
 * The ref a task's Registry environment forked from, for the lead's evidence:
 * the run's `baseRef`, else the branch the source checkout is on. The diff is
 * three-dot, so a source branch that moved on since the fork still yields only
 * the environment's own commits. Null (no base) keeps the working-tree rung.
 */
async function reviewBaseFor(
  teamCtx: import("@/lib/squads/team-run-context").TeamRunContext,
  taskId: string
): Promise<string | null> {
  const configured = teamCtx.team.config.workspaceIsolation?.baseRef
  if (configured) return configured
  const sourceRoot = teamCtx.workspaceController?.getDispatchSourceRoot(taskId)
  if (!sourceRoot) return null
  try {
    const { gitStatus } = await import("@/lib/git/commands")
    return (await gitStatus(sourceRoot)).branch
  } catch {
    return null
  }
}

// ── action.team.reconcile ─────────────────────────────────────────────────

/**
 * What `merge-all` integrates with (ADR-0227 §5): the production changeset
 * pipeline for the team's project, the run's integration policy, and the task
 * graph so each changeset declares the ones it depends on.
 */
async function mergeAllOptions(
  ctx: StepExecutionContext,
  team: import("@/types/agent/agent-team").AgentTeam
): Promise<import("@/lib/squads/workspace/registry-controller").AgentTeamMergeAllOptions> {
  const [
    { createScmRuntime, scmGitPortsFor },
    { DEFAULT_AGENT_TEAM_INTEGRATION },
    { useSettingsStore },
    { useAgentTeamStore },
  ] = await Promise.all([
    import("@/lib/scm/runtime"),
    import("@/lib/squads/workspace/integrate-team-run"),
    import("@/stores/settings/settings-store"),
    import("@/stores/squads/agent-team-store/store"),
  ])
  const configured = team.config.workspaceIsolation?.integration ?? {}
  const runtime = createScmRuntime({
    projectId: ctx.projectId ?? team.projectId ?? null,
    appSettings: useSettingsStore.getState().settings,
  })
  const dependencies: Record<string, string[]> = {}
  for (const task of useAgentTeamStore.getState().getTeamTasks(team.id)) {
    dependencies[task.id] = [...task.dependencies]
  }
  return {
    config: {
      target: configured.target ?? DEFAULT_AGENT_TEAM_INTEGRATION.target,
      strategy: configured.strategy ?? DEFAULT_AGENT_TEAM_INTEGRATION.strategy,
      onConflict: configured.onConflict ?? DEFAULT_AGENT_TEAM_INTEGRATION.onConflict,
      requiredChecks: configured.requiredChecks ?? [],
    },
    dependencies,
    deps: {
      host: runtime.host,
      review: (changesetId) => runtime.review(changesetId, ctx.signal),
      integrate: (input) => runtime.integrate(input),
      ...scmGitPortsFor(),
      signal: ctx.signal,
    },
  }
}

// Explicit promotion checkpoint for Registry-managed Agent Team environments.
export async function reconcileTeamRun(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as {
    mode?: "manual" | "merge-all" | "select" | "pipeline"
    selectStrategy?: "manual" | "first-success" | "judge"
    retain?: "all" | "keep-winner" | "prune-losers"
  }
  const { getTeamRunContext } = await import("@/lib/squads/team-run-context")
  const teamCtx = getTeamRunContext(ctx.runId)
  if (!teamCtx) {
    throw nonRetryable(`action.team.reconcile: no TeamRunContext registered for runId=${ctx.runId}`)
  }
  if (!teamCtx.workspaceController) {
    return { output: { reconciled: false } }
  }
  const mode = params.mode ?? teamCtx.team.config.workspaceIsolation?.reconcile ?? "manual"
  if (mode === "merge-all") {
    const result = await teamCtx.workspaceController.reconcile({
      mode,
      mergeAll: await mergeAllOptions(ctx, teamCtx.team),
    })
    return { output: { reconciled: true, ...result } }
  }
  const selectStrategy =
    params.selectStrategy ?? teamCtx.team.config.workspaceIsolation?.selectStrategy
  const result = await teamCtx.workspaceController.reconcile({
    mode,
    ...(selectStrategy ? { selectStrategy } : {}),
    ...(selectStrategy === "judge"
      ? {
          judge: async (candidates) => {
            const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
            const prompt = candidates
              .map(
                (candidate) => `key=${candidate.key}\n${(candidate.output ?? "").slice(0, 2000)}`
              )
              .join("\n\n")
            const text = (await executeAgent(`Pick the best candidate key only.\n\n${prompt}`, {}))
              .text
            return candidates.find((candidate) => text?.includes(candidate.key))?.key ?? null
          },
        }
      : {}),
  })
  return { output: { reconciled: true, ...result } }
}

/** Every team node implementation, as installed into the workflow port. */
export const teamWorkflowNodes: TeamWorkflowNodes = {
  run: runTeamNode,
  dispatchTask: dispatchTeamTask,
  assertDispatchRetry: assertTeamDispatchRetry,
  reviewTask: reviewTeamTask,
  reconcile: reconcileTeamRun,
  compose: runTeamCompose,
  status: runTeamStatus,
  delegate: runTeamDelegate,
  message: runTeamMessage,
}
