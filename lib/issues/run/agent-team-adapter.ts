/**
 * `team` assignee → AgentTeam run (`lib/ai/agent/agent-team.ts`).
 *
 * The issue's `team` assignee id is an `AgentTeam` id. The adapter appends one
 * `AgentTeamTask` to the team (with `metadata.issueId` so the team board can
 * badge it "from KEY-1"), then starts the team. `agentTeamManager.start`
 * snapshots the team's task list when it begins, so a team that is already
 * executing / planning / paused cannot take a new task mid-run — the adapter
 * refuses with `team-busy` rather than adding a task nobody will pick up.
 *
 * `startSquadRun` resolves once the run is journalled and its lifecycle is
 * under way (the lifecycle itself is fire-and-forget there), so the adapter
 * awaits it: a refusal throws through to the bridge, which settles the claim
 * as failed. The Squad run id it returns is kept on the issue run
 * (`targetRef.squadRunId`), and `poll` (driven by the store subscription and
 * the `agentTeamRuns` watch in `install.ts`) settles from the task's status
 * and that Squad run's own record. That also covers a reload mid-run.
 *
 * Artifacts come from the durable-v2 tables when the team wrote them (delivery
 * nodes → PR urls; child runs → branch / worktree) — legacy runs simply have
 * none beyond the team workspace link.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import { isTerminalTeamStatus } from "@cognia/agent-orchestration/rules"
import type { AgentTeam, AgentTeamTask, CreateTaskInput } from "@/types/agent/agent-team"
import type { ConversationReference } from "@/types/connectors/event"
import { parseConversationKey } from "@/types/connectors/event"
import type { IssueRun, IssueRunArtifact } from "@/types/issues"
import type { AgentTeamRunRecord } from "@/types/agent/agent-team-runtime"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { SquadPlanApprovalDelegate } from "@/lib/squads/squad/start-squad-run"
import {
  getAgentTeamDeliveryGraph,
  getAgentTeamRun,
  listAgentTeamChildRuns,
  listAgentTeamDeliveryNodes,
  listAgentTeamRuns,
} from "@/lib/db/agent-team-runtime"
import type {
  IssueRunAdapter,
  IssueRunConversation,
  IssueRunDispatch,
  IssueRunOrigin,
  IssueRunPollResult,
  IssueRunStartContext,
  IssueRunTarget,
  IssueRunVerdict,
} from "./types"
import { issuePriorityToSubAgentPriority } from "@/lib/issues/sources/agent-status-map"
import { withRunBrief } from "./types"

export const AGENT_TEAM_RUN_ADAPTER_ID = "agent-team"

/** Team workspace deep link — query param, never `[id]` (static export). */
export function agentTeamWorkspaceHref(teamId: string): string {
  return `/squads?id=${encodeURIComponent(teamId)}`
}

/**
 * Where an agent branch left behind by a run can actually be seen.
 *
 * `AgentBranchesSection` is rendered by `/workspace`'s Environments tab, and
 * `?tab=` is real URL state there. Branches outlive the worktrees they came
 * from and are scoped to the repository rather than to one Squad, which is why
 * this carries no team id.
 */
export const AGENT_BRANCHES_HREF = "/workspace?tab=environments"

/** Team statuses during which the task snapshot is fixed. */
export const BUSY_TEAM_STATUSES: ReadonlySet<AgentTeam["status"]> = new Set([
  "planning",
  "executing",
  "paused",
])

