import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import { DEFAULT_TEAM_CONFIG, type AgentTeam } from "@/types/agent/agent-team"
import type { BestOfNGroup } from "@/types/best-of-n"
import { getDurableTeamCoordinator } from "@/lib/squads/durable/durable-runtime"
import { beginDurableDispatch } from "@/lib/squads/durable/durable-dispatch"
import { controlDurableRun } from "@/lib/squads/durable/durable-control"
import {
  agentTeamExecutionRunId,
  settleAgentTeamExecutionRun,
} from "@/lib/execution/agent-team-bridge"
import {
  bestOfNExecutionRunId,
  ensureBestOfNExecutionRun,
  settleBestOfNExecutionRun,
} from "@/lib/execution/best-of-n-bridge"
import { getExecutionRun } from "@/lib/db/execution-runs"
import {
  acquireWorkspaceBundle,
  getWorkspaceBundle,
  ensureWorkspacePortLease,
} from "@/lib/task-workspace/client"
import { openWorkspaceBundleTurnLease } from "@/lib/task-workspace/run-lease"
import { runWorkspaceUserAction } from "@/lib/task-workspace/user-action"
import { createScmHost, scmErrorCode } from "@/lib/scm/host"
import {
  externalAgentIdFromProviderId,
  isExternalAgentProviderId,
} from "@/lib/ai/agent/external/session/session-models"
import type { SurfaceUsageInput } from "@/lib/db/session-usage"
import { externalTokenUsageToUsageInfo } from "@/lib/claude/usage"
import { claimTurnUsage, trackCaptureUsage } from "@/lib/usage/claimed-turn-usage"
import { describeBestOfNAgent } from "./agents"
import { runExternalCandidate } from "./external"
import {
  BestOfNAttemptError,
  BestOfNCandidateStoppedError,
  type BestOfNExecution,
  type BestOfNInput,
  type CandidateResult,
} from "./core"

export function bestOfNTeam(group: BestOfNGroup, request: BestOfNInput): AgentTeam {
  return {
    id: group.groupId,
    name: "Best-of-N",
    description: "Independent attempts",
    task: request.prompt,
    ...(request.projectId ? { projectId: request.projectId } : {}),
    status: "executing",
    leadId: group.groupId,
    teammateIds: group.candidates.map((candidate) => candidate.candidateId),
    taskIds: group.candidates.map((candidate) => candidate.candidateId),
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(group.createdAt),
    config: {
      ...DEFAULT_TEAM_CONFIG,
      writeMode: "single-writer",
      maxTeammates: group.n,
      maxConcurrentTeammates: group.n,
      enableMessaging: false,
      enableSharedTaskList: false,
      enableTaskRetry: false,
      enableDeadlockRecovery: false,
      maxRetries: 0,
      repositories: [
        { id: group.repositoryId, path: group.sourceRoot, role: "primary", writable: true },
      ],
      evidencePolicy: {
        requireActivity: true,
        requireOutcome: true,
        requireCodeDiff: false,
        requireVerification: false,
        requireVisualForUi: false,
      },
      resourcePolicy: {
        priority: 0,
        maxConcurrentChildren: group.n,
        maxWallTimeMs: group.budgetPolicy.maxDurationMs ?? 600_000,
        ...(group.budgetPolicy.maxCostUsd == null
          ? {}
          : { maxCostUsd: group.budgetPolicy.maxCostUsd }),
      },
    },
  }
}

/**
 * A candidate's run row title: which attempt of how many, and who made it.
 * Two groups side by side in the run monitor stay told apart by their group.
 */
export function candidateRowTitle(
  group: Pick<BestOfNGroup, "n">,
  candidate: Pick<BestOfNGroup["candidates"][number], "index" | "agent">,
  agentName: string | undefined
): string {
  const who = agentName?.trim() || candidate.agent.agentId
  const model = candidate.agent.model ? ` (${candidate.agent.model})` : ""
  return `Best-of-N ${candidate.index + 1}/${group.n} · ${who}${model}`
}

