/**
 * Per-kind execution for one `PlanStep` in the orchestrated path (ADR-0045 P2).
 *
 * `dispatchPlanStepNode` is the body of the `action.plan.step.dispatch` node
 * executor, isolated here so it's unit-testable without the workflow
 * orchestrator. It marks the step in_progress, runs the kind-specific work via
 * `runStepWork`, then writes completed / failed back through the run context's
 * writer.
 *
 * Implemented kinds: `agent_turn` (headless `executeAgent`), `approval_gate`
 * (`lib/runtime/approval-bus`), `sub_workflow` (formal admission of the
 * published version the plan was approved against, `executeWorkflowVersion`),
 * `tool_call` (a single plugin-registered tool via `invokePluginTool`), and
 * `teammate_dispatch` (one teammate turn via the team subsystem's
 * `dispatchTeammate`, adapted through `createPlanTeammateRunContext`).
 */

import type { RunStatus, StepExecutionResult, WorkflowRunRow } from "@/types/workflow/visual"
import type { PlanStep } from "@/types/agent/plan"
import type { AgentTeammate } from "@/types/agent/agent-team"
import type { PlanRunContext } from "./plan-run-context"
import { planStepPrompt } from "./steps"
import { preparePersonalDerivedHistory } from "@/lib/execution/personal-visibility"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"

/** The approval-bus scope plan `approval_gate` steps wait on. */
export const PLAN_APPROVAL_SCOPE = "agent-plan"

/** Build the approval-bus key for a plan step's approval gate. */
export function planApprovalKey(planId: string, stepId: string): { scope: string; id: string } {
  return { scope: PLAN_APPROVAL_SCOPE, id: `${planId}:${stepId}` }
}

function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}

interface StepWorkResult {
  value: unknown
  summary: string
  /**
   * The work is held by a person outside the plan: a sub-workflow run that
   * came back `waiting` (or is still running elsewhere). The step is marked
   * `waiting` and the plan's run stops as `waiting`, never as a failure.
   */
  waiting?: true
}

/** What a `sub_workflow` step records about the child run it admitted. */
export interface SubWorkflowStepOutput {
  runId: string
  workflowId: string
  versionId: string
  status: RunStatus
  output?: unknown
}

/** Child run statuses that mean "not finished, someone else holds it". */
const HELD_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "pending",
  "running",
  "waiting",
  "paused",
])

/** The error a held step throws so the orchestrator ends the run `waiting`. */
function needsHuman(message: string): Error {
  return Object.assign(new Error(message), {
    name: "NeedsHumanError",
    retryable: false,
    needsHuman: true,
  })
}

/** Turn an admitted child run's result into the step's work result. */
function subWorkflowWork(
  record: SubWorkflowStepOutput,
  workflowName: string,
  errorMessage?: string
): StepWorkResult {
  if (record.status === "succeeded") {
    return {
      value: record,
      summary: `sub-workflow ${workflowName} completed (run ${record.runId})`,
    }
  }
  if (HELD_RUN_STATUSES.has(record.status)) {
    return {
      value: record,
      summary: `sub-workflow ${workflowName} run ${record.runId} is ${record.status === "waiting" ? "waiting for input" : record.status}; handle it, then resume the plan`,
      waiting: true,
    }
  }
  throw nonRetryable(
    `sub_workflow run ${record.runId} ended with status "${record.status}"${errorMessage ? `: ${errorMessage}` : ""}`
  )
}

/** Longest `replayedByRunId` chain a held step follows to its latest retry. */
const MAX_REPLAY_HOPS = 16

/**
 * Where the child run a `waiting` step recorded has got to since. An operator
 * answers a held run by retrying it from run history, which records the new
 * run as `replayedByRunId`, so the chain is followed to its latest link.
 * `undefined` when the recorded run is gone or ended without success: the
 * step then dispatches afresh.
 */
