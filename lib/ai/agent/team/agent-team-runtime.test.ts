/**
 * Tests for the F-path synthesizer (ADR-0022, durable-only under ADR-0169).
 * The legacy in-place orchestrator was rewritten to a thin synthesizer that
 * delegates to workflow runtime. Tests below exercise the contract:
 *  - storeReader / storeWriter shape
 *  - plan-approval gate as a durable Squad review (interrupt + receipt)
 *  - terminal status mapping ({completed, failed, cancelled})
 *  - double-start prevention via inflightControllers
 *
 * Every team here carries the two bindings the coordinator requires, and the
 * Registry controller plus the environment setup executor are mocked, so the
 * durable admission path runs for real against the Dexie fixture.
 */

// The Registry workspace controller opens Bundle Turn leases through the
// native task-workspace crate. A fake keeps the durable dispatch path honest
// (leases are opened and settled) without a Registry.
const abortWorkspaceMock = jest.fn(async () => undefined)
jest.mock("@/lib/git/commands", () => ({
  ...jest.requireActual("@/lib/git/commands"),
  gitStackSetParent: jest.fn(async () => undefined),
  gitStackValidate: jest.fn(async () => [
    { branch: "a", parent: "main", head: "sha-a", containsParent: true, checkedOutIn: null },
    { branch: "b", parent: "a", head: "sha-b", containsParent: true, checkedOutIn: null },
  ]),
}))
let outboundSettings: object = { agentPermissions: {} }
jest.mock("@/lib/policy/action-review/plan-context", () => ({
  ...jest.requireActual("@/lib/policy/action-review/plan-context"),
  readAppSettings: () => outboundSettings,
}))
jest.mock("@/lib/integrations/outbound-hold", () => ({
  pushHeldIntegrationJob: jest.fn(async () => undefined),
  withdrawHeldIntegrationJob: jest.fn(),
}))
const executeEnvironmentMock = jest.fn(async () => ({ success: true }))
const getProjectEnvironmentVersionMock = jest.fn()
jest.mock("@/lib/db/project-environments", () => ({
  ...jest.requireActual("@/lib/db/project-environments"),
  getProjectEnvironmentVersion: (...args: unknown[]) => getProjectEnvironmentVersionMock(...args),
}))
const updateRunIfCurrentMock = jest.fn()
const beforeListChildrenMock = jest.fn(async () => undefined)
jest.mock("@/lib/db/agent-team-runtime", () => ({
  ...jest.requireActual("@/lib/db/agent-team-runtime"),
  settleAgentTeamRunIfCurrent: (...args: unknown[]) => updateRunIfCurrentMock(...args),
  listAgentTeamChildRuns: async (...args: unknown[]) => {
    await beforeListChildrenMock()
    return jest.requireActual("@/lib/db/agent-team-runtime").listAgentTeamChildRuns(...args)
  },
}))
jest.mock("./workspace/registry-controller", () => ({
  AgentTeamRegistryWorkspaceController: class FakeController {
    constructor(public readonly options: { roots: unknown[]; deleteBranch?: unknown }) {}
    async openDispatch(input: { taskId: string }) {
      return {
        primaryAlias: `/alias/${input.taskId}`,
        run: { runId: `ws-${input.taskId}` },
        settle: async () => [],
        abort: () => abortWorkspaceMock(),
      }
    }
    getDispatchExecutionRoot() {
      return undefined
    }
    async reconcile() {
      return { mode: "manual" }
    }
  },
}))
jest.mock("@/lib/agent-team/squad-readiness", () => {
  const actual = jest.requireActual("@/lib/agent-team/squad-readiness")
  return { ...actual, evaluateSquadReadiness: jest.fn(actual.evaluateSquadReadiness) }
})
jest.mock("@/lib/project-environment/executor", () => ({
  executeProjectEnvironment: () => executeEnvironmentMock(),
}))
// Mock plugin hooks so we don't need to boot the plugin store.
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: jest.fn(() => ({
    dispatchWorkflowStart: jest.fn(),
    dispatchWorkflowStepComplete: jest.fn(),
    dispatchWorkflowComplete: jest.fn(),
    dispatchWorkflowError: jest.fn(),
    dispatchWorkflowNodeStart: jest.fn(),
    dispatchWorkflowNodeComplete: jest.fn(),
    dispatchWorkflowNodeError: jest.fn(),
  })),
  getPluginLifecycleHooks: jest.fn(() => ({
    dispatchOnTeamStart: jest.fn(),
    dispatchOnTeamPlanReady: jest.fn(),
    dispatchOnTeammateClaim: jest.fn(),
    dispatchOnTeammateRelease: jest.fn(),
    dispatchOnTeamBudgetWarn: jest.fn(),
    dispatchOnTeamComplete: jest.fn(),
    dispatchOnAgentStart: jest.fn(),
    dispatchOnAgentComplete: jest.fn(),
    dispatchOnAgentError: jest.fn(),
    dispatchOnConsensusOpened: jest.fn(),
    dispatchOnConsensusVoted: jest.fn(),
    dispatchOnConsensusResolved: jest.fn(),
    dispatchOnSharedMemoryWrite: jest.fn(),
    dispatchOnSharedMemoryDelete: jest.fn(),
    dispatchOnTeamDelegationStart: jest.fn(),
    dispatchOnTeamDelegationComplete: jest.fn(),
  })),
}))

jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: jest.fn(),
}))
import { executeAgent } from "@/lib/ai/agent/agent-executor"

// Stub the twin runtime so the per-run twin block is observable without the
// vector store / Dexie. Returning no twinDeps keeps every non-twin test's
// behavior identical to before this feature existed.
jest.mock("./teammate/twin-context", () => ({
  resolveTeamTwinRuntime: jest.fn(async () => ({ availableTwins: [] })),
  applyTeammateTwinContext: jest.fn(async (i: { baseSystemPrompt: string }) => ({
    systemPrompt: i.baseSystemPrompt,
    applied: false,
  })),
  searchTwinKnowledge: jest.fn(async () => ({ hits: [], degraded: false })),
  gatherTeamTwins: jest.fn(async () => []),
}))
import { resolveTeamTwinRuntime } from "./teammate/twin-context"
const resolveTeamTwinRuntimeMock = resolveTeamTwinRuntime as jest.Mock

import { getDb } from "@/lib/db/schema"
import { createSquadRunRecords } from "./squad/squad-run-records"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import {
  approveAndPublishGithubStack,
  prepareAndPublishGithubStack,
} from "./delivery/github-delivery-adapter"
import { runSquadLifecycle } from "./squad/squad-lifecycle-runner"
import { controlSquadRun } from "./squad/squad-control"
import { watchSquadRunSettlement } from "./squad/watch-squad-run"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { createDeliveryGraphService } from "./delivery/delivery-graph"
import { STACKED_DELIVERY_DEFAULTS } from "@/lib/stack/team-policy"
import { createIntegrationAccount } from "@/lib/db/integrations"
import { resolveGithubReadToken } from "@/lib/integrations/github-read-credential"
import { GITHUB_DOT_COM } from "@/lib/github/host"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  runTeamLifecycle,
  abortTeam,
  getInflightController,
  parseProposedPlan,
  __resetInflightForTesting,
  type RunTeamLifecycleDeps,
} from "./agent-team-runtime"
import { __setSquadReviewTestHooksForTesting, settleSquadReview } from "./gates/squad-review-gate"
import type { SquadReviewKind } from "@/types/execution/run"
import { getTeamRunContext } from "./team-run-context"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"

type PlanApprovalRequest = Parameters<NonNullable<RunTeamLifecycleDeps["planApprovalDelegate"]>>[0]