export interface AgentTeamRunAdapterDeps {
  getTeam: (teamId: string) => AgentTeam | undefined
  getTask: (taskId: string) => AgentTeamTask | undefined
  createTask: (input: CreateTaskInput) => AgentTeamTask
  /** Remove a task this adapter added, when the run it was added for never started. */
  deleteTask: (taskId: string) => void
  /**
   * Kick off the run. Resolves once the Squad run is accepted (journalled,
   * lifecycle under way) with its id; throws when the Squad refused.
   *
   * `goal` is the issue, stated as the Squad's objective. The previous
   * `agentTeamManager.start` took none, so the lead planned against whatever
   * objective the Squad had been configured with while the issue arrived as
   * one more task in the list — the run row then had nothing to call itself.
   */
  startTeam: (
    teamId: string,
    origin: IssueRunOrigin,
    goal?: string,
    conversation?: IssueRunConversation
  ) => Promise<{ squadRunId?: string }>
  /**
   * Stop the Squad run serving this issue run: abort it in this window and
   * stop its durable record, so a run parked or recovering elsewhere stops
   * too. Without a `squadRunId` (rows from before it was recorded) only the
   * in-window abort is possible.
   */
  abortTeam: (teamId: string, reason: string, squadRunId?: string) => Promise<void>
  /** The Squad run record an issue run was served by (`targetRef.squadRunId`). */
  getSquadRun: (runId: string) => Promise<AgentTeamRunRecord | undefined>
  /** Durable-v2 artifact readers (best-effort; may return nothing for legacy runs). */
  collectArtifacts: (run: IssueRun) => Promise<IssueRunArtifact[]>
  now: () => number
}

/** What an IM-dispatched run gets that a desktop-dispatched one does not. */
export interface ImSquadRunSurface {
  triggeredFrom: WorkflowTriggeredFrom
  planApprovalDelegate: SquadPlanApprovalDelegate
  /** The thread's bound session, when it has one; the run is carded on it. */
  session?: ChatSession
}

/**
 * What an IM-dispatched run needs so its Squad can ASK instead of failing.
 *
 * `origin: "im"` alone puts the run under the headless gate policy, whose plan
 * gate fails fast on the premise that nobody can answer. A card press in a
 * chat thread has a person on the other end, and the approval machinery they
 * answer through already exists, so this supplies the delegate the chat IM
 * lane builds (`lib/connectors/team-dispatch.ts`) and stamps the thread on
 * `triggeredFrom` so progress and the final result fan back to it. The card
 * is addressed the way the issue card itself is (`lib/issues/im/push.ts`):
 * by conversation key and a platform-level reference, with the bound
 * session's delivery target on top when the thread has one.
 */
export async function resolveImSquadRunSurface(input: {
  teamId: string
  runId: string
  objective: string
  conversation: IssueRunConversation
}): Promise<ImSquadRunSurface> {
  const { adapterId, conversationKey, initiatorUserId } = input.conversation
  const { findSessionByConversationKey } = await import("@/lib/connectors/session-bindings")
  const session = await findSessionByConversationKey(conversationKey)
  const deliveryTarget = session?.platformBinding?.deliveryTarget
  const conversationRef: ConversationReference = session?.platformBinding?.conversationRef ?? {
    platform: parseConversationKey(conversationKey).platform,
    adapterId,
  }
  const planApprovalDelegate: SquadPlanApprovalDelegate = async (request) => {
    const { makeImPlanApprovalDelegate } = await import("@/lib/connectors/hitl/plan-approval")
    return makeImPlanApprovalDelegate({
      runId: input.runId,
      teamId: input.teamId,
      objective: input.objective,
      adapterId,
      conversationKey,
      conversationRef,
      ...(deliveryTarget ? { deliveryTarget } : {}),
      ...(initiatorUserId ? { initiatorUserId } : {}),
    })(request)
  }
  return {
    triggeredFrom: {
      source: "im",
      adapterId,
      conversationKey,
      ...(deliveryTarget ? { deliveryTarget } : {}),
      ...(session ? { sessionId: session.id } : {}),
      ...(initiatorUserId ? { initiator: { remoteUserId: initiatorUserId } } : {}),
    },
    planApprovalDelegate,
    ...(session ? { session } : {}),
  }
}

/**
 * The gate-policy origin and provenance a Squad run gets for an issue-run
 * origin. A wakeup is a scheduler fire: nobody is watching a modal, so the
 * Squad gets the scheduler's headless gate policy and says "schedule".
 */