async function settledSubWorkflowRun(
  step: PlanStep
): Promise<{ record: SubWorkflowStepOutput; run: WorkflowRunRow } | undefined> {
  const recorded = step.output as Partial<SubWorkflowStepOutput> | undefined
  if (typeof recorded?.runId !== "string") return undefined
  const { getWorkflowRun } = await import("@/lib/db/workflows")
  let run = await getWorkflowRun(recorded.runId)
  for (let hop = 0; run?.replayedByRunId && hop < MAX_REPLAY_HOPS; hop += 1) {
    const next = await getWorkflowRun(run.replayedByRunId)
    if (!next) break
    run = next
  }
  if (!run || (run.status !== "succeeded" && !HELD_RUN_STATUSES.has(run.status))) return undefined
  return {
    run,
    record: {
      runId: run.id,
      workflowId: run.workflowId,
      versionId: run.versionId ?? recorded.versionId ?? "",
      status: run.status,
      ...(run.status === "succeeded" ? { output: run.output } : {}),
    },
  }
}

/** Derive the turn/approval prompt text for a step. */
const stepPrompt = planStepPrompt

/**
 * Best-effort, cyclic-safe one-line summary of a tool result for the step's
 * `result` field (the writer slices to 2000 chars). Never throws.
 */
function stringifySummary(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * What the approval dialog says for an `editor_review` step.
 *
 * When the diff is up, the dialog is only a decision point and should not
 * duplicate the content. When it is not, the dialog IS the review surface, so
 * the proposal is carried into it as text along with the reason — silently
 * asking "approve?" with nothing to look at is how a gate becomes a rubber
 * stamp.
 */
function editorReviewGateBody(
  step: PlanStep,
  diffShown: boolean,
  degradedReason: string | null
): string {
  const params = step.params?.kind === "editor_review" ? step.params : null
  const prompt = params?.prompt ?? step.description ?? ""
  if (diffShown) {
    return [prompt, `Review the diff for ${params?.path ?? "the file"} in the Pro IDE.`]
      .filter(Boolean)
      .join("\n\n")
  }
  return [
    prompt,
    `The Pro IDE could not show this diff${degradedReason ? ` (${degradedReason})` : ""}, ` +
      `so the proposed contents of ${params?.path ?? "the file"} are below.`,
    params?.content ?? "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

async function runStepWork(
  runCtx: PlanRunContext,
  step: PlanStep,
  signal: AbortSignal
): Promise<StepWorkResult> {
  switch (step.kind) {
    case "agent_turn": {
      const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
      const cwd = runCtx.executionRoot
      const turn = async (turnSignal: AbortSignal) => {
        const { startToolExecutionRun, finishToolExecutionRun } =
          await import("@/lib/execution/acting-authority")
        const entry = await startToolExecutionRun(runCtx.plan.sessionId, {
          parentRunId: `execution:plan:${runCtx.plan.id}`,
          title: step.title,
        })
        const executionRunId = entry.id
        let failed = true
        try {
          const history = await preparePersonalDerivedHistory(
            undefined,
            [{ id: step.id, content: stepPrompt(step) }],
            { runIds: [executionRunId], executionRunId, sessionId: runCtx.plan.sessionId }
          )
          const result = await executeAgent(history.messages[0].content, {
            executionIdentity: { runId: executionRunId },
            toolsEnabled: true,
            ...(runCtx.characterId ? { characterId: runCtx.characterId } : {}),
            ...(cwd ? { cwd } : {}),
            abortSignal: turnSignal,
          })
          failed = false
          return result
        } finally {
          await finishToolExecutionRun(entry.id, failed)
        }
      }

      // Every step of a run shares one directory, so `maxConcurrency > 1` puts
      // two tool-enabled agents in the same checkout. The slot serializes the
      // ones that write; steps with no directory take none and stay parallel.
      const result = await runStepInSlot(runCtx, cwd, signal, turn)
      return { value: { text: result.text, channel: result.channel }, summary: result.text }
    }

    case "approval_gate": {
      const { waitForDecision } = await import("@/lib/runtime/approval-bus")
      const key = planApprovalKey(runCtx.planId, step.id)
      // Register the gate BEFORE blocking: `GateModalsHost` (app-root mounted)
      // renders one dialog per store entry, and that dialog is the only thing
      // that can resolve this waiter. Without the registration the step would
      // block until the run's 24h timeout — a built-but-unanswerable gate.
      const gates = usePendingGatesStore.getState()
      gates.open({
        key,
        gateType: "plan_step",
        title: step.title,
        ...(step.params?.kind === "approval_gate" && step.params.prompt
          ? { body: step.params.prompt }
          : step.description
            ? { body: step.description }
            : {}),
        planId: runCtx.planId,
        ...(runCtx.plan.sessionId ? { sessionId: runCtx.plan.sessionId } : {}),
      })
      let decision
      try {
        decision = await waitForDecision(key, signal)
      } finally {
        // Abort (pause / cancel), reject, or approve — the entry must go, or a
        // stale dialog outlives the run.
        usePendingGatesStore.getState().close(key)
      }
      if (decision.outcome === "reject") {
        throw nonRetryable(
          `plan approval gate rejected${decision.feedback ? `: ${decision.feedback}` : ""}`
        )
      }
      return { value: { outcome: decision.outcome }, summary: "approved" }
    }

    case "editor_review": {
      if (step.params?.kind !== "editor_review") {
        throw nonRetryable("editor_review step requires params.path and params.content")
      }
      const { path, content, title } = step.params
      // Try to put the proposal in front of the user as a real diff. Failure is
      // NOT fatal: the review still has to happen, so a missing Pro IDE degrades
      // to the plain gate below with the proposal carried as text. A plan
      // authored on the desktop therefore still runs on a phone — it just
      // reviews in a dialog instead of in VS Code.
      let diffShown = false
      let degradedReason: string | null = null
      try {
        const [{ codeServerClient }, { resolveProIdeRoot }] = await Promise.all([
          import("@/lib/codeserver/client"),
          import("@/lib/codeserver/resolve-root"),
        ])
        const root = resolveProIdeRoot("editor_review", step.params.root)
        const absolute =
          path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
            ? path
            : `${root.replace(/[/\\]+$/, "")}/${path.replace(/^[/\\]+/, "")}`
        await codeServerClient.showDiff(root, absolute, content, title)
        diffShown = true
      } catch (cause) {
        degradedReason = cause instanceof Error ? cause.message : String(cause)
      }

      const { waitForDecision } = await import("@/lib/runtime/approval-bus")
      const key = planApprovalKey(runCtx.planId, step.id)
      const gates = usePendingGatesStore.getState()
      gates.open({
        key,
        gateType: "plan_step",
        title: step.title,
        body: editorReviewGateBody(step, diffShown, degradedReason),
        planId: runCtx.planId,
        ...(runCtx.plan.sessionId ? { sessionId: runCtx.plan.sessionId } : {}),
      })
      let decision
      try {
        decision = await waitForDecision(key, signal)
      } finally {
        usePendingGatesStore.getState().close(key)
      }
      if (decision.outcome === "reject") {
        throw nonRetryable(
          `editor review rejected${decision.feedback ? `: ${decision.feedback}` : ""}`
        )
      }
      return {
        value: { outcome: decision.outcome, path, diffShown },
        summary: diffShown ? "approved in editor" : "approved",
      }
    }

    case "sub_workflow": {
      if (step.params?.kind !== "sub_workflow" || !step.params.workflowId) {
        throw nonRetryable("sub_workflow step requires params.workflowId")
      }
      // Approval pinned the version that runs (ADR-0045 amendment). Without a
      // pin there is no approved version, so there is nothing this step may run.
      const binding = step.params.binding
      if (!binding || binding.workflowId !== step.params.workflowId) {
        throw nonRetryable(
          `sub_workflow step "${step.title}" is not pinned to a published version of workflow ${step.params.workflowId}; approve the plan again`
        )
      }
      const { executeWorkflowVersion, WorkflowAdmissionError } =
        await import("@/lib/workflow/runtime/execution-authority")
      const planExecutionRunId = `execution:plan:${runCtx.planId}`
      let execution: Awaited<ReturnType<typeof executeWorkflowVersion>>
      try {
        execution = await executeWorkflowVersion({
          workflowId: binding.workflowId,
          versionId: binding.versionId,
          deploymentId: binding.deploymentId,
          deploymentRevision: binding.deploymentRevision,
          ...(binding.dependencyLock ? { dependencyLock: binding.dependencyLock } : {}),
          entrypoint: "plan",
          caller: `plan:${runCtx.planId}`,
          // One admission per step per plan run: a crash-resumed run reuses its
          // child, a resumed (new) plan run admits a fresh one.
          idempotencyKey: `${runCtx.runId}:${step.id}`,
          authorityParentRunId: planExecutionRunId,
          lineage: {
            rootRunId: runCtx.runId,
            parentRunId: runCtx.runId,
            parentStepId: step.id,
            authorityParentRunId: planExecutionRunId,
          },
          triggerKind: "trigger.manual",
          payload: step.params.triggerPayload ?? {},
          signal,
        })
      } catch (error) {
        if (error instanceof WorkflowAdmissionError) {
          // The approved deployment was disabled, the input no longer fits its
          // schema, … — the approval no longer describes something runnable.
          throw nonRetryable(`sub_workflow: ${error.message}`)
        }
        throw error
      }
      const result = execution.result
      return subWorkflowWork(
        {
          runId: result.runId,
          workflowId: binding.workflowId,
          versionId: execution.version.id,
          status: result.status,
          ...(result.status === "succeeded" ? { output: result.output } : {}),
        },
        execution.version.name,
        result.error?.message
      )
    }

    case "tool_call": {
      if (step.params?.kind !== "tool_call" || !step.params.toolName) {
        throw nonRetryable("tool_call step requires params.toolName")
      }
      const { toolName, input } = step.params
      const { resolvePluginToolByName, invokePluginTool, PluginToolInvocationError } =
        await import("@/lib/plugin/core/invoke-plugin-tool")
      const owner = await resolvePluginToolByName(toolName)
      if (!owner) {
        // Built-in cognia tools (Bash/Read/Edit/…) have no host-side single-call
        // executor — they run only inside an agent turn. MCP tools now have a
        // dedicated `mcp_tool_call` step kind.
        throw nonRetryable(
          `tool_call: no plugin-registered tool '${toolName}'. ` +
            "Built-in tools run only inside an agent turn (use an agent_turn step); " +
            "for MCP server tools use an mcp_tool_call step instead."
        )
      }
      try {
        const { result } = await invokePluginTool(owner.pluginId, toolName, input ?? {}, {
          signal,
          reason: "plan:tool_call",
          executionRunId: `execution:plan:${runCtx.plan.id}`,
          ...(runCtx.plan.sessionId ? { sessionId: runCtx.plan.sessionId } : {}),
        })
        return {
          value: { toolName, pluginId: owner.pluginId, data: result },
          summary: stringifySummary(result),
        }
      } catch (err) {
        // Config / permission / resolution failures are terminal; runtime
        // (`execution-failed`) and `aborted` stay retryable so the
        // orchestrator's retry budget applies. Mirrors `action.plugin.invoke`.
        if (
          err instanceof PluginToolInvocationError &&
          (err.code === "plugin-not-found" ||
            err.code === "plugin-disabled" ||
            err.code === "tool-not-found" ||
            err.code === "permission-denied")
        ) {
          throw nonRetryable(`tool_call '${toolName}': ${err.message}`)
        }
        throw err
      }
    }

    case "mcp_tool_call": {
      if (step.params?.kind !== "mcp_tool_call" || !step.params.serverId || !step.params.toolName) {
        throw nonRetryable("mcp_tool_call step requires params.serverId and params.toolName")
      }
      const { serverId, toolName, input } = step.params
      const [{ invokeMcpTool, McpServerNotFoundError }, { getPluginEventHooks }] =
        await Promise.all([import("@/lib/mcp/invoke"), import("@/lib/plugin")])
      const hooks = getPluginEventHooks()
      const args = input ?? {}
      // Fire the same plugin lifecycle hooks the workflow node fires — an MCP
      // call is an MCP call regardless of entry point.
      hooks.dispatchMCPServerConnect(serverId, serverId)
      hooks.dispatchMCPToolCall(serverId, toolName, args)
      try {
        const result = await invokeMcpTool({
          serverId,
          toolName,
          args,
          signal,
          scopeId: `run:${runCtx.runId}`,
          credentialContext: { executionRunId: `execution:plan:${runCtx.plan.id}` },
          surface: "plan",
          clientInfo: { name: "cognia-plan", version: "1.0.0" },
        })
        hooks.dispatchMCPToolResult(serverId, toolName, {
          isError: result.isError,
          content: result.content,
          structuredContent: result.structuredContent,
        })
        return {
          value: { serverId, toolName, data: result },
          summary: stringifySummary(result.content),
        }
      } catch (err) {
        // Server-not-found is a config error → terminal; connection / runtime
        // failures stay retryable so the orchestrator's retry budget applies.
        if (err instanceof McpServerNotFoundError) {
          throw nonRetryable(`mcp_tool_call '${toolName}': ${err.message}`)
        }
        throw err
      } finally {
        hooks.dispatchMCPServerDisconnect(serverId)
      }
    }

    case "teammate_dispatch": {
      if (step.params?.kind !== "teammate_dispatch" || !step.params.teamId) {
        throw nonRetryable("teammate_dispatch step requires params.teamId")
      }
      const { teamId, teammateId, spawnPrompt } = step.params
      const { useAgentTeamStore } = await import("@/stores/squads/agent-team-store/store")
      const state = useAgentTeamStore.getState()
      const team = state.teams[teamId]
      if (!team) {
        // Team definitions persist across restart (Scheduler Phase D); a miss
        // means the team was never created or was deleted.
        throw nonRetryable(
          `teammate_dispatch: team '${teamId}' is not loaded — create the team before dispatching to it`
        )
      }
      let teammates: AgentTeammate[]
      if (teammateId) {
        const tm = state.teammates[teammateId]
        if (!tm) throw nonRetryable(`teammate_dispatch: teammate '${teammateId}' not found`)
        teammates = [tm]
      } else {
        teammates = (team.teammateIds ?? [])
          .map((id) => state.teammates[id])
          .filter((t): t is AgentTeammate => t !== undefined)
      }
      if (teammates.length === 0) {
        throw nonRetryable(`teammate_dispatch: team '${teamId}' has no resolvable teammates`)
      }
      const [{ createPlanTeammateRunContext }, { dispatchTeammate }] = await Promise.all([
        import("./plan-teammate-context"),
        import("@/lib/squads/teammate/dispatch-teammate"),
      ])
      const teamCtx = createPlanTeammateRunContext({
        runId: runCtx.runId,
        team,
        teammates,
        personalExecutionRunId: `execution:plan:${runCtx.plan.id}`,
      })
      const result = await dispatchTeammate(teamCtx, {
        taskId: step.id,
        prompt: spawnPrompt?.trim() || stepPrompt(step),
        signal,
        validateOutput: true,
        recordToStore: false,
      })
      return {
        value: {
          text: result.text,
          teammateId: result.teammateId,
          teammateName: result.teammateName,
          channel: result.channel,
          usage: result.usage,
        },
        summary: result.text,
      }
    }

    default: {
      const exhaustive: never = step.kind
      throw nonRetryable(`unknown plan step kind: ${String(exhaustive)}`)
    }
  }
}

/**
 * Execute one plan step, writing its status transitions through the run
 * context. Returns the workflow node result. On failure the step is marked
 * `failed` and the error is re-thrown so the orchestrator's retry / error
 * policy applies.
 */
export async function dispatchPlanStepNode(
  runCtx: PlanRunContext,
  stepId: string,
  signal: AbortSignal
): Promise<StepExecutionResult> {
  const step = runCtx.plan.steps.find((s) => s.id === stepId)
  if (!step) {
    throw nonRetryable(`action.plan.step.dispatch: step "${stepId}" not in plan "${runCtx.planId}"`)
  }
  // A resumed plan run continues the plan, it does not redo it: finished work
  // keeps its recorded output.
  if (step.status === "completed") return { output: step.output }
  if (step.status === "waiting") {
    const settled = await settledSubWorkflowRun(step)
    if (settled?.run.status === "succeeded") {
      const completedAt = Date.now()
      await runCtx.writer.setStepStatus(step.id, "completed", {
        result: `sub-workflow run ${settled.record.runId} completed`,
        output: settled.record,
        completedAt,
      })
      return { output: settled.record }
    }
    if (settled) {
      // Still held: keep the step waiting and stop this run the same way.
      const message = `sub-workflow run ${settled.record.runId} is still ${settled.run.status}; handle it, then resume the plan`
      await runCtx.writer.setStepStatus(step.id, "waiting", {
        result: message,
        output: settled.record,
      })
      throw needsHuman(message)
    }
    // The held run is gone or ended without success: dispatch afresh below.
  }

  const [{ syncPlanExecutionRun }, { getSession }] = await Promise.all([
    import("@/lib/execution/agent-state-bridge"),
    import("@/lib/db/sessions"),
  ])
  await syncPlanExecutionRun(runCtx.plan, await getSession(runCtx.plan.sessionId))
  const startedAt = Date.now()
  await runCtx.writer.setStepStatus(step.id, "in_progress", { startedAt })

  let work: StepWorkResult
  try {
    work = await runStepWork(runCtx, step, signal)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await runCtx.writer.setStepStatus(step.id, "failed", {
      error: message,
      completedAt: Date.now(),
      attempts: (step.attempts ?? 0) + 1,
    })
    throw err
  }
  if (work.waiting) {
    // Held, not failed: the step keeps the child run it is waiting on, and the
    // run ends `waiting`, which the plan runtime turns into a paused plan.
    await runCtx.writer.setStepStatus(step.id, "waiting", {
      result: work.summary.slice(0, 2000),
      output: work.value,
    })
    throw needsHuman(work.summary)
  }
  const completedAt = Date.now()
  await runCtx.writer.setStepStatus(step.id, "completed", {
    result: work.summary.slice(0, 2000),
    output: work.value,
    completedAt,
    actualDurationMs: completedAt - startedAt,
  })
  return { output: work.value }
}

/**
 * Run a step's work holding the execution slot for its directory.
 *
 * Without a directory there is nothing to exclude anyone from, so the work runs
 * directly — inventing a slot would queue steps that never conflict.
 *
 * The lease's signal is combined with the run's own: a paused or cancelled plan
 * must abort the turn, and so must the broker cancelling the lease.
 */
async function runStepInSlot<T>(
  runCtx: PlanRunContext,
  cwd: string | undefined,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const [{ slotKeyForPath }, { combineAbortSignals, runWithExecutionLease }] = await Promise.all([
    import("@/lib/execution/slot-key"),
    import("@/lib/execution/admit"),
  ])
  const slotKey = slotKeyForPath(cwd)
  if (!slotKey) return work(signal)

  return runWithExecutionLease(
    {
      kind: "workflow-step",
      label: runCtx.plan.title,
      runId: runCtx.runId,
      // Deliberately NOT `sessionId`. The broker exempts any leg naming a
      // session that already has an active leg — the rule that keeps a
      // foreground chat turn from being blocked by its own stream. Every step
      // of a plan shares the plan's session, so passing it would exempt every
      // step after the first and the slot would serialize nothing at all.
      // Cancellation still reaches these steps: the plan's own AbortController
      // is chained in as `signal` below.
      ...(runCtx.plan.projectId ? { projectId: runCtx.plan.projectId } : {}),
      slotKey,
      signal,
    },
    async (lease) => {
      const combined = combineAbortSignals(signal, lease.signal)
      try {
        return await work(combined?.signal ?? signal)
      } finally {
        combined?.cleanup()
      }
    }
  )
}