const lead: AgentTeammate = {
  id: "lead-1",
  teamId: "team-1",
  name: "Lead",
  description: "lead",
  role: "lead",
  status: "idle",
  config: {},
  completedTaskIds: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  progress: 0,
  createdAt: new Date(),
} as AgentTeammate

const worker = (id: string): AgentTeammate =>
  ({
    id,
    teamId: "team-1",
    name: id,
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
  }) as AgentTeammate

const baseTeam: AgentTeam = {
  id: "team-1",
  projectId: "project-1",
  name: "Test",
  description: "",
  task: "do a thing",
  status: "idle",
  config: {
    maxTeammates: 5,
    maxConcurrentTeammates: 2,
    executionMode: "coordinated",
    displayMode: "expanded",
    repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }],
    environmentRef: { environmentId: "env-1", versionId: "env-1:v1" },
    // The mocked executor writes no diff and runs no tests. The evidence gate
    // is exercised by `durable-dispatch.test.ts`, not here.
    evidencePolicy: {
      requireActivity: false,
      requireOutcome: false,
      requireCodeDiff: false,
      requireVerification: false,
      requireVisualForUi: false,
    },
  },
  leadId: "lead-1",
  teammateIds: ["lead-1", "w1", "w2"],
  taskIds: [],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
} as AgentTeam

const task = (id: string, deps: string[] = []): AgentTeamTask =>
  ({
    id,
    teamId: "team-1",
    title: id,
    description: `desc ${id}`,
    status: "pending",
    priority: "normal",
    dependencies: deps,
    tags: [],
    createdAt: new Date(),
    order: 0,
  }) as AgentTeamTask

const buildDeps = (
  team: AgentTeam,
  tasks: AgentTeamTask[],
  members: AgentTeammate[]
): RunTeamLifecycleDeps & {
  _messages: Array<Record<string, unknown>>
  _taskStatuses: Record<string, string>
} => {
  const messages: Array<Record<string, unknown>> = []
  const taskStatuses: Record<string, string> = {}
  return {
    storeReader: {
      getTeam: (id: string) => (id === team.id ? team : undefined),
      getTeammates: () => members,
      getTeamTasks: () => tasks,
    },
    storeWriter: {
      addMessage: (m) => {
        messages.push(m as unknown as Record<string, unknown>)
      },
      setTaskStatus: (id: string, status: string) => {
        taskStatuses[id] = status
      },
      updateTeammate: () => {},
    },
    runLeadPlanning: jest.fn(async () => ({
      planText: '```json\n{"summary":"x","steps":[]}\n```',
    })),
    notifierDeps: {
      toast: () => {},
      osNotify: async () => {},
      log: async () => {},
    },
    _messages: messages,
    _taskStatuses: taskStatuses,
  }
}

const dbFixture = createDbTestFixture()

/**
 * Answer the newest pending Squad review of `kind`, the way the control plane
 * would, once it exists. Polls because the lifecycle opens the interrupt on
 * its own schedule.
 */
async function answerPendingReview(
  kind: SquadReviewKind,
  outcome: "approve" | "deny",
  extra: Record<string, unknown> = {}
): Promise<void> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const pending = (
      await getDb().executionRunInterrupts.where("status").equals("pending").toArray()
    )
      .filter((row) => row.reviewKind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
    const row = pending[0]
    if (row) {
      const parts = row.id.split(":")
      // action-review:squad-review:<runId>:<kind>:<instance>
      const runId = parts[2]!
      const instance = parts.slice(4).join(":")
      await settleSquadReview({ runId, kind, instance }, { kind, outcome, ...extra } as never, {
        authority: "human",
        actorKind: "local-user",
      })
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`no pending ${kind} review appeared`)
}

async function pendingReviews(kind: SquadReviewKind) {
  return (await getDb().executionRunInterrupts.where("status").equals("pending").toArray()).filter(
    (row) => row.reviewKind === kind
  )
}

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  outboundSettings = { agentPermissions: {} }
  beforeListChildrenMock.mockReset().mockResolvedValue(undefined)
  getProjectEnvironmentVersionMock
    .mockReset()
    .mockImplementation(
      jest.requireActual("@/lib/db/project-environments").getProjectEnvironmentVersion
    )
  updateRunIfCurrentMock
    .mockReset()
    .mockImplementation(
      jest.requireActual("@/lib/db/agent-team-runtime").settleAgentTeamRunIfCurrent
    )
  abortWorkspaceMock.mockReset().mockResolvedValue(undefined)
  executeEnvironmentMock.mockReset().mockResolvedValue({ success: true })
  await dbFixture.restore()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
  await getDb().projectEnvironmentVersions.put({
    id: "env-1:v1",
    environmentId: "env-1",
    projectId: "project-1",
    version: 1,
    name: "dev",
    setupScript: { default: "" },
    actions: [],
    variables: {},
    keyringReferences: [],
    policy: { requiredRuntimeCapabilities: [] },
    createdAt: 1,
  })
  __resetInflightForTesting()
  __setSquadReviewTestHooksForTesting({ pollIntervalMs: 10 })
  ;(executeAgent as jest.Mock).mockReset()
})

afterEach(() => {
  __resetInflightForTesting()
  __setSquadReviewTestHooksForTesting(null)
})

afterAll(dbFixture.dispose)

describe("parseProposedPlan", () => {
  it("parses a fenced ```json block", () => {
    const r = parseProposedPlan('```json\n{"a":1}\n```')
    expect(r).toEqual({ ok: true, plan: { a: 1 } })
  })

  it("returns ok:false for empty input", () => {
    expect(parseProposedPlan("")).toMatchObject({ ok: false, reason: "empty plan text" })
  })

  it("returns ok:false for malformed JSON", () => {
    const r = parseProposedPlan("not json")
    expect(r.ok).toBe(false)
  })
})