/** Production ports use the ordinary confined turn, PII gate, and capture pipeline. */
export function createBestOfNExecution(): BestOfNExecution {
  const coordinator = getDurableTeamCoordinator()
  const scm = createScmHost()
  return {
    async prepare(group, request) {
      // The group's own row first: the team journal sees it and writes no
      // `team` row for this durable run (ADR-0252 P5).
      await ensureBestOfNExecutionRun({
        groupId: group.groupId,
        teamRunId: group.teamRunId,
        prompt: request.prompt,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.projectId ? { projectId: request.projectId } : {}),
        at: Date.now(),
      })
      await coordinator.prepareRun(bestOfNTeam(group, request), group.teamRunId)
    },
    async acquire(group, candidate, request) {
      const bundle = await runWorkspaceUserAction("task_workspace_bundle_acquire", () =>
        acquireWorkspaceBundle({
          ownerType: "session",
          ownerRef: candidate.childSessionId,
          ...(request.projectId ? { projectId: request.projectId } : {}),
          environmentKind: "managed",
          base: { kind: "gitRef", gitRef: group.baseSha },
          roots: [
            { logicalRootId: group.repositoryId, role: "primary", sourceRoot: group.sourceRoot },
          ],
        })
      )
      const root = bundle.leases.find((lease) => lease.role === "primary")
      if (
        !root ||
        bundle.leases.length !== 1 ||
        bundle.ownerRef !== candidate.childSessionId ||
        bundle.state !== "active"
      ) {
        throw new Error("Best-of-N received an invalid candidate workspace bundle")
      }
      const ports = await runWorkspaceUserAction("task_workspace_port_lease_ensure", () =>
        ensureWorkspacePortLease(root.workspaceId)
      )
      return {
        bundleId: bundle.bundleId,
        workspaceId: root.workspaceId,
        physicalRoot: ports.canonicalRoot,
      }
    },
    async execute({ group, candidate, workspace, request, grant, signal }) {
      const [
        { getDb },
        { getCharacter },
        { getSettings },
        { resolveSendOptions },
        runner,
        ipc,
        usageLedger,
      ] = await Promise.all([
        import("@/lib/db/schema"),
        import("@/lib/db/characters"),
        import("@/lib/db/settings"),
        import("@/lib/claude/build-options"),
        import("@/lib/claude/run-and-capture"),
        import("@/lib/claude/ipc"),
        import("@/lib/db/session-usage"),
      ])
      const character = await getCharacter(candidate.agent.agentId)
      if (!character) throw new Error(`Unknown best-of-N agent: ${candidate.agent.agentId}`)
      const bundle = await getWorkspaceBundle(workspace.bundleId)
      if (!bundle || bundle.state !== "active") throw new Error("Candidate workspace disappeared")
      const session: ChatSession = {
        id: candidate.childSessionId,
        title: `Best-of-N ${candidate.index + 1}`,
        programmaticCreator: "best-of-n",
        kind: "direct",
        characterId: character.id,
        // An external candidate's runtime is part of its identity, so the
        // child conversation shows what actually ran.
        ...(describeBestOfNAgent(candidate.agent).kind === "external"
          ? {
              providerOverride: candidate.agent.provider!,
              ...(candidate.agent.model ? { model: candidate.agent.model } : {}),
            }
          : {}),
        workingDir: workspace.physicalRoot,
        workspaceConfinementEnabled: true,
        ...(request.projectId ? { projectId: request.projectId } : {}),
        createdAt: group.createdAt,
        updatedAt: Date.now(),
      }
      // Host allocated this identity. It has no parent transcript or sibling context.
      const db = getDb()
      await db.transaction("rw", db.sessions, async () => {
        const existing = await db.sessions.get(session.id)
        if (
          existing &&
          (existing.characterId !== character.id || existing.workingDir !== workspace.physicalRoot)
        )
          throw new Error("Candidate session binding changed")
        if (!existing) await db.sessions.add(session)
      })
      const dispatch = await beginDurableDispatch({
        coordinator,
        team: bestOfNTeam(group, request),
        runId: group.teamRunId,
        teammateId: candidate.candidateId,
        taskId: candidate.candidateId,
        access: "write",
        taskKind: "code",
        repositoryId: group.repositoryId,
        isolateFailure: true,
      })
      const turn: { lease: Awaited<ReturnType<typeof openWorkspaceBundleTurnLease>> } = {
        lease: null,
      }
      let costUsd: number | null = null
      // One ledger row per candidate (an attempt is never replayed), under the
      // child conversation so it rolls up with the transcript it produced. A
      // candidate is a child of the durable team run, hence `agent-team`.
      const bookUsage = async (usage: SurfaceUsageInput | undefined) => {
        if (!usage) return
        try {
          await usageLedger.recordSurfaceUsage({
            surface: "agent-team",
            operationId: `best-of-n:${group.groupId}:${candidate.candidateId}`,
            sessionId: session.id,
            usage: {
              ...usage,
              runId: group.teamRunId,
              ...(request.projectId ? { projectId: request.projectId } : {}),
            },
          })
        } catch (error) {
          // A mirror of spend that already happened; never fails the attempt.
          console.warn("Best-of-N usage booking failed", error)
        }
      }
      // A stop of this candidate's own row (the run monitor, the Job Center)
      // ends this attempt alone; the group's signal ends them all.
      const ownStop = new AbortController()
      const attemptSignal = AbortSignal.any([signal, ownStop.signal])
      try {
        await dispatch.setWorkspace({ workspacePath: workspace.physicalRoot })
        await dispatch.attachControl(
          {
            steer: async () => {
              throw new Error("Independent attempts cannot receive steering")
            },
            terminate: async () => {
              await ipc.interruptSession(session.id)
            },
          },
          session.id
        )
        const { launchChildRun, childJobExecutionRunId } =
          await import("@/lib/execution/launch-child-run")
        const candidateRunId = childJobExecutionRunId(candidate.candidateId)
        const rowTitle = candidateRowTitle(group, candidate, character.name)
        // The attempt is the candidate's engine; the child run is its record.
        const attempt = () =>
          dispatch.run(async (): Promise<CandidateResult> => {
            attemptSignal.throwIfAborted()
            turn.lease = await openWorkspaceBundleTurnLease(bundle, group.repositoryId, {
              taskId: candidate.candidateId,
              sessionId: session.id,
              runId: candidate.candidateId,
              parentRunId: group.teamRunId,
              agentId: character.id,
              agentKind: "teammate",
              workspaceRoot: workspace.physicalRoot,
              base: { kind: "gitRef", gitRef: group.baseSha },
            })
            if (!turn.lease) throw new Error("Candidate workspace turn could not be leased")
            // Resolve against the candidate root, never the parent project's mounts.
            // This supplies the normal workspace-confinement path even for a
            // repository that has no saved Project row.
            const candidateProject: Project = {
              id: candidate.candidateId,
              name: session.title,
              roots: [{ id: group.repositoryId, path: workspace.physicalRoot, isPrimary: true }],
              knowledgeBase: [],
              sessionIds: [session.id],
              sessionCount: 1,
              messageCount: 0,
              createdAt: new Date(group.createdAt),
              updatedAt: new Date(group.createdAt),
              lastAccessedAt: new Date(group.createdAt),
            }
            const remainingMs = Math.max(
              1,
              (group.budgetPolicy.maxDurationMs ?? 600_000) - (Date.now() - group.createdAt)
            )
            const declared = describeBestOfNAgent(candidate.agent)
            const options =
              declared.kind === "external"
                ? null
                : await resolveSendOptions({
                    session,
                    character,
                    appSettings: await getSettings(),
                    activeProject: candidateProject,
                    agentKind: "teammate",
                    capabilityGrants: [grant],
                    routingSurface: "agent",
                    routingContextHint: { promptText: request.prompt, category: "coding" },
                  })
            // A Cognia agent whose own default runtime is external takes the same lane.
            const externalConfigId =
              declared.kind === "external"
                ? declared.configId
                : isExternalAgentProviderId(options?.provider)
                  ? externalAgentIdFromProviderId(options?.provider)
                  : undefined
            let text: string
            if (externalConfigId !== undefined) {
              if (!externalConfigId)
                throw new Error("Best-of-N candidate names an unscoped external agent")
              // The external execute contract has no dollar cap and reports no cost.
              if (group.budgetPolicy.maxCostUsd != null)
                throw new Error("The selected runtime cannot enforce the best-of-N cost budget")
              const externalModel =
                (declared.kind === "external" ? candidate.agent.model : options?.model) ?? undefined
              let reported: SurfaceUsageInput | undefined
              try {
                ;({ text } = await runExternalCandidate({
                  configId: externalConfigId,
                  prompt: request.prompt,
                  model: externalModel,
                  workingDirectory: workspace.physicalRoot,
                  signal: AbortSignal.any([attemptSignal, AbortSignal.timeout(remainingMs)]),
                  onCapture: dispatch.capture,
                  onUsage: (usage) => {
                    // The agent's own figures. Its provider is not a Cognia price
                    // list, so the row gets no provider bucket and no guessed price.
                    reported = {
                      ...usageLedger.externalAgentSurfaceUsage(
                        externalTokenUsageToUsageInfo(usage)
                      ),
                      ...(externalModel ? { model: externalModel } : {}),
                    }
                  },
                }))
              } finally {
                await bookUsage(reported)
              }
            } else {
              const sendOptions = options!
              // The frozen execution spec is the sidecar's runtime authority. The
              // AI-SDK lane does not enforce SendOptions.maxBudgetUsd, so a dollar
              // cap must fail closed there instead of silently becoming advisory.
              const runtimeAdapter = sendOptions.execution?.runtimeAdapter
              const costCap = group.budgetPolicy.maxCostUsd
              if (
                costCap != null &&
                (runtimeAdapter !== "claude-agent-sdk" ||
                  sendOptions.maxBudgetUsd == null ||
                  !Number.isFinite(sendOptions.maxBudgetUsd) ||
                  sendOptions.maxBudgetUsd <= 0 ||
                  sendOptions.maxBudgetUsd > costCap / group.n)
              ) {
                throw new Error("The selected runtime cannot enforce the best-of-N cost budget")
              }
              // The desktop chat runtime ingests this child's stream too, and
              // would book it as a `chat` row naming no provider. Claim the turn
              // so the row below, with provider, model and run, is the only one.
              const turnOptions = {
                ...sendOptions,
                turnId: sendOptions.turnId ?? crypto.randomUUID(),
              }
              claimTurnUsage(session.id, turnOptions.turnId)
              const usageTracker = trackCaptureUsage()
              let result: Awaited<ReturnType<typeof runner.runAndCaptureAssistantReply>> | undefined
              try {
                result = await runner.runAndCaptureAssistantReply(
                  session.id,
                  request.prompt,
                  turnOptions,
                  {
                    signal: attemptSignal,
                    timeoutMs: remainingMs,
                    onEvent: (event) => {
                      usageTracker.observe(event)
                      dispatch.capture(event)
                    },
                    // The lease names the candidate's own row, so the live
                    // leg stands in for that row in the run monitor, under
                    // the group, instead of a second row for the group.
                    execution: {
                      kind: "team",
                      label: rowTitle,
                      runId: candidateRunId,
                      taskId: candidate.candidateId,
                    },
                  }
                )
              } finally {
                // Also for an attempt that was cancelled or failed: its calls were billed.
                const usage = usageTracker.resolve(result?.usage)
                await bookUsage(
                  usage && {
                    ...usageLedger.surfaceUsageFromUsageInfo(usage, {
                      costAuthority: runtimeAdapter === "claude-agent-sdk",
                    }),
                    ...(turnOptions.model ? { model: turnOptions.model } : {}),
                    ...(turnOptions.provider ? { providerId: turnOptions.provider } : {}),
                    turnId: turnOptions.turnId,
                  }
                )
              }
              const reportedCost = result.usage?.totalCostUsd
              // AI-SDK's result adapter emits zero when the provider supplies no
              // cost. Preserve unknown instead of turning that wire default into
              // a claim that the attempt was free.
              costUsd =
                reportedCost == null ||
                (reportedCost === 0 && runtimeAdapter !== "claude-agent-sdk")
                  ? null
                  : reportedCost
              if (result.resultSubtype?.startsWith("error"))
                throw new BestOfNAttemptError(
                  `Candidate execution ended: ${result.resultSubtype}`,
                  costUsd
                )
              text = result.text
            }
            await turn.lease.settle("ready")
            let changeset
            try {
              changeset = await scm.captureChangeset({
                workspaceId: workspace.workspaceId,
                targetRef: group.targetRef,
                title: `Best-of-N ${candidate.index + 1}`,
                requiredChecks: request.requiredChecks ?? [],
              })
            } catch (error) {
              if (scmErrorCode(error) !== "nothing_to_capture") throw error
            }
            await dispatch.complete({
              text,
              ...(costUsd === null ? {} : { costUsd }),
              ...(changeset
                ? {
                    commitSha: changeset.headSha,
                    workspaceRevision: changeset.headSha,
                    diffContent: JSON.stringify(changeset.files),
                  }
                : {}),
            })
            return {
              hasChanges: changeset?.files.some((file) => !file.excluded) ?? false,
              costUsd,
              ...(changeset
                ? { changesetId: changeset.changesetId, headSha: changeset.headSha }
                : {}),
            }
          }, attemptSignal)
        // Each candidate is a child run of the group's run (ADR-0252 §2), in
        // its own conversation. The group's row is its own `best-of-n` row,
        // written before the run was prepared. The launcher writes, links and
        // settles the child's row; the attempt keeps its own result and error.
        let result: CandidateResult | undefined
        let thrown: { error: unknown } | undefined
        const launched = await launchChildRun({
          parentRunId: bestOfNExecutionRunId(group.teamRunId),
          sessionId: session.id,
          title: rowTitle,
          childId: candidate.candidateId,
          surface: "agent-team",
          signal,
          target: {
            kind: "agent",
            label: candidate.agent.agentId,
            engine: {
              run: async (stopSignal) => {
                // The launcher's stop for this row. Interrupting the session
                // ends the turn the attempt is waiting on.
                const stop = () => {
                  ownStop.abort(stopSignal.reason)
                  void Promise.resolve()
                    .then(() => ipc.interruptSession(session.id))
                    .catch(() => undefined)
                }
                if (stopSignal.aborted) stop()
                else stopSignal.addEventListener("abort", stop, { once: true })
                try {
                  result = await attempt()
                } catch (error) {
                  thrown = { error }
                  throw error
                } finally {
                  stopSignal.removeEventListener("abort", stop)
                }
                return { status: "completed" }
              },
            },
          },
        })
        if (!launched.started) {
          if (launched.reason === "cancelled")
            throw signal.reason ?? new Error("Best-of-N candidate cancelled before it started")
          throw new Error(
            `Best-of-N candidate could not start (${launched.reason}${launched.detail ? `: ${launched.detail}` : ""})`
          )
        }
        const settled = await launched.outcome
        if (thrown) throw thrown.error
        if (result) return result
        throw new Error(settled.error ?? "Best-of-N candidate ended without a result")
      } catch (error) {
        const cleanup = await Promise.allSettled([
          dispatch.fail(error),
          turn.lease?.settle(attemptSignal.aborted ? "cancelled" : "failed"),
        ])
        const failed = cleanup.filter(
          (item): item is PromiseRejectedResult => item.status === "rejected"
        )
        if (failed.length)
          throw new BestOfNAttemptError("Candidate execution and cleanup failed", costUsd, {
            cause: new AggregateError([error, ...failed.map((item) => item.reason)]),
          })
        if (ownStop.signal.aborted && !signal.aborted)
          throw new BestOfNCandidateStoppedError(costUsd, { cause: error })
        throw new BestOfNAttemptError(
          error instanceof Error ? error.message : String(error),
          costUsd,
          { cause: error }
        )
      } finally {
        dispatch.dispose()
      }
    },
    async stop(group) {
      const { interruptSession } = await import("@/lib/claude/ipc")
      await Promise.all(
        group.candidates
          .filter((candidate) =>
            ["running", "cancelRequested", "recoveryRequired"].includes(candidate.status)
          )
          .map((candidate) => interruptSession(candidate.childSessionId))
      )
      if (await coordinator.store.getRun(group.teamRunId))
        await controlDurableRun(group.teamRunId, "stop", { coordinator })
    },
    async finish(group) {
      const run = await coordinator.store.getRun(group.teamRunId)
      if (!run) return
      const at = Date.now()
      await coordinator.store.updateRunIfCurrent(run.id, run, {
        status:
          group.phase === "cancelled"
            ? "cancelled"
            : group.phase === "recoveryRequired"
              ? "needs_input"
              : "completed",
        updatedAt: at,
        completedAt: at,
      })
      // The group's row is the candidates' parent. Nothing else settles it:
      // the durable record is not a Squad run, so no lifecycle writes its
      // terminal event. Settled even when a stop already moved the durable
      // record: that stop does not write the row either. A group started
      // before it had a row of its own settles the `team` row it had, never
      // one created now.
      const outcome =
        group.phase === "cancelled"
          ? "cancelled"
          : group.phase === "recoveryRequired"
            ? "recovery_required"
            : "completed"
      try {
        if (!(await settleBestOfNExecutionRun(group.teamRunId, outcome, at))) {
          if (await getExecutionRun(agentTeamExecutionRunId(group.teamRunId)))
            await settleAgentTeamExecutionRun(run, outcome, at)
        }
      } catch {
        // The ledger is settled above; a row that could not be written stays
        // as the last event left it.
      }
    },
  }
}