export function squadRunOriginOf(origin: IssueRunOrigin): {
  origin: string
  triggeredFrom: WorkflowTriggeredFrom
} {
  switch (origin) {
    case "wakeup":
      return { origin: "scheduler", triggeredFrom: { source: "schedule" } }
    case "im":
      return { origin: "im", triggeredFrom: { source: "im" } }
    case "interactive":
      return { origin: "interactive", triggeredFrom: { source: "ui" } }
  }
}

async function defaultGetTeamStore() {
  const { useAgentTeamStore } = await import("@/stores/squads/agent-team-store/store")
  return useAgentTeamStore
}

/**
 * Store + manager access is lazy: `agent-team.ts` drags the whole team runtime
 * chain in, and the tracker must not pay for that at import time (same
 * rationale as `lib/scheduler/executors/team-executor.ts`).
 */
export function createDefaultAgentTeamRunAdapterDeps(): AgentTeamRunAdapterDeps {
  return {
    getTeam: (teamId) => {
      // Synchronous read via the already-loaded store when available; the
      // lazy path below is only for the first touch in a cold module graph.
      const store = loadedStore
      return store ? store.getState().teams[teamId] : undefined
    },
    getTask: (taskId) => loadedStore?.getState().tasks[taskId],
    createTask: (input) => {
      if (!loadedStore) throw new Error("agent team store not loaded")
      return loadedStore.getState().createTask(input)
    },
    startTeam: async (teamId, origin, goal, conversation) => {
      // `startSquadRun` is the one funnel (ADR-0140). Going straight to
      // `agentTeamManager.start` skipped the run-id convention, the
      // `projectId` stamp and the execution row itself, so an issue-dispatched
      // run was invisible in the cockpit unless the Squad was `durable-v2`.
      //
      // An issue is not a conversation, so by default there is no `session`
      // and the run is uncarded — no thread to project progress onto and no
      // control callback to match — which the run row states rather than
      // implies. An IM card press is the exception: it names the thread, so
      // the run is minted up front (the approval delegate closes over its id)
      // and the Squad gets somewhere to ask.
      const { startSquadRun, mintSquadRunId } = await import("@/lib/squads/squad/start-squad-run")
      const objective = goal ?? ""
      const runId = origin === "im" && conversation ? mintSquadRunId() : undefined
      const im =
        runId && conversation
          ? await resolveImSquadRunSurface({ teamId, runId, objective, conversation })
          : undefined
      const result = await startSquadRun({
        squadId: teamId,
        goal: objective,
        ...squadRunOriginOf(origin),
        ...(im?.triggeredFrom ? { triggeredFrom: im.triggeredFrom } : {}),
        ...(runId ? { runId } : {}),
        ...(im ? { planApprovalDelegate: im.planApprovalDelegate } : {}),
        ...(im?.session ? { session: im.session, bindConnectorRun: true } : {}),
      })
      if (!result.started) {
        throw new Error(`squad run refused: ${result.reason ?? "unknown"}`)
      }
      return result.runId ? { squadRunId: result.runId } : {}
    },
    deleteTask: (taskId) => {
      loadedStore?.getState().deleteTask(taskId)
    },
    abortTeam: async (teamId, reason, squadRunId) => {
      const { abortTeam } = await import("@/lib/squads/agent-team-runtime")
      abortTeam(teamId, new Error(reason), squadRunId)
      if (!squadRunId) return
      // The same stop the Squad console sends (`startSquadRun`'s replaced-run
      // path): it reaches a run that is parked or recovering, which the
      // in-window abort above cannot.
      const { controlDurableRun } = await import("@/lib/squads/durable/durable-control")
      await controlDurableRun(squadRunId, "stop")
    },
    getSquadRun: getAgentTeamRun,
    collectArtifacts: collectDurableArtifacts,
    now: Date.now,
  }
}

type AgentTeamStoreApi = Awaited<ReturnType<typeof defaultGetTeamStore>>
let loadedStore: AgentTeamStoreApi | null = null

/** Resolve the lazily-imported store once; `install.ts` awaits this at boot. */
export async function ensureAgentTeamStoreLoaded(): Promise<AgentTeamStoreApi> {
  if (!loadedStore) loadedStore = await defaultGetTeamStore()
  return loadedStore
}