describe("runTeamLifecycle (F-path synthesizer)", () => {
  it.each(["success", "failure", "cancel", "cancel-race"] as const)(
    "round 4: real Squad hold, approval/publish %s releases its settlement watcher",
    async (outcome) => {
      const runId = `held-publish-${outcome}`
      const team = {
        ...baseTeam,
        taskIds: ["publish-task"],
        config: {
          ...baseTeam.config,
          workingDir: "/repo",
          githubDeliveryPolicy: STACKED_DELIVERY_DEFAULTS,
        },
      }
      const previousStore = useAgentTeamStore.getState()
      useAgentTeamStore.setState({
        teams: { [team.id]: team },
        teammates: { [lead.id]: lead, w1: worker("w1") },
        tasks: { "publish-task": task("publish-task") },
      })
      let stop: (() => void) | undefined
      try {
        await createSquadRunRecords({
          runId,
          teamId: team.id,
          objective: "Publish",
          origin: "interactive",
          startedAt: Date.now(),
          localAuthorization: LOCAL_PERSON_RUN,
          executionConstraints: {
            version: 1,
            teamConfig: team.config,
            origin: "interactive",
            triggeredFrom: { source: "ui" },
            requirePlanApprovalFloor: false,
          },
        })
        await createDeliveryGraphService({}).create({
          id: `graph-${runId}`,
          runId,
          repositories: [
            {
              repositoryId: "primary",
              baseBranch: "main",
              layers: [
                { id: "layer-a", branch: "a", title: "A" },
                { id: "layer-b", branch: "b", title: "B" },
              ],
            },
          ],
        })
        const account = await createIntegrationAccount("github-delivery", {
          integrationId: "github",
          providerId: "github-pat",
          authSessionId: "pat",
          remoteAccountId: "me",
          label: "PAT",
        })
        const request = jest.fn(async (route: string) => {
          if (outcome === "failure" && route.startsWith("POST"))
            throw new Error("publish unavailable")
          return route.startsWith("GET")
            ? { status: 200, headers: {}, data: [] }
            : {
                status: 201,
                headers: {},
                data: {
                  number: 1,
                  html_url: "https://github.com/acme/repo/pull/1",
                  head: { sha: "sha" },
                },
              }
        })
        const resolveTeamRepo = async () => ({
          fullName: "acme/repo",
          defaultBranch: "main",
          defaultBranchExists: true,
        })
        const resolveOctokit: NonNullable<RunTeamLifecycleDeps["resolvePrObserveOctokit"]> = async (
          repo,
          _host,
          context
        ) => {
          const token = await resolveGithubReadToken(
            repo,
            GITHUB_DOT_COM,
            {
              listAccounts: async () => [account],
              hostForSession: async () => GITHUB_DOT_COM,
              resolveToken: async () => "personal-pat",
            },
            context
          )
          expect(token).toBe("personal-pat")
          return token ? { request } : null
        }
        outboundSettings = {
          agentPermissions: { outboundAuthorizationByCategory: { github: "enforce" } },
        }
        ;(executeAgent as jest.Mock).mockResolvedValue({ channel: "text", text: "done" })
        const deps = buildDeps(team, [task("publish-task")], [lead, worker("w1")])
        await runSquadLifecycle(
          { teamId: team.id, runId },
          {
            runtimeDeps: {
              runLeadPlanning: deps.runLeadPlanning,
              notifierDeps: deps.notifierDeps,
              resolveTeamRepo,
              resolvePrObserveOctokit: resolveOctokit,
            },
          }
        )
        expect(await getDb().agentTeamRuns.get(runId)).toMatchObject({
          status: "needs_input",
          recoveryReason: "delivery_awaiting_approval",
        })
        expect(await getDb().executionRuns.get(`execution:team:${runId}`)).toMatchObject({
          status: "waiting",
        })
        expect(request.mock.calls.filter(([route]) => route.startsWith("POST"))).toHaveLength(0)
        const settled = jest.fn()
        stop = watchSquadRunSettlement({
          executionRunId: `execution:team:${runId}`,
          onSettled: settled,
          subscribeDexie: false,
          pollIntervalMs: 5,
        })
        if (outcome === "cancel") {
          await controlSquadRun(runId, "stop")
        } else if (outcome === "cancel-race") {
          let release!: () => void
          let entered!: () => void
          const blocked = new Promise<void>((resolve) => {
            release = resolve
          })
          const started = new Promise<void>((resolve) => {
            entered = resolve
          })
          beforeListChildrenMock.mockImplementationOnce(async () => {
            entered()
            await blocked
          })
          const stopping = controlSquadRun(runId, "stop")
          await started
          try {
            await approveAndPublishGithubStack(team, runId, { resolveTeamRepo, resolveOctokit })
          } finally {
            release()
          }
          await expect(stopping).resolves.toMatchObject({
            ok: false,
            reason: "already_terminal",
            status: "completed",
          })
        } else {
          const publish = approveAndPublishGithubStack(team, runId, {
            resolveTeamRepo,
            resolveOctokit,
          })
          if (outcome === "failure") await expect(publish).rejects.toThrow("publish unavailable")
          else await expect(publish).resolves.toBe(`graph-${runId}`)
        }
        const status =
          outcome === "success" || outcome === "cancel-race"
            ? "completed"
            : outcome === "cancel"
              ? "cancelled"
              : "failed"
        expect(await getDb().agentTeamRuns.get(runId)).toMatchObject({ status })
        expect(await getDb().executionRuns.get(`execution:team:${runId}`)).toMatchObject({ status })
        const deadline = Date.now() + 1_000
        while (settled.mock.calls.length === 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 5))
        expect(settled).toHaveBeenCalledTimes(1)
        expect(settled).toHaveBeenCalledWith(status)
      } finally {
        stop?.()
        useAgentTeamStore.setState(previousStore, true)
      }
    }
  )
  it.each(["hold", "failure"] as const)(
    "settles the real finally after publication %s without leaking its execution",
    async (mode) => {
      const runId = `publish-${mode}`
      await createSquadRunRecords({
        runId,
        teamId: baseTeam.id,
        objective: "Publish",
        origin: "interactive",
        startedAt: Date.now(),
        localAuthorization: LOCAL_PERSON_RUN,
      })
      ;(executeAgent as jest.Mock).mockResolvedValue({ channel: "text", text: "done" })
      const operation = runTeamLifecycle(baseTeam.id, {
        ...buildDeps(baseTeam, [task("publish-task")], [lead, worker("w1")]),
        runId,
        beforeCompletion: async () => {
          if (mode === "failure") throw new Error("publication failed")
          await getDb().agentTeamRuns.update(runId, {
            status: "needs_input",
            recoveryReason: "delivery_awaiting_approval",
          })
        },
      })
      if (mode === "failure") await expect(operation).rejects.toThrow("publication failed")
      else await operation
      expect(await getDb().executionRuns.get(`execution:team:${runId}`)).toMatchObject({
        status: mode === "hold" ? "waiting" : "failed",
      })
      expect(getInflightController(baseTeam.id)).toBeUndefined()
    }
  )
  it("publishes with PAT in the real finally before terminal settlement", async () => {
    const runId = "run-publish-finally"
    await createSquadRunRecords({
      runId,
      teamId: baseTeam.id,
      objective: "Publish",
      origin: "interactive",
      startedAt: Date.now(),
      localAuthorization: LOCAL_PERSON_RUN,
    })
    // The real finally calls the real publisher and PAT resolver before its
    // terminal writes. Only git/native and provider boundaries are substituted.
    await createDeliveryGraphService({}).create({
      id: "publish-graph",
      runId,
      repositories: [
        {
          repositoryId: "primary",
          baseBranch: "main",
          layers: [
            { id: "publish-a", branch: "a", title: "A" },
            { id: "publish-b", branch: "b", title: "B" },
          ],
        },
      ],
    })
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-pat",
      authSessionId: "pat-session",
      remoteAccountId: "me",
      label: "PAT",
    })
    let pullNumber = 0
    const request = jest.fn(async (route: string) =>
      route.startsWith("GET")
        ? { status: 200, headers: {}, data: [] }
        : {
            status: 201,
            headers: {},
            data: {
              number: ++pullNumber,
              html_url: `https://github.com/acme/repo/pull/${pullNumber}`,
              head: { sha: `sha-${pullNumber}` },
            },
          }
    )
    ;(executeAgent as jest.Mock).mockResolvedValue({ channel: "text", text: "done" })
    const result = await runTeamLifecycle(baseTeam.id, {
      ...buildDeps(baseTeam, [task("publish-task")], [lead, worker("w1")]),
      runId,
      beforeCompletion: async () => {
        expect(await getDb().executionRuns.get(`execution:team:${runId}`)).toMatchObject({
          status: "running",
        })
        await expect(
          prepareAndPublishGithubStack(
            {
              ...baseTeam,
              config: { ...baseTeam.config, githubDeliveryPolicy: STACKED_DELIVERY_DEFAULTS },
            },
            runId,
            {
              resolveTeamRepo: async () => ({
                fullName: "acme/repo",
                defaultBranch: "main",
                defaultBranchExists: true,
              }),
              resolveOctokit: async (repo, _host, context) => {
                const token = await resolveGithubReadToken(
                  repo,
                  GITHUB_DOT_COM,
                  {
                    listAccounts: async () => [account],
                    hostForSession: async () => GITHUB_DOT_COM,
                    resolveToken: async () => "pat",
                  },
                  context
                )
                expect(token).toBe("pat")
                return token ? { request } : null
              },
              recordParent: async () => {},
              validateLayers: async () => [
                {
                  branch: "a",
                  parent: "main",
                  head: "sha-a",
                  containsParent: true,
                  checkedOutIn: null,
                },
                {
                  branch: "b",
                  parent: "a",
                  head: "sha-b",
                  containsParent: true,
                  checkedOutIn: null,
                },
              ],
              planDeps: { settings: () => ({ agentPermissions: {} }) },
            }
          )
        ).resolves.toBe("publish-graph")
      },
    })
    expect(result.status).toBe("completed")
    expect(await getDb().agentTeamRuns.get(runId)).toMatchObject({ status: "completed" })
    expect(pullNumber).toBe(2)
    expect(await getDb().executionRuns.get(`execution:team:${runId}`)).toMatchObject({
      status: "completed",
    })
  })
  it("registers a defensive copy of workflow knowledge authority for all teammate turns", async () => {
    const observed: unknown[] = []
    const knowledgeAccess = {
      entrypoint: "http" as const,
      allowedKnowledgeBaseIds: ["kb"],
      revisionBindings: { kb: ["gen"] },
    }
    ;(executeAgent as jest.Mock).mockImplementation(async () => {
      observed.push(getTeamRunContext("run_team_knowledge")?.knowledgeAccess)
      return { channel: "text", text: "result" }
    })
    const result = await runTeamLifecycle("team-1", {
      ...buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]),
      runId: "run_team_knowledge",
      knowledgeAccess,
    })
    expect(result.status).toBe("completed")
    expect(observed).toContainEqual(knowledgeAccess)
    expect(observed[0]).not.toBe(knowledgeAccess)
  })
  it("fails fast when team not found", async () => {
    const deps = buildDeps(baseTeam, [], [lead, worker("w1")])
    const result = await runTeamLifecycle("missing", deps)
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/not found/)
  })

  it("fails fast when no workers", async () => {
    const deps = buildDeps(baseTeam, [task("t1")], [lead])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/No teammates/)
  })

  it("fails fast when no tasks", async () => {
    const deps = buildDeps(baseTeam, [], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/No tasks/)
  })

  it("happy path: independent tasks complete via workflow", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "result",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    })

    const deps = buildDeps(baseTeam, [task("t1"), task("t2")], [lead, worker("w1"), worker("w2")])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    expect(deps._taskStatuses).toMatchObject({ t1: "completed", t2: "completed" })
  })

  it("threads an IM triggeredFrom onto the team run row for progress fan-out", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = {
      ...buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]),
      runId: "run_team_connector_bound",
      triggeredFrom: {
        source: "im" as const,
        adapterId: "lark:a1",
        conversationKey: "lark:a1:oc_team",
        sessionId: "sess_1",
      },
    }
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    expect(result.runId).toBe("run_team_connector_bound")
    const row = await getDb().workflowRuns.get(result.runId)
    expect(row?.triggeredBy).toEqual({
      source: "im",
      adapterId: "lark:a1",
      conversationKey: "lark:a1:oc_team",
      sessionId: "sess_1",
    })
    // The origin is also mirrored onto the trigger binding for binding-aware nodes.
    expect(row?.triggerBinding).toMatchObject({
      adapterId: "lark:a1",
      conversationKey: "lark:a1:oc_team",
    })
  })

  it("registers the parent IM permission ceiling for teammate dispatch", async () => {
    const observed: unknown[] = []
    ;(executeAgent as jest.Mock).mockImplementation(async () => {
      observed.push(getTeamRunContext("run_team_permission_ceiling")?.parentPermissionCeiling)
      return {
        channel: "text",
        text: "result",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }
    })
    const deps = {
      ...buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]),
      runId: "run_team_permission_ceiling",
      parentPermissionCeiling: {
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      },
    }

    await expect(runTeamLifecycle("team-1", deps)).resolves.toMatchObject({
      status: "completed",
    })
    expect(observed).toContainEqual({
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
    })
  })

  it("abandons the isolated workspace when setup fails after opening its lease", async () => {
    executeEnvironmentMock.mockRejectedValue(new Error("setup failed"))
    const deps = buildDeps(
      { ...baseTeam, config: { ...baseTeam.config, enableTaskRetry: false } },
      [task("t1")],
      [lead, worker("w1")]
    )
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("failed")
    expect(abortWorkspaceMock).toHaveBeenCalled()
    expect(executeAgent).not.toHaveBeenCalled()
  })

  it("registers one Registry workspace controller for writable team repositories", async () => {
    const observed: unknown[] = []
    ;(executeAgent as jest.Mock).mockImplementation(async () => {
      observed.push(getTeamRunContext("run_team_registry")?.workspaceController)
      return {
        channel: "text",
        text: "result",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }
    })
    const registryTeam = {
      ...baseTeam,
      config: {
        ...baseTeam.config,
        workingDir: "/repo",
        workspaceIsolation: { enabled: true, baseRef: "release/1", reconcile: "manual" },
      },
    } as AgentTeam

    await expect(
      runTeamLifecycle("team-1", {
        ...buildDeps(registryTeam, [task("t1")], [lead, worker("w1")]),
        runId: "run_team_registry",
      })
    ).resolves.toMatchObject({ status: "completed" })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toBeDefined()
    // `select` can roll back the branches it made.
    expect((observed[0] as { options: { deleteBranch?: unknown } }).options.deleteBranch).toEqual(
      expect.any(Function)
    )
  })

  it("omits triggeredBy for non-IM (UI/API) runs", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps)
    const row = await getDb().workflowRuns.get(result.runId)
    expect(row?.triggeredBy).toBeUndefined()
  })

  it("dependency chain executes in order", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })

    const deps = buildDeps(baseTeam, [task("a"), task("b", ["a"])], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
  })

  it("returns cancelled when external signal aborts before start", async () => {
    const ac = new AbortController()
    ac.abort()
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps, ac.signal)
    expect(result.status).toBe("cancelled")
  })

  it("runs the adaptive wave path when adaptiveReplan is enabled", async () => {
    // The single mock serves both task dispatches AND the between-wave replan
    // checkpoint: a fenced continue-JSON is non-empty (valid task output) and
    // parses to a valid ReplanDecision (continue → plan unchanged).
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: '```json\n{"action":"continue","reasoning":"steady"}\n```',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const adaptiveTeam = {
      ...baseTeam,
      config: { ...baseTeam.config, adaptiveReplan: { enabled: true } },
    } as AgentTeam
    const deps = buildDeps(
      adaptiveTeam,
      [task("t1"), task("t2", ["t1"])],
      [lead, worker("w1"), worker("w2")]
    )
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    // Both waves executed: t1 then t2 (the dependent task in a later wave).
    expect(deps._taskStatuses).toMatchObject({ t1: "completed", t2: "completed" })
  })

  it("does not reopen an operator-cancelled run when the aborted retry gate resumes", async () => {
    const { getDurableTeamCoordinator } = await import("./durable/durable-runtime")
    const { controlSquadRun } = await import("./squad/squad-control")
    const { findLiveSquadRun } = await import("./squad/squad-run-records")
    const runId = "cancel-during-retry-gate"
    const coordinator = getDurableTeamCoordinator()
    await createSquadRunRecords({
      runId,
      teamId: baseTeam.id,
      objective: baseTeam.task,
      origin: "chat",
      startedAt: Date.now(),
    })
    let entered!: () => void
    let finishExecutor!: () => void
    const executing = new Promise<void>((resolve) => {
      entered = resolve
    })
    ;(executeAgent as jest.Mock).mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((resolve) => {
        finishExecutor = resolve
      })
      return { channel: "text", text: "finished while stopping" }
    })
    const lifecycle = runTeamLifecycle(baseTeam.id, {
      ...buildDeps(baseTeam, [task("cancelled-task")], [lead, worker("w1")]),
      runId,
    })
    await executing
    let gateEntered!: () => void
    let resumeGate!: () => void
    const checking = new Promise<void>((resolve) => {
      gateEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resumeGate = resolve
    })
    const listChildren = coordinator.store.listChildren.bind(coordinator.store)
    // Hold the real recovery assessment after abortTeam has entered the workflow
    // catch. The stop path must be free to commit before that assessment returns.
    const read = jest
      .spyOn(coordinator.store, "listChildren")
      .mockImplementationOnce(async (id) => {
        const children = await listChildren(id)
        gateEntered()
        await gate
        return children
      })
    try {
      const stopping = controlSquadRun(runId, "stop")
      await checking
      finishExecutor()
      const deadline = Date.now() + 4_000
      while (
        (await getDb().agentTeamChildRuns.where("runId").equals(runId).toArray()).some(
          (child) => child.settledEpoch !== child.dispatchEpoch
        )
      ) {
        if (Date.now() > deadline) throw new Error("Executor did not settle during stop")
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      // A stop can initially report unconfirmed while the executor drains.
      if (!(await stopping).ok)
        await expect(controlSquadRun(runId, "stop")).resolves.toMatchObject({ ok: true })
      expect(await getDb().executionRuns.get(`execution:team:${runId}`)).toMatchObject({
        status: "cancelled",
      })
      resumeGate()
      await lifecycle
      expect(await getDb().agentTeamRuns.get(runId)).toMatchObject({
        status: "cancelled",
        stop: { state: "confirmed" },
      })
      expect(await findLiveSquadRun(baseTeam.id)).toBeUndefined()
      await expect(
        createSquadRunRecords({
          runId: "after-cancellation",
          teamId: baseTeam.id,
          objective: "next",
          origin: "chat",
          startedAt: Date.now(),
        })
      ).resolves.toMatchObject({ created: true })
    } finally {
      finishExecutor()
      resumeGate()
      await lifecycle
      read.mockRestore()
    }
  })

  it.each([false, true])(
    "manually recovers a timed-out dispatch through defaultReenter (adaptive=%s)",
    async (adaptive) => {
      const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
      const { getExecutor, registerNodeExecutor } = await import("@/lib/workflow/nodes/registry")
      const { configureAgentTeamRuntime, runSquadLifecycle, __resetAgentTeamRuntimeForTesting } =
        await import("./squad/squad-lifecycle-runner")
      const { ensureTeamRecoveryInterrupt, applyTeamRecoveryDecision } =
        await import("./durable/team-recovery")
      const { getDurableTeamCoordinator } = await import("./durable/durable-runtime")
      const { evaluateSquadReadiness } = await import("@/lib/agent-team/squad-readiness")
      const runId = `recover-dispatch-${adaptive}`
      const team = {
        ...baseTeam,
        taskIds: ["recover-first", "recover-next"],
        config: { ...baseTeam.config, adaptiveReplan: { enabled: adaptive } },
      }
      const tasks = [task("recover-first"), task("recover-next", ["recover-first"])]
      useAgentTeamStore.setState({
        teams: { [team.id]: team },
        teammates: { [lead.id]: lead, w1: worker("w1"), w2: worker("w2") },
        tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
      })
      configureAgentTeamRuntime(buildDeps(team, tasks, [lead, worker("w1"), worker("w2")]))
      await createSquadRunRecords({
        runId,
        teamId: team.id,
        objective: team.task,
        origin: "chat",
        startedAt: Date.now(),
        executionConstraints: {
          version: 1,
          teamConfig: team.config,
          origin: "chat",
          triggeredFrom: { source: "ui" },
          requirePlanApprovalFloor: false,
        },
      })
      const original = getExecutor("action.team.task.dispatch", 1)!
      registerNodeExecutor({ ...original, timeoutMs: 500 })
      let release!: () => void
      let entered!: () => void
      const executing = new Promise<void>((resolve) => {
        entered = resolve
      })
      ;(executeAgent as jest.Mock)
        .mockImplementationOnce(async () => {
          entered()
          return await new Promise((resolve) => {
            // The timed-out wrapper stays unconfirmed until the completion
            // rail actually drains and supplies its terminal text result.
            release = () => resolve({ channel: "text", text: "late drained result" })
          })
        })
        .mockResolvedValue({
          channel: "text",
          text: '```json\n{"action":"continue","reasoning":"steady"}\n```',
        })
      const waitFor = async (check: () => Promise<boolean>) => {
        const deadline = Date.now() + 4_000
        while (!(await check())) {
          if (Date.now() > deadline)
            throw new Error(
              `Recovery did not make progress: ${JSON.stringify({ run: await getDb().agentTeamRuns.get(runId), workflow: await getDb().workflowRuns.get(runId), tasks: useAgentTeamStore.getState().tasks })}`
            )
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      try {
        const first = runSquadLifecycle({ teamId: team.id, runId })
        await Promise.race([
          executing,
          first.then((result) => {
            throw new Error(`Dispatch never started: ${JSON.stringify(result)}`)
          }),
        ])
        await first
        expect(await getDb().agentTeamRuns.get(runId)).toMatchObject({
          status: "needs_input",
          recoveryReason: "stop_unconfirmed",
        })
        expect(await getDb().workflowRuns.get(runId)).toMatchObject({ status: "waiting" })
        const armed = (await ensureTeamRecoveryInterrupt(runId))!
        const interrupt = (await getDb().executionRunInterrupts.get(armed.interruptId))!
        release()
        const coordinator = getDurableTeamCoordinator()
        await waitFor(
          async () => (await coordinator.assessTaskRecovery(runId, tasks[0].id)).eligible
        )
        // Restore the real executor timeout for recovery; no proofs or checkpoints are injected.
        registerNodeExecutor(original)
        // The fixture supplies Registry/environment ports; expose that host to
        // the real readiness gate without changing the mocked provider rail.
        jest.mocked(evaluateSquadReadiness).mockImplementation((input) =>
          jest.requireActual("@/lib/agent-team/squad-readiness").evaluateSquadReadiness(input, {
            hostIsAuthoritative: () => true,
            workspaceControllerAvailable: () => true,
          })
        )
        expect(
          await applyTeamRecoveryDecision(runId, interrupt, "approve", {
            kind: "team_recovery",
            choice: "retry_same_host",
          })
        ).toMatchObject({ applied: true })
        await waitFor(async () => (await getDb().agentTeamRuns.get(runId))?.status === "completed")
        expect(useAgentTeamStore.getState().tasks["recover-next"].status).toBe("completed")
        expect(await getDb().workflowRuns.get(runId)).toMatchObject({ status: "succeeded" })
        expect(await getDb().executionRuns.get(`execution:team:${runId}`)).toMatchObject({
          status: "completed",
        })
      } finally {
        release?.()
        registerNodeExecutor(original)
        // Drain the old executor before the database fixture is restored.
        await waitFor(async () => {
          const children = await getDb().agentTeamChildRuns.where("runId").equals(runId).toArray()
          return children.every((child) => child.settledEpoch === child.dispatchEpoch)
        })
        __resetAgentTeamRuntimeForTesting()
        jest
          .mocked(evaluateSquadReadiness)
          .mockImplementation(
            jest.requireActual("@/lib/agent-team/squad-readiness").evaluateSquadReadiness
          )
        useAgentTeamStore.getState().reset()
      }
    },
    15_000
  )

  it("engages the wave path when only the progress ledger is enabled (no adaptiveReplan)", async () => {
    // Progress is made each wave, so the ledger never reaches its stall judge;
    // the continue-JSON mock serves dispatch + the ledger's wrapped re-plan.
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: '```json\n{"action":"continue","reasoning":"steady"}\n```',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const ledgerTeam = {
      ...baseTeam,
      config: { ...baseTeam.config, progressLedger: { enabled: true } },
    } as AgentTeam
    const deps = buildDeps(
      ledgerTeam,
      [task("t1"), task("t2", ["t1"])],
      [lead, worker("w1"), worker("w2")]
    )
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    expect(deps._taskStatuses).toMatchObject({ t1: "completed", t2: "completed" })
  })

  it("taskFilter skips done tasks and treats them as satisfied dependencies", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    // t1 already completed in a previous run; t2 depends on it. The filter
    // (resume semantics) drops t1 — synthesis must treat the dependency as
    // externally satisfied instead of throwing invalid_dep, and t1 must not
    // be re-dispatched.
    const done = { ...task("t1"), status: "completed" as const, result: "prior result" }
    const deps = buildDeps(baseTeam, [done, task("t2", ["t1"])], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", {
      ...deps,
      taskFilter: (t) => t.status !== "completed",
    })
    expect(result.status).toBe("completed")
    expect(deps._taskStatuses).toMatchObject({ t2: "completed" })
    expect(deps._taskStatuses.t1).toBeUndefined()
  })

  it("prevents double-start of the same team", async () => {
    ;(executeAgent as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                channel: "text",
                text: "ok",
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              }),
            50
          )
        )
    )
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const first = runTeamLifecycle("team-1", deps)
    await expect(runTeamLifecycle("team-1", deps)).rejects.toThrow(/already running/)
    await first
  })

  it("does not abort the current lifecycle for a different run id", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = {
      ...buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]),
      runId: "current-run",
    }
    const active = runTeamLifecycle("team-1", deps)
    expect(abortTeam("team-1", new Error("shutdown"), "previous-run")).toBe(false)
    expect(getInflightController("team-1")?.signal.aborted).toBe(false)
    await expect(active).resolves.toMatchObject({ status: "completed" })
  })

  it("preserves cancellation when durable environment admission fails late", async () => {
    const runId = "cancelled-admission"
    await createSquadRunRecords({
      runId,
      teamId: "team-1",
      objective: "o",
      origin: "interactive",
      startedAt: 1,
    })
    getProjectEnvironmentVersionMock.mockImplementationOnce(async () => {
      await getDb().agentTeamRuns.update(runId, { status: "cancelled" })
      throw new Error("environment lookup failed")
    })
    const result = await runTeamLifecycle("team-1", {
      ...buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]),
      runId,
    })
    expect(result.status).toBe("cancelled")
    expect((await getDb().agentTeamRuns.get(runId))?.status).toBe("cancelled")
    expect((await getDb().executionRuns.get(`execution:team:${runId}`))?.status).toBe("cancelled")
  })

  it("uses the authoritative cancelled status after losing final settlement CAS", async () => {
    const runId = "cancelled-settlement"
    await createSquadRunRecords({
      runId,
      teamId: "team-1",
      objective: "o",
      origin: "interactive",
      startedAt: 1,
    })
    ;(executeAgent as jest.Mock).mockImplementation(async () => {
      updateRunIfCurrentMock.mockImplementationOnce(async () => {
        await getDb().agentTeamRuns.update(runId, { status: "cancelled" })
        return false
      })
      return {
        channel: "text",
        text: "late result",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }
    })
    const result = await runTeamLifecycle("team-1", {
      ...buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]),
      runId,
    })
    expect(result.status).toBe("cancelled")
    expect((await getDb().agentTeamRuns.get(runId))?.status).toBe("cancelled")
    expect((await getDb().executionRuns.get(`execution:team:${runId}`))?.status).toBe("cancelled")
  })

  it("waits for an aborted predecessor's workspace cleanup before starting its replacement", async () => {
    let releaseCleanup!: () => void
    let cleanupStarted!: () => void
    const cleaning = new Promise<void>((resolve) => {
      cleanupStarted = resolve
    })
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    abortWorkspaceMock.mockImplementationOnce(async () => {
      cleanupStarted()
      await cleanup
    })
    executeEnvironmentMock.mockRejectedValueOnce(new Error("setup failed"))
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "replacement result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const team = {
      ...baseTeam,
      config: { ...baseTeam.config, enableTaskRetry: false, maxRetries: 0 },
    }
    const previousDeps = {
      ...buildDeps(team, [task("old-task")], [lead, worker("w1")]),
      runId: "old-run",
    }
    const nextDeps = {
      ...buildDeps(team, [task("next-task")], [lead, worker("w1")]),
      runId: "next-run",
    }
    const readNextTeam = jest.spyOn(nextDeps.storeReader, "getTeam")
    const previous = runTeamLifecycle("team-1", previousDeps)
    await cleaning
    expect(abortTeam("team-1", new Error("shutdown"), "old-run")).toBe(true)
    const replacement = runTeamLifecycle("team-1", nextDeps)
    await Promise.resolve()
    expect(readNextTeam).not.toHaveBeenCalled()
    releaseCleanup()
    await previous
    await expect(replacement).resolves.toMatchObject({ runId: "next-run", status: "completed" })
    expect(readNextTeam).toHaveBeenCalled()
    expect(getInflightController("team-1")).toBeUndefined()
  })
})

describe("runTeamLifecycle — plan-approval gate", () => {
  const teamWithApproval = (revisions = 3): AgentTeam => ({
    ...baseTeam,
    config: { ...baseTeam.config, requirePlanApproval: true, maxPlanRevisions: revisions },
  })

  it("approves on first revision → run completes", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    const runPromise = runTeamLifecycle("team-1", deps)
    await answerPendingReview("plan", "approve")
    const result = await runPromise
    expect(result.status).toBe("completed")
  })

  it("rejects past max revisions → failed, feeding each rejection back as feedback", async () => {
    const deps = buildDeps(teamWithApproval(2), [task("t1")], [lead, worker("w1")])
    const runPromise = runTeamLifecycle("team-1", deps)
    await answerPendingReview("plan", "deny", { feedback: "no good" })
    await answerPendingReview("plan", "deny", { feedback: "still no" })
    const result = await runPromise
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/rejected/)
    const planning = deps.runLeadPlanning as jest.Mock
    expect(planning).toHaveBeenCalledTimes(2)
    expect(planning.mock.calls[1]?.[0]).toMatchObject({ feedback: "no good" })
    // Two revisions, two durable interrupts, both settled, both receipted.
    const rows = await getDb().executionRunInterrupts.toArray()
    expect(rows.map((row) => row.status).sort()).toEqual(["denied", "denied"])
    expect(await getDb().actionReviewReceipts.count()).toBe(2)
  })

  it("publishes the plan to the board lead and opens the plan gate before waiting", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    const updateTeammate = jest.fn()
    deps.storeWriter.updateTeammate = updateTeammate

    const runPromise = runTeamLifecycle("team-1", deps)
    const deadline = Date.now() + 4_000
    while ((await pendingReviews("plan")).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }

    // While the gate is waiting: the lead carries the proposed plan and the
    // awaiting_approval status the coordination panel renders on, and ONE
    // durable interrupt parks the execution run on the plan decision.
    expect(updateTeammate).toHaveBeenCalledWith("lead-1", {
      status: "awaiting_approval",
      proposedPlan: expect.stringContaining("summary"),
    })
    const [interrupt] = await pendingReviews("plan")
    expect(interrupt).toMatchObject({
      type: "plan_approval",
      reviewKind: "plan",
      subject: { revision: 0, maxRevisions: 3 },
    })
    const parked = await getDb().executionRuns.get(interrupt!.runId)
    expect(parked?.status).toBe("waiting")
    expect(parked?.latestSnapshot?.allowedActions).toEqual(
      expect.arrayContaining(["approve", "deny"])
    )

    await answerPendingReview("plan", "approve")
    const result = await runPromise
    expect(result.status).toBe("completed")
    // Decision received → the lead must leave awaiting_approval.
    expect(updateTeammate).toHaveBeenCalledWith("lead-1", { status: "idle" })
  })

  it("resets the lead out of awaiting_approval when the plan is rejected", async () => {
    const deps = buildDeps(teamWithApproval(1), [task("t1")], [lead, worker("w1")])
    const updateTeammate = jest.fn()
    deps.storeWriter.updateTeammate = updateTeammate

    const runPromise = runTeamLifecycle("team-1", deps)
    await answerPendingReview("plan", "deny", { feedback: "no good" })
    const result = await runPromise
    expect(result.status).toBe("failed")
    expect(updateTeammate).toHaveBeenCalledWith("lead-1", { status: "idle" })
  })

  it("fails fast when runLeadPlanning dep is missing", async () => {
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    delete (deps as { runLeadPlanning?: unknown }).runLeadPlanning
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/runLeadPlanning/)
  })

  it("fails the run (not the process) when lead planning throws", async () => {
    // Regression: this await was bare, so a lead that could not resolve a
    // provider — the default state before the provider fix — rejected straight
    // out of runTeamLifecycle instead of returning a failed run the operator
    // can see. Every neighbouring failure in this block returns a result.
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    deps.runLeadPlanning = jest.fn(async () => {
      throw new Error("The team lead has no AI provider to run on: …Settings → Providers…")
    })

    const result = await runTeamLifecycle("team-1", deps)

    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/Settings → Providers/)
  })

  it("headless origin fails fast BEFORE running lead planning (no token burn)", async () => {
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "scheduler" })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/headless \(origin=scheduler\)/)
    // The whole point: planning must never have been invoked.
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })

  it("an IM triggeredFrom implies the headless policy without an explicit origin", async () => {
    const deps = buildDeps(teamWithApproval(), [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", {
      ...deps,
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
    })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/headless \(origin=im\)/)
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })
})