/** Test-only. */
export function __setLoadedAgentTeamStoreForTesting(store: AgentTeamStoreApi | null): void {
  loadedStore = store
}

/**
 * Durable-v2 artifacts for the team run that served this issue run: the
 * newest run record started at/after the issue run, its delivery-node PRs and
 * the child run (branch / worktree) that executed the issue's task.
 */
export async function collectDurableArtifacts(run: IssueRun): Promise<IssueRunArtifact[]> {
  const artifacts: IssueRunArtifact[] = [
    { label: "Team workspace", href: agentTeamWorkspaceHref(run.targetId) },
  ]
  const taskId = run.targetRef?.taskId
  const squadRunId = run.targetRef?.squadRunId
  // The run this issue run started, by id. Rows from before the id was kept
  // fall back to the newest record started at/after the issue run.
  const record = squadRunId
    ? await getAgentTeamRun(squadRunId)
    : (await listAgentTeamRuns(run.targetId))
        .filter((candidate) => candidate.createdAt >= run.startedAt - 1_000)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!record) return artifacts

  const graph = await getAgentTeamDeliveryGraph(record.id)
  if (graph) {
    const nodes = await listAgentTeamDeliveryNodes(graph.id)
    for (const node of nodes) {
      if (node.pullRequestUrl) {
        artifacts.push({
          label: node.pullRequestNumber ? `PR #${node.pullRequestNumber}` : node.title,
          href: node.pullRequestUrl,
        })
      }
    }
  }
  const children = await listAgentTeamChildRuns(record.id)
  for (const child of children) {
    if (taskId && child.taskId !== taskId) continue
    if (child.branch) {
      artifacts.push({
        label: `Branch ${child.branch}`,
        // `/squads?...&tab=worktrees` was a link to nowhere: `SQUAD_TABS` is
        // `squads | runs | board`, so `useSquadRouteState` dropped the value
        // and the console opened on its landing tab. ADR-0140 moved what a
        // finished run leaves behind onto the workspace surface —
        // `AgentBranchesSection` lives in `/workspace`'s Environments tab, and
        // `RunOperationsTab` sends a reader to the same place. That tab IS
        // addressable (`app/workspace/page.tsx` reads `?tab=`), which is what
        // the phone's Source Control screen already links to.
        href: AGENT_BRANCHES_HREF,
      })
    }
    if (child.sessionId) {
      artifacts.push({
        label: `Session (${child.teammateId})`,
        href: `/?session=${encodeURIComponent(child.sessionId)}`,
      })
    }
  }
  return artifacts
}