describe("runTeamLifecycle — risk-raised plan approval (ADR-0070)", () => {
  /** A roster that can drive the machine: computer-use → high risk. */
  const riskyWorker = () =>
    ({ ...worker("w1"), config: { tools: ["computer_use"] } }) as AgentTeammate

  it("raises the plan-approval gate for a high-risk roster even with requirePlanApproval=false", async () => {
    expect(baseTeam.config.requirePlanApproval).toBeFalsy()
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])
    const updateTeammate = jest.fn()
    deps.storeWriter.updateTeammate = updateTeammate

    const runPromise = runTeamLifecycle("team-1", deps)
    const deadline = Date.now() + 4_000
    while ((await pendingReviews("plan")).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    // The gate is live: the lead is parked awaiting approval with a plan, and
    // the interrupt names the risk that raised it.
    expect(deps.runLeadPlanning).toHaveBeenCalled()
    expect(updateTeammate).toHaveBeenCalledWith(
      "lead-1",
      expect.objectContaining({ status: "awaiting_approval" })
    )
    expect((await pendingReviews("plan"))[0]?.subject).toMatchObject({
      riskReason: expect.any(String),
    })
    await answerPendingReview("plan", "deny", { feedback: "not today" })
    const result = await runPromise
    expect(result.status).toBe("failed")
  })

  it("names the risk surfaces when the same run is headless", async () => {
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "scheduler" })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/computer-use/)
    expect(result.reason).toMatch(/cannot proceed unattended \(origin=scheduler\)/)
    // Fail-fast means fail BEFORE burning planning tokens.
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })

  it("riskGating=false restores the old unattended behavior", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const optedOut = { ...baseTeam, config: { ...baseTeam.config, riskGating: false } }
    const deps = buildDeps(optedOut, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "scheduler" })
    expect(result.status).toBe("completed")
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })

  it("leaves a low-risk roster completely alone", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    // No plan, no gate, no new friction — the Quick lane is untouched.
    expect(deps.runLeadPlanning).not.toHaveBeenCalled()
  })

  it("does not gate a plain IM-bound run — being connector-bound is not itself a risk", async () => {
    // Regression guard for the `startTeamRunFromIM` production flow: judging a
    // run by its origin (rather than by what its roster can reach) would make
    // every headless IM-bound team run fail-fast. See ADR-0070 §Rejected.
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
    })
    expect(result.status).toBe("completed")
  })

  it("DOES gate an IM-bound run whose roster can drive the machine", async () => {
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
    })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/computer-use/)
  })

  it("still explains an operator-set gate by the operator's choice, not by risk", async () => {
    const operatorGated = {
      ...baseTeam,
      config: { ...baseTeam.config, requirePlanApproval: true },
    }
    const deps = buildDeps(operatorGated, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "scheduler" })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/requirePlanApproval is enabled/)
  })
})

describe("runTeamLifecycle — an attended headless run asks instead of failing", () => {
  /** Same roster the risk suite uses: computer-use → high risk. */
  const riskyWorker = () =>
    ({ ...worker("w1"), config: { tools: ["computer_use"] } }) as AgentTeammate

  it("asks through the run's own surface when the caller supplies a channel", async () => {
    // `origin: "im"` alone put this under the headless policy, whose plan gate
    // fails fast on the premise that there is no human. A chat thread with a
    // person in it and a working approval channel makes that premise false.
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const planApprovalDelegate = jest.fn(async (_request: PlanApprovalRequest) => ({
      outcome: "approve" as const,
    }))
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])

    const result = await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
      planApprovalDelegate,
    })

    expect(planApprovalDelegate).toHaveBeenCalledWith(
      expect.objectContaining({ planText: expect.any(String), revision: 0 })
    )
    expect(result.status).toBe("completed")
  })

  it("names the risk to the person being asked, since risk is what raised the gate", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const planApprovalDelegate = jest.fn(async (_request: PlanApprovalRequest) => ({
      outcome: "approve" as const,
    }))
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])

    await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
      planApprovalDelegate,
    })

    expect(planApprovalDelegate.mock.calls[0]?.[0]).toMatchObject({
      riskReason: expect.stringContaining("computer-use"),
    })
  })

  it("feeds a rejection back into the lead's re-planning loop", async () => {
    const planApprovalDelegate = jest.fn(async (_request: PlanApprovalRequest) => ({
      outcome: "reject" as const,
      feedback: "split it up",
    }))
    const deps = buildDeps(
      { ...baseTeam, config: { ...baseTeam.config, maxPlanRevisions: 2 } },
      [task("t1")],
      [lead, riskyWorker()]
    )
    const runLeadPlanning = jest.fn(deps.runLeadPlanning!)
    deps.runLeadPlanning = runLeadPlanning

    const result = await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
      planApprovalDelegate,
    })

    expect(runLeadPlanning).toHaveBeenCalledTimes(2)
    expect(runLeadPlanning.mock.calls[1]?.[0]).toMatchObject({ feedback: "split it up" })
    expect(result.status).toBe("failed")
  })

  it("still fails fast when the caller has no channel to ask through", async () => {
    // The default is no channel, so every existing caller keeps today's
    // behaviour byte for byte — claiming a channel one cannot service would
    // turn a loud failure into a silent hang.
    const deps = buildDeps(baseTeam, [task("t1")], [lead, riskyWorker()])
    const result = await runTeamLifecycle("team-1", { ...deps, origin: "im" })
    expect(result.status).toBe("failed")
  })

  it("lets the operator's autonomy raise the gate on a run risk would not have gated", async () => {
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const planApprovalDelegate = jest.fn(async (_request: PlanApprovalRequest) => ({
      outcome: "approve" as const,
    }))
    const deps = buildDeps(baseTeam, [task("t1")], [lead, worker("w1")])

    await runTeamLifecycle("team-1", {
      ...deps,
      origin: "im",
      triggeredFrom: { source: "im", adapterId: "a1", conversationKey: "c1" },
      requirePlanApprovalFloor: true,
      planApprovalDelegate,
    })

    expect(planApprovalDelegate).toHaveBeenCalled()
    // Not risk — so the card must not blame the roster for the operator's choice.
    expect(planApprovalDelegate.mock.calls[0]?.[0]).not.toHaveProperty("riskReason")
  })
})