export function createAgentTeamRunAdapter(
  overrides: Partial<AgentTeamRunAdapterDeps> = {}
): IssueRunAdapter {
  const deps: AgentTeamRunAdapterDeps = { ...createDefaultAgentTeamRunAdapterDeps(), ...overrides }

  async function canRun(target: IssueRunTarget): Promise<IssueRunVerdict> {
    const assignee = target.issue.assignee
    if (!assignee || assignee.kind !== "team" || !assignee.id) {
      return { ok: false, reason: "assignee-kind-mismatch" }
    }
    const team = deps.getTeam(assignee.id)
    if (!team) return { ok: false, reason: "assignee-not-found", detail: assignee.id }
    if (BUSY_TEAM_STATUSES.has(team.status)) {
      return { ok: false, reason: "team-busy", detail: team.status }
    }
    return { ok: true }
  }

  return {
    id: AGENT_TEAM_RUN_ADAPTER_ID,
    kind: "agent-team",
    canRun,
    async start(target: IssueRunTarget, context: IssueRunStartContext): Promise<IssueRunDispatch> {
      const verdict = await canRun(target)
      if (!verdict.ok) throw new Error(`agent-team adapter refused: ${verdict.reason}`)
      const { issue, project } = target
      const teamId = issue.assignee!.id!
      const task = deps.createTask({
        teamId,
        title: `${issue.identifier}: ${issue.title}`,
        description: withRunBrief(
          [
            issue.description ?? issue.title,
            project?.description ? `\n\nProject context: ${project.description}` : "",
          ].join(""),
          context.brief
        ),
        priority: issuePriorityToSubAgentPriority(issue.priority),
        tags: ["issue", issue.identifier],
        metadata: { issueId: issue.id, issueIdentifier: issue.identifier },
      })
      let accepted: { squadRunId?: string }
      try {
        accepted = await deps.startTeam(
          teamId,
          context.origin,
          `${issue.identifier}: ${issue.title}`,
          context.conversation
        )
      } catch (error) {
        // The task was added for this run alone; a Squad that refused must
        // not find it in its list on the next unrelated run.
        deps.deleteTask(task.id)
        throw error
      }
      return {
        targetId: teamId,
        targetRef: {
          taskId: task.id,
          ...(accepted.squadRunId ? { squadRunId: accepted.squadRunId } : {}),
        },
        status: "running",
      }
    },
    async poll(run: IssueRun): Promise<IssueRunPollResult> {
      const taskId = run.targetRef?.taskId
      const task = taskId ? deps.getTask(taskId) : undefined
      if (!task) return { status: "failed", error: "team task no longer exists" }
      switch (task.status) {
        case "completed":
          return {
            status: "succeeded",
            ...(task.result ? { summary: task.result.slice(0, 500) } : {}),
            artifacts: await deps.collectArtifacts(run),
          }
        case "failed":
          return {
            status: "failed",
            error: task.error ?? "team task failed",
            artifacts: await deps.collectArtifacts(run),
          }
        case "cancelled":
          return { status: "cancelled" }
        default:
          return pollUnfinishedTask(run, task)
      }
    },
    async cancel(run: IssueRun): Promise<void> {
      await deps.abortTeam(run.targetId, `issue run ${run.id} cancelled`, run.targetRef?.squadRunId)
    },
  }

  /**
   * The task is not terminal. Whether the run still is depends on the Squad:
   *
   *   - The Squad run is still going (or waiting for a person: `needs_input`,
   *     paused, recovering) → keep the run active. A parked launch is waiting
   *     for someone to resume it from the Squad console, not failed.
   *   - The Squad run ended with the task in `review` → `succeeded`. Review is
   *     the team's "a person has to look" state, exactly what the issue's
   *     `in_review` means; the run did its work. A later `completed` finds the
   *     run already settled and changes nothing.
   *   - The Squad run was cancelled / terminated → `cancelled`.
   *   - It ended any other way with the task never finished → `failed`.
   *
   * Rows from before the Squad run id was kept (`targetRef.squadRunId`) can
   * only read the team's status, as they always did.
   */
  async function pollUnfinishedTask(
    run: IssueRun,
    task: AgentTeamTask
  ): Promise<IssueRunPollResult> {
    const squadRunId = run.targetRef?.squadRunId
    let ended: { status: AgentTeamRunRecord["status"] } | { teamStatus: AgentTeam["status"] }
    if (squadRunId) {
      const record = await deps.getSquadRun(squadRunId)
      if (!record) return { status: "failed", error: "squad run no longer exists" }
      if (!isTerminalTeamStatus(record.status)) return null
      ended = { status: record.status }
    } else {
      const team = deps.getTeam(run.targetId)
      if (!team) return { status: "failed", error: "team no longer exists" }
      if (BUSY_TEAM_STATUSES.has(team.status) || team.status === "idle") return null
      ended = { teamStatus: team.status }
    }
    if (task.status === "review") {
      return {
        status: "succeeded",
        ...(task.result ? { summary: task.result.slice(0, 500) } : {}),
        artifacts: await deps.collectArtifacts(run),
      }
    }
    if ("status" in ended && (ended.status === "cancelled" || ended.status === "terminated")) {
      return { status: "cancelled", reason: `squad run ${ended.status}` }
    }
    const how = "status" in ended ? ended.status : ended.teamStatus
    return {
      status: "failed",
      error: `team run ended (${how}) before the task ran`,
      artifacts: await deps.collectArtifacts(run),
    }
  }
}