describe("runTeamLifecycle — ultracode orchestration", () => {
  const fence = (json: unknown) => "```json\n" + JSON.stringify(json) + "\n```"

  // Route the (text-only, off-desktop) teammate dispatches by prompt content:
  // planner → plan, sweep finder → findings, synthesize → report.
  const wireUltracodeMock = () => {
    ;(executeAgent as jest.Mock).mockImplementation(async (prompt: string) => {
      if (prompt.includes("lead planner")) {
        return {
          channel: "text",
          text: fence({
            summary: "sweep then synthesize",
            stages: [
              { pattern: "multi-modal-sweep", instruction: "find bugs", variants: ["by-file"] },
              { pattern: "synthesize", instruction: "write report" },
            ],
          }),
        }
      }
      if (prompt.includes("Search approach")) {
        return {
          channel: "text",
          text: fence({ findings: [{ title: "Bug", detail: "d", location: "a.ts:1" }] }),
        }
      }
      if (prompt.includes("Write the final report")) {
        return { channel: "text", text: fence({ report: "Final report.", citations: ["a.ts:1"] }) }
      }
      return { channel: "text", text: "{}" }
    })
  }

  const ultracodeTeam = (): AgentTeam =>
    ({
      ...baseTeam,
      task: "Audit the payments module",
      config: {
        ...baseTeam.config,
        ultracode: { enabled: true, autoMode: "always" },
      },
    }) as AgentTeam

  it("does not publish cancellation while a pattern.synthesize remote child lacks stop proof", async () => {
    wireUltracodeMock()
    const ordinary = (executeAgent as jest.Mock).getMockImplementation()!
    const runId = "unconfirmed-synthesis"
    let release!: () => void
    let entered!: () => void
    const executing = new Promise<void>((resolve) => {
      entered = resolve
    })
    ;(executeAgent as jest.Mock).mockImplementation(async (prompt: string, ...args: unknown[]) => {
      if (!prompt.includes("Write the final report")) return ordinary(prompt, ...args)
      const { claimAgentTeamDispatchLease } = await import("@/lib/db/agent-team-runtime")
      const children = await getDb().agentTeamChildRuns.where("runId").equals(runId).toArray()
      const child = children.find((child) => child.taskId.endsWith(":synthesize"))!
      expect(child).toBeDefined()
      await claimAgentTeamDispatchLease({
        childRunId: child.id,
        leaseId: "synthesis-remote-lease",
        hostRef: "remote-host",
        now: Date.now(),
      })
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { channel: "text", text: fence({ report: "late remote result", citations: [] }) }
    })
    const controller = new AbortController()
    const lifecycle = runTeamLifecycle(
      "team-1",
      { ...buildDeps(ultracodeTeam(), [], [lead, worker("w1"), worker("w2")]), runId },
      controller.signal
    )
    await executing
    controller.abort(new Error("shutdown"))
    await lifecycle
    expect(await getDb().agentTeamRuns.get(runId)).toMatchObject({
      status: "needs_input",
      recoveryReason: "stop_unconfirmed",
    })
    expect((await getDb().agentTeamRuns.get(runId))?.completedAt).toBeUndefined()
    const events = await getDb()
      .executionRunEvents.where("runId")
      .equals(`execution:team:${runId}`)
      .toArray()
    expect(events.some((event) => event.type === "run.cancelled")).toBe(false)
    expect(events.some((event) => event.type === "run.waiting")).toBe(true)
    release()
    // Drain the still-live executor before this fixture's database is reset.
    const { isStoredChildStopped } = await import("@cognia/agent-orchestration/coordinator")
    const { dexieTeamRunStore } = await import("@/lib/db/agent-team-runtime")
    for (let count = 0; count < 100; count++) {
      const localProbe = {
        ...(await getDb().agentTeamChildRuns.where("runId").equals(runId).last())!,
        remoteDispatchEpoch: undefined,
        remoteSessionId: undefined,
        dispatchLeaseId: undefined,
        leaseTtlMs: undefined,
      }
      if (await isStoredChildStopped(dexieTeamRunStore, localProbe, Date.now())) break
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  })

  it("plans, fans out patterns, and writes the synthesized report to finalResult", async () => {
    wireUltracodeMock()
    // No tasks seeded — ultracode runs off the objective string.
    const deps = buildDeps(ultracodeTeam(), [], [lead, worker("w1"), worker("w2")])
    let finalResult: string | undefined
    deps.storeWriter.setFinalResult = (_teamId, result) => {
      finalResult = result
    }

    const result = await runTeamLifecycle("team-1", deps, undefined)

    expect(result.status).toBe("completed")
    expect(finalResult).toBe("Final report.")
    // The synthesize node posted the report into the team chat.
    expect(deps._messages.some((m) => m.content === "Final report.")).toBe(true)
    // Planner + sweep finder + synthesize all dispatched through executeAgent.
    expect((executeAgent as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it("warns that a merge-all ultracode run is not integrated automatically", async () => {
    wireUltracodeMock()
    const team = ultracodeTeam()
    const isolated = {
      ...team,
      config: {
        ...team.config,
        workingDir: "/repo",
        workspaceIsolation: { enabled: true, reconcile: "merge-all" },
      },
    } as AgentTeam
    const deps = buildDeps(isolated, [], [lead, worker("w1"), worker("w2")])
    const toast = jest.fn()
    deps.notifierDeps = { ...deps.notifierDeps, toast }

    await runTeamLifecycle("team-1", deps, undefined)

    expect(toast).toHaveBeenCalledWith(
      "Workspace promotion requires review",
      expect.objectContaining({ description: expect.stringMatching(/Ultracode runs/) })
    )
  })

  it("honours ultracodeOverride='off' to force the flat task DAG", async () => {
    wireUltracodeMock()
    // With override off and no tasks, the flat path fails fast — proving the
    // ultracode branch was not taken.
    const deps = buildDeps(ultracodeTeam(), [], [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", { ...deps, ultracodeOverride: "off" })
    expect(result.status).toBe("failed")
    expect(result.reason).toMatch(/No tasks/)
  })
})

describe("runTeamLifecycle — Employee Digital Twin runtime gating", () => {
  beforeEach(() => {
    resolveTeamTwinRuntimeMock.mockClear()
    ;(executeAgent as jest.Mock).mockResolvedValue({
      channel: "text",
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
  })

  it("builds twin deps (no recruit list) when a worker is twin-bound", async () => {
    const twinWorker = worker("w1")
    twinWorker.config = { twinId: "tw1" }
    await runTeamLifecycle("team-1", buildDeps(baseTeam, [task("t1")], [lead, twinWorker]))
    expect(resolveTeamTwinRuntimeMock).toHaveBeenCalledWith({
      buildDeps: true,
      listAvailable: false,
    })
  })

  it("builds deps + lists recruitable twins when knowledgeTwinIds + adaptiveReplan are set", async () => {
    const team = {
      ...baseTeam,
      config: {
        ...baseTeam.config,
        knowledgeTwinIds: ["tw1"],
        adaptiveReplan: { enabled: true },
      },
    } as AgentTeam
    await runTeamLifecycle("team-1", buildDeps(team, [task("t1")], [lead, worker("w1")]))
    expect(resolveTeamTwinRuntimeMock).toHaveBeenCalledWith({
      buildDeps: true,
      listAvailable: true,
    })
  })

  it("skips twin deps entirely for a plain team", async () => {
    await runTeamLifecycle("team-1", buildDeps(baseTeam, [task("t1")], [lead, worker("w1")]))
    expect(resolveTeamTwinRuntimeMock).toHaveBeenCalledWith({
      buildDeps: false,
      listAvailable: false,
    })
  })
})
