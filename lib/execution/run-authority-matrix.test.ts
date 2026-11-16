/** @jest-environment jsdom */
/**
 * Cross-family authority regression: real Host rows, option builders and launch
 * code. Model transports are replaced; the no-cap control alone bypasses the
 * final authority overlay, while authority cases execute the production gate.
 * A separate file is needed to keep these integration fixtures out of the
 * option-composition suites, which deliberately replace Host storage.
 */
import "fake-indexeddb/auto"

jest.mock("@/lib/db/project-scope", () => {
  const actual = jest.requireActual("@/lib/db/project-scope")
  return { ...actual, resolveScopeProjectId: jest.fn(actual.resolveScopeProjectId) }
})
jest.mock("./personal-visibility", () => {
  const actual = jest.requireActual("./personal-visibility")
  return { ...actual, preparePersonalDerivedHistory: jest.fn(actual.preparePersonalDerivedHistory) }
})
jest.mock("@/lib/mcp/oauth-tauri", () => ({
  ...jest.requireActual("@/lib/mcp/oauth-tauri"),
  mcpOAuthStatus: jest.fn(async () => ({ hasTokens: true })),
  mcpOAuthLoadEntry: jest.fn(async () => ({ accessToken: "r12-fixture-token" })),
}))
import { preparePersonalDerivedHistory } from "./personal-visibility"

let mockBypassAuthority = false
jest.mock("@/lib/execution/run-authority", () => {
  const actual = jest.requireActual("@/lib/execution/run-authority")
  return {
    ...actual,
    enforceRunAuthorityOnSendOptions: jest.fn((...args: unknown[]) =>
      mockBypassAuthority ? Promise.resolve() : actual.enforceRunAuthorityOnSendOptions(...args)
    ),
  }
})

jest.mock("@/lib/claude/run-and-capture", () => ({
  ...jest.requireActual("@/lib/claude/run-and-capture"),
  runAndCaptureAssistantReply: jest.fn(
    async (
      sessionId: string,
      _prompt: unknown,
      _options: unknown,
      cap?: {
        beforeSend?: () => Promise<void>
        onExecutorAccepted?: (sessionId: string) => void
        onExecutorStarted?: (stopped: Promise<void>) => void
      }
    ) => {
      await cap?.beforeSend?.()
      cap?.onExecutorAccepted?.(sessionId)
      cap?.onExecutorStarted?.(Promise.resolve())
      return { text: "done", resultSubtype: "success" }
    }
  ),
}))

import { getDb, whenSeeded } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { LOCAL_PERSON_RUN, recordedRunMetadata, startToolExecutionRun } from "./acting-authority"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import {
  ensureDirectChatExecutionRun,
  startDirectChatExecutionRun,
  finishDirectChatExecutionRun,
} from "./direct-chat-run"
import { runAgentTurn } from "@/lib/workflow/nodes/actions/agent-turn"
import { executeAiEnsemble } from "@/lib/workflow/nodes/ai/ai-ensemble"
import { createSquadRunRecords } from "@/lib/squads/squad/squad-run-records"
import { encodeRemoteWorkerPolicy } from "@/lib/squads/workers/remote-worker-policy"
import { enforceExternalRunAuthority } from "@/lib/ai/agent/external/policy/run-authority"
import { createCreatorTurnRunner } from "@/lib/creator/agent-turn-runner"
import { startDispatchRun } from "@/lib/ai/agent/execution/delegation/dispatch-run"
import { acceptDelegation } from "./delegation"
import { runPluginAgentTurn } from "@/lib/plugin/api/agent-turn"
import { runPluginAgent, runPluginAgentStreamed } from "@/lib/plugin/agent-sdk/run"
import { withPluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
import { createAgentTurnBotExecutor } from "@/lib/bot/runtime/executors/agent-turn"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { executeChatTask } from "@/lib/scheduler/executors"
import { runGoalLoopHeadless } from "@/lib/scheduler/executors/goal-headless-runner"
import { beginRemotePersonalRun } from "@/lib/ai/agent/external/runtimes/remote/remote-run-service"
import { bindPersonalEgressOptions } from "./personal-egress"
import { getExternalAgentManager, ExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { installPersonAgents, getPersonAgentRunner } from "@/lib/headless/person-agent"
import { hostStateRunId } from "@/lib/work-submission/host-adapter"
import type { PersonAgentManager } from "@/lib/headless/person-agent/runner"
import { createBestOfNExecution } from "@/lib/best-of-n/runtime"
import { candidateGrant } from "@/lib/best-of-n/core"
import type { BestOfNGroup } from "@/types/best-of-n"
import { DEFAULT_AUTO_ROUTING } from "@cognia/provider-types/auto-router"
import { dispatchTeammate } from "@/lib/squads/teammate/dispatch-teammate"
import { createTeammatePool } from "@/lib/squads/teammate/teammate-pool"
import { createBudgetGuard } from "@/lib/squads/gates/budget-guard"
import { createTeamNotifier } from "@/lib/squads/team-notifier"
import { createConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import { createModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"
import type { TeamRunContext } from "@/lib/squads/team-run-context"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import { resolveRunAuthority } from "./run-authority"
import type { SendOptions, Character, ChatSession, AppSettings } from "@cognia/agent-config-types"
import type { ExecutionRun, RunAuthorityV1 } from "@/types/execution/run"
import type { StepExecutionContext, VisualWorkflow, WorkflowRunRow } from "@/types/workflow/visual"
import { setTransport, transport as originalTransport } from "@/lib/tauri/transport-instance"
import { __resetSessionExecutionRoutesForTests } from "@/lib/ai/agent/execution/execution-route"

const transportBeforeMatrix = originalTransport
const modelSends: Array<{ sessionId: string; options: SendOptions }> = []
const externalModelSends: import("@/lib/ai/agent/external/policy/permission-ceiling").PermissionBoundExternalExecutionOptions[] =
  []
const persistedAtSend: ExecutionRun[] = []
let workspaceFixture = false
let invarianceComparison = false
async function capturePersisted(options: SendOptions, sessionId: string) {
  const rows = await getDb().executionRuns.toArray()
  const run =
    rows.find((row) => row.id === options.execution?.identity.runId) ??
    rows.find(
      (row) =>
        row.sessionId === sessionId &&
        row.authority &&
        JSON.stringify(row.authority) === JSON.stringify(options.runAuthority)
    )
  if (run) persistedAtSend.push(run)
}

const narrow: RunAuthorityV1 = {
  schemaVersion: 1,
  caps: "explicit-v1",
  permissionMode: "default",
  tools: { allow: ["A"], deny: ["X"] },
  mcpServers: { only: ["m1"] },
  skills: { only: ["s1"] },
  subagents: { only: ["g1"] },
  maxTurns: 3,
  permissionProfile: { workspace: "deny", outbound: "deny" },
}
const wide: RunAuthorityV1 = {
  schemaVersion: 1,
  permissionMode: "bypassPermissions",
  tools: { allow: ["A", "B"], deny: [] },
  mcpServers: { only: ["m1", "m2"] },
  skills: { only: ["s1", "s2"] },
  subagents: { only: ["g1", "g2"] },
  maxTurns: 10,
  permissionProfile: { workspace: "sandbox", outbound: "ask" },
}
const character = {
  id: "matrix-character",
  name: "Matrix",
  avatarColor: "blue",
  createdAt: 1,
  updatedAt: 1,
  systemPrompt: "Perform the requested task.",
  permissionMode: "bypassPermissions",
  allowedTools: ["A", "B"],
  skillIds: ["s1", "s2"],
  mcpServerIds: ["m1", "m2"],
  maxTurns: 10,
} as Character
const session = {
  id: "matrix-session",
  title: "Matrix",
  kind: "direct",
  createdAt: 1,
  updatedAt: 1,
} as ChatSession

async function seedParent(id = "matrix-parent") {
  const parent: ExecutionRun = {
    id,
    kind: "agent-turn",
    sourceId: id,
    sessionId: session.id,
    title: "Matrix parent",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
    ...recordedRunMetadata("local", { runId: id }),
    ...(invarianceComparison ? {} : { authority: narrow }),
  }
  await getDb().executionRuns.put(parent)
  return parent
}
async function child(parentRunId = "matrix-parent") {
  return startToolExecutionRun(session.id, { parentRunId, authority: wide })
}
async function build(runId: string, runSession = session) {
  return resolveSendOptions({
    session: runSession,
    character,
    appSettings: await (await import("@/lib/db/settings")).getSettings(),
    executionIdentity: { runId },
    preloadedEnv: {},
    preloadedMcpServers: [],
  })
}
function workflowContext(): StepExecutionContext {
  return {
    runId: "matrix-workflow",
    workflowId: "wf-matrix",
    stepId: "agent",
    params: {
      prompt: "Perform the task.",
      allowedTools: ["A", "B"],
      maxTurns: 10,
      characterId: character.id,
    },
    upstream: {},
    trigger: { workflowId: "wf-matrix", kind: "trigger.manual", payload: {}, originAt: 0 },
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: async () => undefined,
  }
}
async function workflowParent() {
  const parent = await seedParent("execution:workflow:matrix-workflow")
  const projectId = await (await import("@/lib/db/project-scope")).resolveScopeProjectId()
  await getDb().executionRuns.update(parent.id, {
    kind: "workflow",
    sourceId: "matrix-workflow",
    sessionId: undefined,
    projectId,
  })
  await getDb().workflowRuns.put({
    id: "matrix-workflow",
    workflowId: "wf-matrix",
    projectId,
    status: "running",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1,
    workflowSnapshot: workflow(),
  } as WorkflowRunRow)
  return parent
}
function workflow(): VisualWorkflow {
  return {
    id: "wf-matrix",
    name: "Matrix",
    schemaVersion: 2,
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "agent",
        type: "action.agent.turn",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Agent", params: workflowContext().params },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 30000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}
async function assertOptions(options: SendOptions, runId?: string) {
  if (invarianceComparison) return
  expect(options.permissionMode).toMatch(/^(default|plan)$/)
  expect(options.allowedTools?.every((tool) => narrow.tools!.allow!.includes(tool))).toBe(true)
  expect(options.disallowedTools).toEqual(expect.arrayContaining(["X"]))
  expect(Object.keys(options.mcpServers ?? {}).every((id) => id === "m1")).toBe(true)
  expect(Object.keys(options.agents ?? {}).every((id) => id === "g1")).toBe(true)
  expect(options.maxTurns).toBeLessThanOrEqual(3)
  expect(options.permissionProfile).toMatchObject(narrow.permissionProfile!)
  expect(options.runAuthority?.skills?.only?.every((id) => id === "s1")).toBe(true)
  if (runId)
    expect((await getDb().executionRuns.get(runId))?.authority).toEqual(options.runAuthority)
}
async function assertTransport() {
  if (invarianceComparison) return
  const calls = [
    ...jest.mocked(runAndCaptureAssistantReply).mock.calls,
    ...modelSends.map((send) => [send.sessionId, "task", send.options] as const),
  ]
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) {
    const options = call[2]!
    const run =
      persistedAtSend.find((row) => row.id === options.execution?.identity.runId) ??
      persistedAtSend.find(
        (row) =>
          row.sessionId === call[0] &&
          JSON.stringify(row.authority) === JSON.stringify(options.runAuthority)
      )
    expect(run).toBeDefined()
    expect(run!.authority).toEqual(options.runAuthority)
    expect(run!.parentRunId).toBeDefined()
    await assertOptions(options)
  }
}
async function refuseExternal(
  protocol: "codex-app-server" | "acp",
  context: NonNullable<Parameters<typeof enforceExternalRunAuthority>[0]>
) {
  const manager = getExternalAgentManager({ healthCheckInterval: 0 })
  const agentId = `matrix-${protocol}`
  await manager.addAgent(
    {
      id: agentId,
      name: "Matrix",
      protocol,
      transport: "stdio",
      enabled: true,
      process: { command: protocol === "acp" ? "claude-code-acp" : "codex", args: [] },
    },
    { connect: false }
  )
  try {
    await expect(
      manager.execute(
        agentId,
        "Perform the task.",
        bindPersonalEgressOptions(
          { permissionMode: "bypassPermissions" as const, maxSteps: 10 },
          context
        )
      )
    ).rejects.toMatchObject({
      name: "RunAuthorityError",
      reason: "unsupported_authority",
      message: expect.stringContaining("tools.native"),
    })
  } finally {
    await manager.removeAgent(agentId)
  }
}
async function teamContext(
  runtime: AgentTeammate["config"]["runtime"] = "claude"
): Promise<TeamRunContext> {
  const teammate = {
    id: "matrix-member",
    teamId: "matrix-team",
    name: "Matrix member",
    description: "Matrix worker",
    role: "teammate",
    status: "idle",
    config: { runtime, tools: ["A", "B"], maxSteps: 10 },
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
  } as AgentTeammate
  const team = {
    id: "matrix-team",
    name: "Matrix",
    description: "Matrix team",
    task: "Perform the task.",
    status: "executing",
    leadId: teammate.id,
    teammateIds: [teammate.id],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(),
    config: {
      maxTeammates: 1,
      maxConcurrentTeammates: 1,
      executionMode: "coordinated",
      displayMode: "expanded",
      tools: ["A", "B"],
      defaultMaxSteps: 10,
      evidencePolicy: {
        requireOutcome: false,
        requireActivity: false,
        requireCodeDiff: false,
        requireVerification: false,
        requireVisualForUi: false,
      },
    },
  } as AgentTeam
  await createSquadRunRecords({
    runId: "matrix-team-run",
    teamId: team.id,
    objective: team.task!,
    origin: "delegation",
    startedAt: Date.now(),
    launchedByRunId: "matrix-parent",
    sessionId: session.id,
  })
  const notifier = createTeamNotifier({ runId: "matrix-team-run", teamId: team.id })
  const { useAgentTeamStore } = await import("@/stores/squads/agent-team-store")
  const store = useAgentTeamStore.getState()
  return {
    runId: "matrix-team-run",
    teamId: team.id,
    team,
    pool: createTeammatePool({ teammates: [teammate] }),
    budget: createBudgetGuard({
      runId: "matrix-team-run",
      limit: 0,
      onCritical: "notify",
      notifier,
    }),
    notifier,
    concurrency: createConcurrencyController(1),
    modelPref: createModelPreferenceController(),
    storeWriter: {
      addMessage: store.addMessage,
      setTaskStatus: store.setTaskStatus,
      updateTeammate: store.updateTeammate,
    },
    resolvedCapabilities: new Map(),
    externalAgentInstances: new Map(),
  } as TeamRunContext
}

async function withAcpProcessBoundary(
  id: string,
  run: (manager: ReturnType<typeof getExternalAgentManager>, agentId: string) => Promise<void>
) {
  const { protocolAdapterRegistry } = await import("@/lib/ai/agent/external/protocol-adapter")
  const manager = getExternalAgentManager({ healthCheckInterval: 0 })
  manager.setLaunchPreparer(async (config) => config)
  const nativeSession = {
    id: "invariant-native-session",
    agentId: id,
    status: "active",
    messages: [],
    permissionMode: "default",
    createdAt: new Date(),
    lastActivityAt: new Date(),
  } as import("@/types/agent/external-agent").ExternalAgentSession
  const adapter = {
    protocol: "acp",
    capabilities: { permissionModes: ["default", "plan", "acceptEdits"] },
    tools: [],
    isConnected: () => true,
    connect: async () => undefined,
    createSession: async () => nativeSession,
    getSession: () => nativeSession,
    getSessions: () => [nativeSession],
    closeSession: async () => undefined,
    setSessionMode: async (_id: string, mode: typeof nativeSession.permissionMode) => {
      nativeSession.permissionMode = mode
    },
    disconnect: async () => undefined,
    // This in-memory process boundary owns no native processes.
    confirmSessionProcessesStopped: async () => true,
    execute: async (
      _sessionId: string,
      _message: unknown,
      options: import("@/types/agent/external-agent").ExternalAgentExecutionOptions
    ) => {
      externalModelSends.push(options)
      options.onEvent?.({
        type: "done",
        timestamp: new Date(),
        sessionId: nativeSession.id,
        success: true,
      })
      return {
        success: true,
        sessionId: nativeSession.id,
        finalResponse: "done",
        messages: [],
        toolCalls: [],
        steps: [],
        duration: 1,
      }
    },
  } as unknown as import("@cognia/agent-contracts/adapter").ProtocolAdapter
  const create = protocolAdapterRegistry.create.bind(protocolAdapterRegistry)
  const factory = jest
    .spyOn(protocolAdapterRegistry, "create")
    .mockImplementation((protocol) => (protocol === "acp" ? adapter : create(protocol)))
  try {
    await manager.addAgent(
      { id, name: "Matrix", protocol: "acp", transport: "http", enabled: true },
      { connect: false }
    )
    await manager.connect(id)
    await run(manager, id)
  } finally {
    await manager.removeAgent(id)
    factory.mockRestore()
  }
}

// The guard parses these family labels and entry points without importing this
// suite, so deleting a row cannot silently reduce behavioral coverage.
const families = [
  {
    family: "native dispatch",
    entrypoint: "startDispatchRun",
    run: async () => {
      const { registerSubagent } = await import("@/lib/plugin/registries/subagent-registry")
      registerSubagent("g1", {
        id: "g1",
        name: "Matrix",
        description: "Matrix",
        prompt: "Perform the task.",
        tools: ["A", "B"],
        maxTurns: 10,
      })
      const result = await startDispatchRun({
        subagentId: "g1",
        prompt: "Perform the task.",
        toolsEnabled: true,
        background: false,
        parentSessionId: session.id,
        executionRunId: "matrix-parent",
        caller: {
          parentDepth: 0,
          maxDepth: 3,
          parentChain: [],
          maxConcurrent: 0,
        },
      })
      expect(result.error).toBeUndefined()
      await assertTransport()
    },
  },
  {
    family: "SDK-native subagents",
    entrypoint: "resolveSendOptions",
    run: async () => {
      const { registerSubagent } = await import("@/lib/plugin/registries/subagent-registry")
      for (const id of ["g1", "g2"])
        registerSubagent(id, {
          id,
          name: id,
          description: "Matrix native child",
          prompt: "Perform the task.",
          tools: ["A", "B"],
          maxTurns: 10,
        })
      const run = await child()
      const options = await build(run.id)
      expect(Object.keys(options.agents!)).toEqual(["g1"])
      expect(options.agents!.g1.tools).toEqual(["A"])
      expect(options.agents!.g1.maxTurns).toBe(3)
      await assertOptions(options, run.id)
    },
  },
  {
    family: "Squad start",
    entrypoint: "createSquadRunRecords",
    run: async () => {
      const started = await createSquadRunRecords({
        runId: "matrix-squad",
        teamId: "matrix-team",
        objective: "Task",
        origin: "delegation",
        startedAt: 1,
        parentRunId: "matrix-parent",
        sessionId: session.id,
        priority: 1,
      })
      expect(started.executionRun.authority).toEqual(narrow)
      await assertOptions(await build(started.executionRunId), started.executionRunId)
    },
  },
  {
    family: "Squad delegation",
    entrypoint: "acceptDelegation",
    run: async () => {
      const accepted = await acceptDelegation({
        delegationId: "matrix-delegation",
        title: "Task",
        parentRunId: "matrix-parent",
        sessionId: session.id,
      })
      const started = await createSquadRunRecords({
        runId: "matrix-delegated-squad",
        teamId: "matrix-team",
        objective: "Task",
        origin: "delegation",
        startedAt: 1,
        launchedByRunId: accepted.runId,
        sessionId: session.id,
      })
      expect(started.executionRun.parentRunId).toBe(accepted.runId)
      expect(started.executionRun.authority).toEqual(narrow)
      await assertOptions(await build(started.executionRunId), started.executionRunId)
    },
  },
  {
    family: "remote Squad worker policy",
    entrypoint: "encodeRemoteWorkerPolicy",
    run: async () => {
      const resolved = await resolveRunAuthority({ parentRunId: "matrix-parent", requested: wide })
      expect(() => encodeRemoteWorkerPolicy({}, false, undefined, resolved.authority)).toThrow(
        "unsupported_authority: remote Squad worker: skills, subagents, maxTurns, permissionProfile"
      )
      expect(await getDb().executionRuns.count()).toBe(1)
    },
  },
  {
    family: "local teammate",
    entrypoint: "dispatchTeammate",
    run: async () => {
      await dispatchTeammate(await teamContext(), {
        taskId: "matrix-task",
        prompt: "Perform the task.",
        access: "read",
        validateOutput: false,
      })
      await assertTransport()
    },
  },
  {
    family: "external teammate",
    entrypoint: "dispatchTeammate",
    run: async () => {
      const context = await teamContext("claude-code")
      const manager = getExternalAgentManager({ healthCheckInterval: 0 })
      const id = "matrix-external-teammate"
      await manager.addAgent(
        {
          id,
          name: "Matrix",
          protocol: "acp",
          transport: "stdio",
          enabled: true,
          process: { command: "claude-code-acp", args: [] },
        },
        { connect: false }
      )
      context.externalAgentInstances.set("claude-code", id)
      const resolved = await resolveRunAuthority({ runId: "execution:team:matrix-team-run" })
      expect(resolved.authority!.permissionMode).toBe("default")
      try {
        await expect(
          dispatchTeammate(
            {
              ...context,
              parentPermissionCeiling: {
                permissionMode: "default",
                allowedTools: resolved.authority!.tools!.allow,
                disallowedTools: resolved.authority!.tools!.deny,
              },
            },
            { taskId: "matrix-task", prompt: "Perform the task.", access: "read" }
          )
        ).rejects.toMatchObject({
          name: "RunAuthorityError",
          reason: "unsupported_authority",
          message: expect.stringContaining("tools.native"),
        })
        expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
      } finally {
        await manager.removeAgent(id)
      }
    },
  },
  {
    family: "workflow agent node",
    entrypoint: "runAgentTurn",
    run: async () => {
      await workflowParent()
      await runAgentTurn(workflowContext())
      await assertTransport()
    },
  },
  {
    family: "ensemble",
    entrypoint: "executeAiEnsemble",
    run: async () => {
      await workflowParent()
      await executeAiEnsemble({
        ...workflowContext(),
        params: {
          prompt: "Perform the task.",
          n: 1,
          target: {
            kind: "agent.turn",
            characterId: character.id,
            toolsEnabled: true,
            allowedTools: ["A", "B"],
          },
          aggregation: { kind: "majority-vote-on-field", field: "text" },
        },
      })
      await assertTransport()
    },
  },
  {
    family: "subworkflow",
    entrypoint: "runWorkflow",
    run: async () => {
      await workflowParent()
      const result = await runWorkflow({
        workflow: { ...workflow(), id: "wf-child" },
        trigger: { ...workflowContext().trigger, workflowId: "wf-child" },
        lineage: {
          rootRunId: "matrix-workflow",
          parentRunId: "matrix-workflow",
          parentStepId: "child",
        },
      })
      expect(result.error).toBeUndefined()
      expect(result).toMatchObject({ status: "succeeded" })
      expect(
        (await getDb().executionRuns.get(`execution:workflow:${result.runId}`))?.authority
      ).toEqual(narrow)
      await assertTransport()
    },
  },
  {
    family: "typed workflow tool",
    entrypoint: "executeRunWorkflowTyped",
    run: async () => {
      const { createWorkflow } = await import("@/lib/db/workflows")
      const { publishWorkflow } = await import("@/lib/workflow/publish/publish-workflow")
      const { toolFamily, WORKFLOW_RUNNER_TOOL_NAME } = await import("@/lib/workflow/agent-tools")
      const definition = workflow()
      const wf = await createWorkflow({
        name: "Typed matrix",
        nodes: definition.nodes,
        edges: definition.edges,
        settings: definition.settings,
      })
      await publishWorkflow(wf.id, 1)
      const result = (await toolFamily.run(
        WORKFLOW_RUNNER_TOOL_NAME,
        { name: wf.id, input: {}, executionRunId: "forged-model-parent" },
        { sessionId: session.id, executionRunId: "matrix-parent" } as never
      )) as { ok: boolean; runId: string }
      expect(result.ok).toBe(true)
      expect(await getDb().executionRuns.get(`execution:workflow:${result.runId}`)).toMatchObject({
        parentRunId: "matrix-parent",
        authority: narrow,
      })
      await assertTransport()
    },
  },
  {
    family: "plugin turn",
    entrypoint: "runPluginAgentTurn",
    run: async () => {
      await runPluginAgentTurn(
        {
          characterId: character.id,
          prompt: "Perform the task.",
          cwd: "/matrix",
          permissionMode: "bypassPermissions",
        },
        { parentRunId: "matrix-parent", grantSource: { kind: "plugin", id: "matrix-plugin" } }
      )
      await assertTransport()
    },
  },
  {
    family: "plugin SDK",
    entrypoint: "runPluginAgent",
    run: async () => {
      const invocation = await child()
      await withPluginExecutionContext(
        "matrix-plugin",
        { executionRunId: invocation.id, sessionId: session.id },
        async () => {
          await Promise.resolve()
          return runPluginAgent(
            "Perform the task.",
            { toolsEnabled: true, allowedTools: ["A", "B"], maxTurns: 10 },
            { pluginId: "matrix-plugin" }
          )
        }
      )
      await assertTransport()
    },
  },
  {
    family: "plugin SDK streamed",
    entrypoint: "runPluginAgentStreamed",
    run: async () => {
      const invocation = await child()
      await withPluginExecutionContext(
        "matrix-plugin",
        { executionRunId: invocation.id, sessionId: session.id },
        async () => {
          await Promise.resolve()
          return runPluginAgentStreamed(
            "Perform the task.",
            { toolsEnabled: true, allowedTools: ["A", "B"], maxTurns: 10 },
            { pluginId: "matrix-plugin" }
          ).result
        }
      )
      await assertTransport()
    },
  },
  {
    family: "Bot descendant",
    entrypoint: "createAgentTurnBotExecutor",
    run: async () => {
      const executor = createAgentTurnBotExecutor()
      await executor({
        runId: "matrix-parent",
        botId: "matrix-bot",
        log: () => undefined,
        progress: () => undefined,
        installationId: "matrix-installation",
        installation: {
          id: "matrix-installation",
          definitionId: "matrix-bot",
          definitionSource: "local",
          pinnedVersion: "1.0.0",
          scope: { kind: "account" },
          status: "active",
          config: {},
          credentialBindings: {},
          createdAt: 1,
          updatedAt: 1,
        },
        definition: {
          id: "matrix-bot",
          name: "Matrix",
          prompt: "Perform the task.",
          character: character.id,
        },
        composition: { selection: { authority: "bypassPermissions" } },
        policy: { permissionProfile: wide.permissionProfile },
        event: { id: "matrix-event", payload: {}, binding: {} },
        config: {},
        cwd: "/matrix",
        signal: new AbortController().signal,
        step: { run: async (_name: string, fn: () => Promise<unknown>) => fn() },
      } as unknown as Parameters<typeof executor>[0])
      await assertTransport()
    },
  },
  {
    family: "scheduler",
    entrypoint: "executeChatTask",
    run: async () => {
      const run = await child()
      const result = await executeChatTask(
        {
          id: "matrix-schedule",
          name: "Matrix",
          type: "chat",
          payload: { prompt: "Perform the task.", sessionId: session.id },
        } as Parameters<typeof executeChatTask>[0],
        {
          id: run.id,
          taskId: "matrix-schedule",
          status: "running",
          startedAt: new Date(),
        } as Parameters<typeof executeChatTask>[1],
        new AbortController().signal
      )
      expect(result.error).toBeUndefined()
      expect(result).toMatchObject({ success: true })
      await assertTransport()
    },
  },
  {
    family: "Codex external",
    entrypoint: "execute",
    run: async () => {
      const run = await child()
      await refuseExternal("codex-app-server", { executionRunId: run.id })
      expect((await getDb().executionRuns.get(run.id))?.authority).toEqual(narrow)
      expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
    },
  },
  {
    family: "ACP external",
    entrypoint: "execute",
    run: async () => {
      const run = await child()
      await refuseExternal("acp", { executionRunId: run.id })
      expect((await getDb().executionRuns.get(run.id))?.authority).toEqual(narrow)
      expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
    },
  },
  {
    family: "remote external",
    entrypoint: "beginRemotePersonalRun",
    run: async () => {
      const remote = await beginRemotePersonalRun(session.id)
      try {
        await refuseExternal("acp", remote.context)
        const rows = await getDb()
          .executionRuns.where("parentRunId")
          .equals("matrix-parent")
          .toArray()
        expect(rows).toHaveLength(1)
        expect(rows[0].authority).toEqual(narrow)
      } finally {
        await remote.finish()
      }
    },
  },
  {
    family: "goal",
    entrypoint: "runGoalLoopHeadless",
    run: async () => {
      const { createGoal } = await import("@/lib/db/goals")
      const goal = await createGoal({
        id: "matrix-goal",
        sessionId: session.id,
        rawObjective: "Perform the task.",
        safeObjective: "Perform the task.",
        redactionMapEnc: "",
        status: "active",
        generationId: "matrix-generation",
        config: { maxTurns: 1, maxTokens: 1000, maxJudgeFailures: 1, timeoutMs: 0 },
        turnsUsed: 0,
        tokensUsed: 0,
        judgeFailureCount: 0,
      } as Parameters<typeof createGoal>[0])
      const parent = await seedParent(`execution:goal:${goal.id}`)
      await getDb().executionRuns.update(parent.id, { kind: "goal", sourceId: goal.id })
      const result = await runGoalLoopHeadless({
        goalId: goal.id,
        sessionId: session.id,
        appSettings: await (await import("@/lib/db/settings")).getSettings(),
        signal: new AbortController().signal,
      })
      expect(result.error).toBeUndefined()
      expect(result.turns).toBe(1)
      await assertTransport()
    },
  },
  {
    family: "headless person agent",
    entrypoint: "installPersonAgents",
    run: async () => {
      const actionId = "matrix-action"
      const rootId = hostStateRunId(actionId)
      await startToolExecutionRun(session.id, {
        runId: rootId,
        parentRunId: "matrix-parent",
        authority: wide,
      })
      const manager = getExternalAgentManager({ healthCheckInterval: 0 })
      let refused!: (error: unknown) => void
      const refusal = new Promise<unknown>((resolve) => {
        refused = resolve
      })
      const engine: PersonAgentManager = {
        addAgent: (config) => manager.addAgent(config, { connect: false }),
        removeAgent: (id) => manager.removeAgent(id),
        executeStreaming: async function* (id, prompt, options) {
          try {
            yield* manager.executeStreaming(id, prompt, options)
          } catch (error) {
            refused(error)
            throw error
          }
        },
        cancel: (id, sid) => manager.cancel(id, sid),
        respondToPermission: (id, sid, response) => manager.respondToPermission(id, sid, response),
        respondToElicitation: (id, response) => manager.respondToElicitation(id, response),
      }
      const uninstall = await installPersonAgents({
        manager: engine,
        log: () => undefined,
        transport: {
          call: async <T>(command: string): Promise<T> => {
            if (command === "person_agent_lease_prepare")
              return {
                ticketId: "matrix-ticket",
                secret: "matrix-fixture-key",
                expiresAtMs: Date.now() + 60000,
              } as T
            if (command === "person_agent_usage_get")
              return { inputTokens: 0, outputTokens: 0, requests: 0, openRequests: 0 } as T
            throw new Error(`Matrix person transport cannot execute ${command}`)
          },
          subscribe: () => () => undefined,
          whenSubscribed: async () => undefined,
        },
      })
      try {
        await getPersonAgentRunner()!.startTurn({
          session,
          runtimeId: "claude-agent-acp",
          provider: "openai",
          model: "gpt-4o",
          prompt: "Perform the task.",
          actionId,
          messageId: "matrix-user",
        })
        expect(await refusal).toMatchObject({
          name: "RunAuthorityError",
          reason: "unsupported_authority",
          message: expect.stringContaining("tools.native"),
        })
        expect((await getDb().executionRuns.get(rootId))?.authority).toEqual(narrow)
      } finally {
        await uninstall()
      }
    },
  },
  {
    family: "Best-of-N",
    entrypoint: "createBestOfNExecution",
    run: async () => {
      workspaceFixture = true
      const group = {
        groupId: "matrix-group",
        teamRunId: "matrix-best-of-n",
        repositoryId: "repo",
        sourceRoot: "/matrix",
        baseSha: "matrix-base",
        targetRef: "refs/heads/matrix",
        n: 1,
        createdAt: Date.now(),
        budgetPolicy: {},
        candidates: [
          {
            candidateId: "matrix-candidate",
            index: 0,
            agent: { agentId: character.id },
            childSessionId: "matrix-candidate-session",
          },
        ],
      } as BestOfNGroup
      const rootId = `execution:best-of-n:${group.teamRunId}`
      await startToolExecutionRun(session.id, {
        runId: rootId,
        parentRunId: "matrix-parent",
        authority: wide,
      })
      await getDb().executionRuns.update(rootId, { kind: "best-of-n", sourceId: group.groupId })
      const execution = createBestOfNExecution()
      const request = {
        prompt: "Perform the task.",
        sessionId: session.id,
        requestId: "matrix-request",
        repositoryId: group.repositoryId,
        sourceRoot: group.sourceRoot,
        budgetPolicy: group.budgetPolicy,
        candidates: group.candidates.map((candidate) => candidate.agent),
      }
      await execution.prepare(group, request)
      const candidate = group.candidates[0]
      // No real SCM writes: the transport refuses capture after the model turn.
      await expect(
        execution.execute({
          group,
          candidate,
          request,
          workspace: {
            bundleId: "matrix-bundle",
            workspaceId: "matrix-workspace",
            physicalRoot: "/matrix",
          },
          grant: candidateGrant(group, candidate),
          signal: new AbortController().signal,
        })
      ).rejects.toThrow("Matrix has no transport for task_workspace_changeset_capture")
      await assertTransport()
    },
  },
  {
    family: "Creator",
    entrypoint: "createCreatorTurnRunner",
    run: async () => {
      await createCreatorTurnRunner({ parentRunId: "matrix-parent" })({
        purpose: "review",
        prompt: "Review the task.",
        cwd: "/matrix",
        label: "Matrix review",
      })
      await assertTransport()
    },
  },
  {
    family: "room",
    entrypoint: "createProductionRoomDeps.startMemberRun",
    run: async () => {
      // The full RoomRunner.send path refuses before the model transport with
      // personal_visibility_changed on HEAD's room code too (evidence ledger,
      // 3A room finding). Assert the production member admission the runner
      // calls with the Host outbox sources, and the options it then builds.
      const { createProductionRoomDeps } = await import("@/lib/chat/room/production-deps")
      const runId = await createProductionRoomDeps().execution.startMemberRun!(session.id, {
        automated: true,
        sourceRunIds: ["matrix-parent"],
      })
      expect((await getDb().executionRuns.get(runId))?.parentRunId).toBeUndefined()
      const options = await build(runId)
      expect(options.inheritedRunAuthority).toBeUndefined()
      expect(options.permissionMode).toBe("bypassPermissions")
    },
  },
  {
    family: "direct chat",
    entrypoint: "ensureDirectChatExecutionRun",
    run: async () => {
      const input = { sessionId: session.id, runId: "matrix-direct", parentRunId: "matrix-parent" }
      const run = await ensureDirectChatExecutionRun(input)
      const options = await build(run.id)
      await startDirectChatExecutionRun(input)
      try {
        await (
          await import("@/lib/ai/agent/execution/sidecar-client")
        ).sendPrompt(session.id, "Perform the task.", options)
      } finally {
        await finishDirectChatExecutionRun(session.id, "completed")
      }
      await assertTransport()
    },
  },
  {
    family: "coordinator",
    entrypoint: "ensureDirectChatExecutionRun",
    run: async () => {
      const { createThreadSession } = await import("@/lib/project-coordinator/thread-session")
      const { useProjectStore } = await import("@/stores/project/project-store")
      const project = {
        id: "matrix-project",
        name: "Matrix",
        roots: [{ id: "matrix-root", path: "/matrix", isPrimary: true }],
        sessionIds: [session.id],
        knowledgeBase: [],
        sessionCount: 1,
        messageCount: 0,
        lastAccessedAt: new Date(1),
        coordinator: { enabled: true, threadExecution: "local" },
        createdAt: new Date(1),
        updatedAt: new Date(1),
      } satisfies import("@/types").Project
      await getDb().projects.put(project)
      useProjectStore.setState({ projects: [project], activeProjectId: project.id })
      await getDb().sessions.update(session.id, {
        projectId: project.id,
        projectRole: "coordinator",
      })
      const thread = await createThreadSession({
        projectId: project.id,
        coordinatorSessionId: session.id,
        parentExecutionRunId: "matrix-parent",
        proposedBy: "coordinator",
        brief: {
          title: "Matrix thread",
          tldr: "Perform the task.",
          situation: "The coordinator delegates a task.",
          codeLocations: [],
          solution: "Perform the task.",
          caveats: [],
          mode: "aside",
        },
      })
      const input = {
        sessionId: thread.id,
        runId: "matrix-thread-run",
        parentRunId: thread.projectThread!.parentExecutionRunId,
      }
      const run = await ensureDirectChatExecutionRun(input)
      const options = await build(run.id, thread)
      await startDirectChatExecutionRun(input)
      try {
        await (
          await import("@/lib/ai/agent/execution/sidecar-client")
        ).sendPrompt(thread.id, "Perform the task.", options)
      } finally {
        await finishDirectChatExecutionRun(thread.id, "completed")
      }
      await assertTransport()
    },
  },
]

const matrixDbFixture = createDbTestFixture()
beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
  await matrixDbFixture.initialize()
})

async function resetMatrixFixture() {
  __resetSessionExecutionRoutesForTests()
  ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  modelSends.length = 0
  externalModelSends.length = 0
  persistedAtSend.length = 0
  workspaceFixture = false
  setTransport({
    call: async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
      if (workspaceFixture && name === "task_workspace_canonical_root") return args!.path as T
      if (workspaceFixture && name === "workflow_persist_run_state") return undefined as T
      if (name === "agent_close_session") return undefined as T
      if (workspaceFixture && name === "task_workspace_project_source_ensure")
        return { root: "/matrix", source: "local", standsFor: null, remoteUrl: null } as T
      if (
        workspaceFixture &&
        ["task_workspace_bundle_get", "task_workspace_bundle_acquire"].includes(name)
      )
        return {
          bundleId: "matrix-bundle",
          state: "active",
          ownerRef: "matrix-candidate-session",
          leases: [
            {
              role: "primary",
              logicalRootId: "repo",
              workspaceId: "matrix-workspace",
              aliasPath: "/matrix",
            },
          ],
        } as T
      if (workspaceFixture && name === "task_workspace_bundle_turn_begin") {
        const request = args!.request as { run: Record<string, unknown> }
        return {
          bundleTurnId: "matrix-bundle-turn",
          bundleId: "matrix-bundle",
          primaryLogicalRootId: "repo",
          primaryAlias: "/matrix",
          additionalAliases: [],
          runs: [
            {
              logicalRootIds: ["repo"],
              run: { ...request.run, executionRoot: "/matrix", state: "active" },
            },
          ],
        } as T
      }
      if (
        workspaceFixture &&
        (name === "task_workspace_bundle_turn_settle" ||
          name === "task_workspace_bundle_turn_abort")
      )
        return {
          bundleTurnId: "matrix-bundle-turn",
          bundleId: "matrix-bundle",
          resources: [],
          runs: [],
        } as T
      if (name === "agent_send" || name === "claude_send") {
        const send = args as { sessionId: string; options: SendOptions }
        const messageId = crypto.randomUUID()
        modelSends.push(send)
        await capturePersisted(send.options, send.sessionId)
        for (const handler of handlers.get("claude://message") ?? []) {
          handler({
            type: "event",
            sessionId: send.sessionId,
            turnId: send.options.turnId,
            event: {
              type: "assistant",
              message: {
                id: messageId,
                role: "assistant",
                content: [{ type: "text", text: "done" }],
              },
              uuid: messageId,
              session_id: send.sessionId,
              parent_tool_use_id: null,
            },
          })
          handler({
            type: "event",
            sessionId: send.sessionId,
            turnId: send.options.turnId,
            event: { type: "result", subtype: "success", result: "done", is_error: false },
          })
          handler({ type: "session_ended", sessionId: send.sessionId, turnId: send.options.turnId })
        }
        return undefined as T
      }
      throw new Error(`Matrix has no transport for ${name}`)
    },
    subscribe: <T>(name: string, handler: (payload: T) => void) => {
      const subscribers = handlers.get(name) ?? new Set()
      subscribers.add(handler as (payload: unknown) => void)
      handlers.set(name, subscribers)
      return () => {
        subscribers.delete(handler as (payload: unknown) => void)
      }
    },
  })
  await matrixDbFixture.restore()
  jest.mocked(runAndCaptureAssistantReply).mockClear()
  jest
    .mocked(runAndCaptureAssistantReply)
    .mockImplementation(async (sessionId, _prompt, options, cap) => {
      await cap?.beforeSend?.()
      cap?.onExecutorAccepted?.(sessionId)
      cap?.onExecutorStarted?.(Promise.resolve())
      await capturePersisted(options!, sessionId)
      return {
        text: "done",
        resultSubtype: "success",
        messageId: crypto.randomUUID(),
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      }
    })
  await getDb().sessions.put(session)
  await getDb().characters.put(character)
  const { getSettings, saveSettings } = await import("@/lib/db/settings")
  const defaults = await getSettings()
  const settings: AppSettings = {
    ...defaults,
    defaultProvider: "openai",
    defaultModel: "gpt-4o",
    providerSettings: {
      openai: {
        providerId: "openai",
        defaultModel: "gpt-4o",
        enabled: true,
        apiKey: "matrix-fixture-key",
      },
    },
    autoRouting: { ...DEFAULT_AUTO_ROUTING, ...defaults.autoRouting, enabled: false },
  }
  // Provider keys live in the secret store, never in the raw settings row.
  const { __setProviderSecretBackendForTesting } =
    await import("@/lib/settings/provider-secret-store")
  const secrets = new Map<string, string>()
  __setProviderSecretBackendForTesting({
    save: async (key, value) => void secrets.set(key, value),
    load: async (key) => secrets.get(key) ?? null,
    delete: async (key) => void secrets.delete(key),
  })
  await saveSettings(settings)
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  useSettingsStore.setState({ settings })
  await seedParent()
  await getDb().skills.bulkPut(
    ["s1", "s2"].map((id) => ({
      id,
      name: id,
      content: `Instructions for ${id}`,
      status: "enabled" as const,
      createdAt: 1,
      updatedAt: 1,
    }))
  )
}
beforeEach(resetMatrixFixture)

afterAll(async () => {
  await ExternalAgentManager.peekInstance()?.dispose()
  ExternalAgentManager.resetInstance()
  await matrixDbFixture.dispose()
  setTransport(transportBeforeMatrix)
  jest.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
})

afterEach(async () => {
  // Drain seeding started by lazy Bot/agent imports before the next DB reset.
  await whenSeeded()
  await getDb().transaction("r", getDb().tables, async () => undefined)
  await new Promise((resolve) => setTimeout(resolve, 0))
  ;(await import("@/lib/sandbox/session-runtime")).__resetSandboxSessionRuntimeForTesting()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

it.each(families)("$family meets the Host parent at its real entry point", async ({ run }) => {
  await run()
})

it.each(["codex-app-server", "acp", "opencode"] as const)(
  "an unrestricted chat parent does not refuse a %s child",
  async (protocol) => {
    const parent = await ensureDirectChatExecutionRun({
      sessionId: session.id,
      runId: "plain-chat",
      localAuthorization: (await import("./acting-authority")).LOCAL_PERSON_RUN,
    })
    const options = await resolveSendOptions({
      session: { ...session, characterId: undefined },
      character: { ...character, allowedTools: undefined, skillIds: [], mcpServerIds: undefined },
      executionIdentity: { runId: parent.id },
      preloadedEnv: {},
      preloadedMcpServers: [],
    })
    expect(options.runAuthority?.skills).toBeUndefined()
    expect(options.runAuthority?.mcpServers).toBeUndefined()
    expect((await getDb().executionRuns.get(parent.id))?.authority).toEqual(options.runAuthority)
    const child = await startToolExecutionRun(session.id, { parentRunId: parent.id })
    await expect(
      enforceExternalRunAuthority(
        { executionRunId: child.id },
        { permissionMode: "default" },
        { protocol }
      )
    ).resolves.toBeDefined()
  }
)

it("a blocked preparation can be rebuilt with different skills on the same run id", async () => {
  const run = await ensureDirectChatExecutionRun({ sessionId: session.id, runId: "resent" })
  const ctx = {
    session,
    character: { ...character, skillIds: ["s1"] },
    executionIdentity: { runId: run.id },
    preloadedEnv: {},
    preloadedMcpServers: [],
  }
  const first = await resolveSendOptions(ctx)
  expect(first.runAuthority?.skills).toBeUndefined()
  const second = await resolveSendOptions({ ...ctx, character: { ...character, skillIds: ["s2"] } })
  expect(second.runAuthority?.skills).toBeUndefined()
  expect((await getDb().executionRuns.get(run.id))?.authority).toEqual(second.runAuthority)
})

it.each(["codex-app-server", "acp", "opencode"] as const)(
  "an explicit grant skill cap still refuses unsupported %s discovery",
  async (protocol) => {
    const parent = await ensureDirectChatExecutionRun({
      sessionId: session.id,
      runId: "grant-parent",
    })
    await resolveSendOptions({
      session: { ...session, characterId: undefined },
      character: { ...character, allowedTools: undefined, skillIds: [], mcpServerIds: undefined },
      capabilityGrants: [
        { schemaVersion: 1, source: { kind: "plugin" }, skills: { only: ["s1"] } },
      ],
      executionIdentity: { runId: parent.id },
      preloadedEnv: {},
      preloadedMcpServers: [],
    })
    expect((await getDb().executionRuns.get(parent.id))?.authority?.skills).toEqual({
      only: ["s1"],
    })
    const child = await startToolExecutionRun(session.id, { parentRunId: parent.id })
    await expect(
      enforceExternalRunAuthority(
        { executionRunId: child.id },
        { permissionMode: "default" },
        { protocol }
      )
    ).rejects.toMatchObject({
      reason: "unsupported_authority",
      message: expect.stringContaining(`${protocol}: skills.only`),
    })
  }
)

it("does not record selected built-in skills as authority", async () => {
  const { BUILT_IN_SKILL_CATALOG, builtinSkillId } = await import("@/lib/skills/built-in-catalog")
  const selected = BUILT_IN_SKILL_CATALOG[0]
  const parent = await ensureDirectChatExecutionRun({
    sessionId: session.id,
    runId: "builtin-parent",
  })
  const options = await resolveSendOptions({
    session,
    character: { ...character, skillIds: [builtinSkillId(selected)] },
    executionIdentity: { runId: parent.id },
    preloadedEnv: {},
    preloadedMcpServers: [],
  })
  expect(options.runAuthority?.skills).toBeUndefined()
  expect((await getDb().executionRuns.get(parent.id))?.authority).toEqual(options.runAuthority)
})

it("preserves inherited caps when no corresponding surface happens to be available", async () => {
  const run = await child()
  const options = await resolveSendOptions({
    session,
    character: { ...character, allowedTools: undefined, skillIds: [], mcpServerIds: undefined },
    executionIdentity: { runId: run.id },
    preloadedEnv: {},
    preloadedMcpServers: [],
  })
  expect(options.mcpServers).toEqual({})
  expect(options.runAuthority).toEqual(narrow)
  expect((await getDb().executionRuns.get(run.id))?.authority).toEqual(narrow)
})

it("Creator replaces its own resolved tool surface without a parent cap", async () => {
  await createCreatorTurnRunner()({
    purpose: "plan",
    prompt: "Perform the task.",
    cwd: "/matrix",
    label: "Creator",
  })
  const options = jest.mocked(runAndCaptureAssistantReply).mock.calls[0][2]!
  expect(options.allowedTools).toEqual(["Read", "Glob", "Grep"])
  expect(options.runAuthority?.tools?.allow).toEqual(["Read", "Glob", "Grep"])
  expect(persistedAtSend[0].authority).toEqual(options.runAuthority)
})

// Each family uses the same Host option resolver. The bypass fixture omits only
// its authority dispatch reference, retaining all original option inputs.
it.each([...families.map(({ family }) => family), "plain chat", "plan step", "Bot/plugin turn"])(
  "%s has no-cap option invariance at the shared Host resolver",
  async (family) => {
    const parent = await startToolExecutionRun(session.id, {
      localAuthorization: (await import("./acting-authority")).LOCAL_PERSON_RUN,
    })
    const own = await startToolExecutionRun(session.id, { parentRunId: parent.id })
    const grant = {
      schemaVersion: 1 as const,
      source: { kind: "workflow" as const },
      skills:
        family === "workflow agent node"
          ? { add: ["s1"] }
          : family === "plan step"
            ? { remove: ["s2"] }
            : undefined,
    }
    const context = {
      session,
      character,
      capabilityGrants: [grant],
      preloadedEnv: {},
      preloadedMcpServers: [],
    }
    const baseline = await resolveSendOptions(context)
    const actual = await resolveSendOptions({ ...context, executionIdentity: { runId: own.id } })
    const fields = [
      "permissionMode",
      "tools",
      "allowedTools",
      "disallowedTools",
      "mcpServers",
      "settingSources",
      "runtimeExtensions",
      "claudeAgentSdk",
      "agents",
      "maxTurns",
    ] as const
    for (const field of fields)
      expect(actual[field as keyof SendOptions]).toEqual(baseline[field as keyof SendOptions])
    expect(actual.runAuthority?.skills).toBeUndefined()
    expect(actual.runAuthority?.permissionMode).toBeUndefined()
    expect(actual.runAuthority?.tools?.allow).toBeUndefined()
  }
)

it.each(["acceptEdits", "bypassPermissions"] as const)(
  "Bot/plugin request honours %s up to its real inherited cap",
  async (mode) => {
    await getDb().executionRuns.update("matrix-parent", {
      authority: { schemaVersion: 1, caps: "explicit-v1" as const, permissionMode: mode },
    })
    await runPluginAgentTurn(
      {
        characterId: character.id,
        prompt: "Perform the task.",
        cwd: "/matrix",
        permissionMode: mode,
      },
      { parentRunId: "matrix-parent", grantSource: { kind: "bot", id: "matrix-bot" } }
    )
    const options = jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]!
    expect(options.permissionMode).toBe(mode)
    expect(options.runAuthority?.permissionMode).toBe(mode)
  }
)

it("canonical MCP server ids preserve github across parent and child resolution", async () => {
  const parent = await startToolExecutionRun(session.id, {})
  const servers = [
    {
      id: "github-id",
      name: "github",
      enabled: true,
      transport: "stdio" as const,
      config: { command: "github-mcp" },
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  const context = {
    session,
    character: { ...character, mcpServerIds: ["github-id"] },
    preloadedEnv: {},
    preloadedMcpServers: servers,
  }
  await resolveSendOptions({
    ...context,
    executionIdentity: { runId: parent.id },
    capabilityGrants: [
      { schemaVersion: 1, source: { kind: "workflow" }, mcpServers: { only: ["github-id"] } },
    ],
  })
  expect((await getDb().executionRuns.get(parent.id))?.authority?.mcpServers).toEqual({
    only: ["github-id"],
  })
  const child = await startToolExecutionRun(session.id, { parentRunId: parent.id })
  const options = await resolveSendOptions({ ...context, executionIdentity: { runId: child.id } })
  expect(Object.keys(options.mcpServers ?? {})).toContain("github")
  expect(options.runAuthority?.mcpServers).toEqual({ only: ["github-id"] })
})

it.each([{ add: ["s1"] }, { remove: ["s2"] }])(
  "skill delta %j does not change automatic skill loading into a cap",
  async (skills) => {
    const parent = await startToolExecutionRun(session.id, {})
    const context = {
      session,
      character: { ...character, skillIds: [] },
      capabilityGrants: [
        { schemaVersion: 1 as const, source: { kind: "workflow" as const }, skills },
      ],
      preloadedEnv: {},
      preloadedMcpServers: [],
    }
    const baseline = await resolveSendOptions(context)
    const actual = await resolveSendOptions({ ...context, executionIdentity: { runId: parent.id } })
    expect(actual.systemPrompt).toEqual(baseline.systemPrompt)
    expect(actual.appendSystemPrompt).toEqual(baseline.appendSystemPrompt)
    expect(actual.runAuthority?.skills).toBeUndefined()
  }
)

// Invoke the production adapters twice, including their post-resolve overrides.
// The control disables only the authority overlay; all launch inputs are equal.
const postResolveFamilies = [
  "plugin turn",
  "Bot descendant",
  "local teammate",
  "external teammate",
  "scheduler",
  "coordinator",
  "Creator",
  "workflow agent node",
  "native dispatch",
  "plugin agent session",
  "plan step",
  "room automated turn",
]
it.each(postResolveFamilies)(
  "%s preserves HEAD-equivalent options at its real entry point without ancestor caps",
  async (name) => {
    const launch =
      name === "room automated turn"
        ? async () => {
            const { RoomRunner } = await import("@/lib/chat/room/runner")
            const { createProductionRoomDeps } = await import("@/lib/chat/room/production-deps")
            const { createStoreRoomSinks } = await import("@/lib/chat/room/store-sinks")
            const { useChatStore } = await import("@/stores/chat")
            useChatStore.setState({ sessions: {} })
            await getDb().sessions.put({ ...session, kind: "team", teamId: "invariant-room" })
            await getDb().teams.put({
              id: "invariant-room",
              name: "Room",
              orchestration: "round_robin",
              members: [{ characterId: character.id }],
              maxAutoRounds: 0,
              createdAt: 1,
              updatedAt: 1,
            } as import("@cognia/agent-config-types").Team)
            const deps = createProductionRoomDeps({ persistDelayMs: 0 })
            // Replace only the process boundary, as in runAndCapture above. The room's
            // real admission, privacy projection, option builder and final overrides run;
            // the separately documented IPC digest refusal is outside this comparison.
            deps.ipc.sendPrompt = async (sessionId, _content, options) => {
              const { transport } = await import("@/lib/tauri/transport-instance")
              await transport.call("agent_send", { sessionId, options })
            }
            const runner = new RoomRunner(deps, createStoreRoomSinks())
            const unlisten = await (
              await import("@/lib/ai/agent/execution/sidecar-client")
            ).onClaudeMessage((event) => runner.handleEvent(event))
            try {
              await runner.send("Perform the task.", {
                sessionId: session.id,
                targetMemberIds: [character.id],
                automatedTurn: {
                  producer: "background-result",
                  messageId: "invariant-delivery",
                  personalRunIds: ["matrix-parent", "missing-source"],
                },
              })
            } finally {
              unlisten()
              runner.dispose()
            }
          }
        : name === "external teammate"
          ? async () => {
              const context = await teamContext("claude-code")
              await withAcpProcessBoundary("invariant-external-member", async (_manager, id) => {
                context.externalAgentInstances.set("claude-code", id)
                await dispatchTeammate(context, {
                  taskId: "matrix-task",
                  prompt: "Perform the task.",
                  access: "read",
                  validateOutput: false,
                })
                expect(externalModelSends).toHaveLength(1)
                expect(externalModelSends[0].allowedTools).toEqual(["A", "B"])
                expect(externalModelSends[0].permissionCeiling).toBeUndefined()
                expect(externalModelSends[0].nativePolicy).toBeUndefined()
              })
            }
          : name === "plugin agent session"
            ? async () => {
                const { createPluginAgentSession } = await import("@/lib/plugin/agent-sdk/session")
                const pluginSession = await createPluginAgentSession(
                  { characterId: character.id },
                  "matrix-plugin"
                )
                await withPluginExecutionContext(
                  "matrix-plugin",
                  { executionRunId: "matrix-parent" },
                  () =>
                    pluginSession.send("Perform the task.", {
                      toolsEnabled: true,
                      allowedTools: ["A", "B"],
                    })
                )
              }
            : name === "plan step"
              ? async () => {
                  const { dispatchPlanStepNode } = await import("@/lib/agent/plan/step-dispatch")
                  const { DEFAULT_PLAN_CONFIG } = await import("@/types/agent/plan")
                  const plan = {
                    id: "invariant-plan",
                    sessionId: session.id,
                    title: "Plan",
                    source: "manual",
                    executionMode: "auto",
                    status: "executing",
                    steps: [
                      {
                        id: "step",
                        title: "Step",
                        kind: "agent_turn",
                        status: "pending",
                        order: 0,
                        dependencies: [],
                      },
                    ],
                    totalSteps: 1,
                    completedSteps: 0,
                    config: DEFAULT_PLAN_CONFIG,
                    refinementCount: 0,
                    generationId: "g",
                    createdAt: 1,
                    updatedAt: 1,
                  } as import("@/types/agent/plan").AgentPlan
                  await dispatchPlanStepNode(
                    {
                      runId: "invariant-plan-run",
                      planId: plan.id,
                      plan,
                      characterId: character.id,
                      writer: { setStepStatus: async () => undefined },
                    },
                    "step",
                    new AbortController().signal
                  )
                }
              : families.find((entry) => entry.family === name)!.run
    const optionFields = [
      "permissionMode",
      "tools",
      "allowedTools",
      "disallowedTools",
      "mcpServers",
      "settingSources",
      "runtimeExtensions",
      "claudeAgentSdk",
      "agents",
      "maxTurns",
      "permissionCeiling",
      "nativePolicy",
      "maxSteps",
      "context",
    ] as const
    const capture = () =>
      [
        ...jest.mocked(runAndCaptureAssistantReply).mock.calls.map((call) => call[2]!),
        ...modelSends.map((call) => call.options),
        ...externalModelSends,
      ].map((options) => {
        const projection = Object.fromEntries(
          optionFields.map((key) => [key, (options as unknown as Record<string, unknown>)[key]])
        )
        const context = projection.context as
          | {
              custom?: { processOrigin?: { childRunId: string; dispatchEpoch: number } }
            }
          | undefined
        const origin = context?.custom?.processOrigin
        if (origin) {
          // Both real dispatches allocate fresh Host ids. Compare the policy
          // payload while still requiring a genuine generated dispatch id.
          expect(origin.childRunId).toMatch(/^team-child-/)
          projection.context = {
            ...context,
            custom: { ...context.custom, processOrigin: { ...origin, childRunId: "<host-child>" } },
          }
        }
        return projection
      })
    invarianceComparison = true
    try {
      await resetMatrixFixture()
      mockBypassAuthority = true
      await launch()
      const baseline = capture()
      expect(baseline.length).toBeGreaterThan(0)
      mockBypassAuthority = false
      await resetMatrixFixture()
      await launch()
      expect(capture()).toEqual(baseline)
    } finally {
      mockBypassAuthority = false
      invarianceComparison = false
    }
  }
)

it.each(["chat", "agent", "skill"] as const)(
  "cron %s uses the real resolver without a fabricated run and inherits only an existing Host cap",
  async (type) => {
    const executors = await import("@/lib/scheduler/executors")
    const { DEFAULT_EXECUTION_CONFIG, DEFAULT_NOTIFICATION_CONFIG } =
      await import("@/types/scheduler")
    const executor =
      type === "chat"
        ? executors.executeChatTask
        : type === "agent"
          ? executors.executeAgentTask
          : executors.executeSkillTask
    for (const capped of [false, true]) {
      modelSends.length = 0
      const id = `cron-${type}-${capped}`
      if (capped)
        await startToolExecutionRun(session.id, { runId: id, parentRunId: "matrix-parent" })
      const result = await executor(
        {
          id: "cron",
          name: "Cron",
          type,
          trigger: { type: "cron", cronExpression: "0 * * * *" },
          config: DEFAULT_EXECUTION_CONFIG,
          notification: DEFAULT_NOTIFICATION_CONFIG,
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          payload: {
            prompt: "Run cron",
            sessionId: session.id,
            characterId: character.id,
            skillId: "s1",
          },
        },
        { id, taskId: "cron", status: "running", startedAt: new Date() } as Parameters<
          typeof executor
        >[1],
        new AbortController().signal
      )
      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(modelSends.length).toBeGreaterThan(0)
      const options = modelSends.at(-1)!.options
      if (capped) {
        expect(options.maxTurns).toBe(3)
        expect(options.allowedTools).toEqual(["A"])
      } else {
        expect(options.inheritedRunAuthority).toBeUndefined()
        expect(await getDb().executionRuns.get(id)).toBeUndefined()
      }
    }
  }
)

it("executeAgent maxSteps replaces character policy for this run and creates no descendant cap", async () => {
  const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
  const { registerSubagent } = await import("@/lib/plugin/registries/subagent-registry")
  registerSubagent("uncapped-native", {
    id: "uncapped-native",
    name: "Native",
    description: "Native",
    prompt: "Work",
    maxTurns: 80,
    tools: ["Bash"],
  })
  const parent = await ensureDirectChatExecutionRun({ sessionId: session.id, runId: "own-policy" })
  await getDb().characters.update(character.id, {
    executionPolicy: { maxTurns: 10 },
    disallowedTools: ["WebSearch"],
  })
  await executeAgent("Work", {
    characterId: character.id,
    toolsEnabled: true,
    maxSteps: 40,
    executionIdentity: { runId: parent.id },
  })
  const options = jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]!
  expect(options.maxTurns).toBe(40)
  expect(options.disallowedTools).toContain("WebSearch")
  expect(options.runAuthority?.maxTurns).toBeUndefined()
  expect(options.runAuthority?.tools?.deny).toBeUndefined()
  expect(options.agents?.["uncapped-native"].maxTurns).toBe(80)
  const descendant = await startToolExecutionRun(session.id, { parentRunId: parent.id })
  for (const protocol of ["codex-app-server", "acp"] as const) {
    const own = { permissionMode: "acceptEdits" as const, maxSteps: 80 }
    expect(
      await enforceExternalRunAuthority({ executionRunId: descendant.id }, own, { protocol })
    ).toEqual(own)
  }
})

it("dispatch applies a character surface without recording it as descendant authority, including plugin ACP", async () => {
  await getDb().executionRuns.update("matrix-parent", { authority: undefined })
  const ownCharacter = { ...character, disallowedTools: ["WebFetch"] }
  await resolveSendOptions({
    session,
    character: ownCharacter,
    appSettings: await (await import("@/lib/db/settings")).getSettings(),
    executionIdentity: { runId: "matrix-parent" },
    preloadedEnv: {},
    preloadedMcpServers: [],
  })
  const { registerSubagent } = await import("@/lib/plugin/registries/subagent-registry")
  registerSubagent("surface-child", {
    id: "surface-child",
    name: "Child",
    description: "Child",
    prompt: "Work",
  })
  const { resolveCaller } = await import("@/lib/ai/agent/execution/delegation/dispatch-run")
  const result = await startDispatchRun({
    subagentId: "surface-child",
    prompt: "Work",
    toolsEnabled: true,
    background: false,
    parentSessionId: session.id,
    executionRunId: "matrix-parent",
    caller: await resolveCaller(session.id),
  })
  expect(result.error).toBeUndefined()
  const childId = `execution:job:${result.runId}`
  const childRow = await getDb().executionRuns.get(childId)
  expect(childRow).toBeDefined()
  expect(childRow?.authority?.tools?.deny).toBeUndefined()
  expect(childRow?.authority?.permissionMode).toBeUndefined()
  const resolvedChild = jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]!
  expect(resolvedChild.disallowedTools).toContain("WebFetch")
  const { initializePluginPermissions, revokePluginPermissions } =
    await import("@/lib/plugin/api/permission-api")
  const { runPluginExternalAgent } = await import("@/lib/plugin/api/external-agent-api")
  initializePluginPermissions("surface-plugin", ["agent:dispatch-external"])
  try {
    await withAcpProcessBoundary("surface-acp", async (_manager, id) => {
      const { useExternalAgentStore } = await import("@/stores/agent/external-agent-store")
      const agents = useExternalAgentStore.getState().agents
      useExternalAgentStore.setState({
        agents: {
          ...agents,
          [id]: {
            ..._manager.getAgent(id)!.config,
            defaultPermissionMode: "acceptEdits",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        },
      })
      try {
        await withPluginExecutionContext(
          "surface-plugin",
          { executionRunId: childId },
          async () => {
            const result = await runPluginExternalAgent("surface-plugin", id, "Work", {
              permissionMode: "acceptEdits",
            })
            expect(result.success).toBe(true)
          }
        )
        expect(externalModelSends.at(-1)?.nativePolicy).toBeUndefined()
      } finally {
        useExternalAgentStore.setState({ agents })
      }
    })
  } finally {
    revokePluginPermissions("surface-plugin")
  }
})

it.each([false, true])(
  "own maxSteps 10 then grant 40 is replaced, inherited cap only narrows (capped=%s)",
  async (capped) => {
    const root = await ensureDirectChatExecutionRun({ sessionId: session.id, runId: "grant-root" })
    if (capped)
      await getDb().executionRuns.update(root.id, {
        authority: { schemaVersion: 1, caps: "explicit-v1" as const, maxTurns: 5 },
      })
    const run = capped ? await startToolExecutionRun(session.id, { parentRunId: root.id }) : root
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    await executeAgent("Work", {
      characterId: character.id,
      toolsEnabled: true,
      maxSteps: 10,
      capabilityGrants: [
        { schemaVersion: 1, source: { kind: "workflow", id: "own-grant" }, maxTurns: 40 },
      ],
      executionIdentity: { runId: run.id },
    })
    const options = jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]!
    expect(options.maxTurns).toBe(capped ? 5 : 40)
    expect((await getDb().executionRuns.get(run.id))?.authority?.maxTurns).toBe(capped ? 5 : 40)
  }
)

it.each(["claude", "claude-code"] as const)(
  "team default mode applies without being recorded for %s",
  async (runtime) => {
    await getDb().executionRuns.update("matrix-parent", { authority: undefined })
    const context = await teamContext(runtime)
    context.team.config.defaultPermissionMode = "plan"
    const dispatch = () =>
      dispatchTeammate(context, {
        taskId: "matrix-task",
        prompt: "Work",
        access: "read",
        validateOutput: false,
      })
    if (runtime === "claude-code") {
      await withAcpProcessBoundary("team-default-acp", async (_manager, id) => {
        context.externalAgentInstances.set("claude-code", id)
        await dispatch()
        expect(externalModelSends.at(-1)?.permissionMode).toBe("plan")
      })
    } else {
      await dispatch()
      expect(jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]?.permissionMode).toBe(
        "plan"
      )
    }
    const descendants = (await getDb().executionRuns.toArray()).filter((row) => row.parentRunId)
    expect(descendants.length).toBeGreaterThan(0)
    for (const row of descendants) expect(row.authority?.permissionMode).toBeUndefined()
  }
)

it("dispatches, rebuilds and restarts a job after the grandparent session and run are deleted", async () => {
  const root = await seedParent("retained-grandparent")
  await getDb().sessions.put({ ...session, id: "deleted-grandparent-session" })
  await getDb().executionRuns.update(root.id, { sessionId: "deleted-grandparent-session" })
  await getDb().executionRuns.update("matrix-parent", {
    parentRunId: root.id,
    ...recordedRunMetadata("child", { parent: root }),
  })
  await getDb().executionRuns.delete(root.id)
  await getDb().sessions.delete("deleted-grandparent-session")
  await families.find((entry) => entry.family === "native dispatch")!.run()
  const jobs = (await getDb().executionRuns.toArray()).filter((row) =>
    row.id.startsWith("execution:job:")
  )
  expect(jobs.length).toBeGreaterThan(0)
  const rebuilt = await build(jobs[0].id)
  expect(rebuilt.maxTurns).toBe(3)
  expect(rebuilt.runAuthority).toEqual(narrow)
  const restart = await startToolExecutionRun(jobs[0].sessionId, {
    runId: jobs[0].id,
    parentRunId: "matrix-parent",
  })
  expect(restart.authority).toEqual(narrow)
})

it("a child grant outside its parent's native allowlist finalizes to no tools", async () => {
  const parent = await ensureDirectChatExecutionRun({
    sessionId: session.id,
    runId: "native-tool-parent",
  })
  await getDb().executionRuns.update(parent.id, {
    authority: {
      schemaVersion: 1,
      caps: "explicit-v1" as const,
      tools: { allow: ["Read", "Grep"] },
    },
  })
  const child = await startToolExecutionRun(session.id, { parentRunId: parent.id })
  const options = await resolveSendOptions({
    session,
    character: { ...character, allowedTools: undefined },
    appSettings: await (await import("@/lib/db/settings")).getSettings(),
    executionIdentity: { runId: child.id },
    preloadedEnv: {},
    preloadedMcpServers: [],
    capabilityGrants: [
      { schemaVersion: 1, source: { kind: "workflow" }, tools: { restrictTo: ["WebSearch"] } },
    ],
  })
  expect(options.allowedTools).toEqual([])
  expect(options.toolSurface).toBe("none")
})

it("prepares a possible coordinator HostState turn against its parent without creating or writing a run", async () => {
  const parent = await getDb().executionRuns.get("matrix-parent")
  const options = await resolveSendOptions({
    session,
    character,
    appSettings: await (await import("@/lib/db/settings")).getSettings(),
    deferredExecutionRun: { parentRunId: "matrix-parent" },
    executionIdentity: { runId: "not-created" },
    preloadedEnv: {},
    preloadedMcpServers: [],
  })
  expect(options.maxTurns).toBe(3)
  expect(options.inheritedRunAuthority).toEqual(narrow)
  expect(await getDb().executionRuns.get("not-created")).toBeUndefined()
  expect(await getDb().executionRuns.get("matrix-parent")).toEqual(parent)
})

it.each(["only", "restrictTo"] as const)(
  "own skill %s cap governs loading and recording",
  async (field) => {
    await getDb().executionRuns.update("matrix-parent", { authority: undefined })
    const options = await resolveSendOptions({
      session,
      character,
      appSettings: await (await import("@/lib/db/settings")).getSettings(),
      executionIdentity: { runId: "matrix-parent" },
      preloadedEnv: {},
      preloadedMcpServers: [],
      capabilityGrants: [
        { schemaVersion: 1, source: { kind: "plugin" }, skills: { [field]: ["s1"] } },
      ],
      ephemeralSkillIds: ["s2"],
    })
    expect([options.systemPrompt, options.appendSystemPrompt].join("\n")).toContain(
      "Instructions for s1"
    )
    expect([options.systemPrompt, options.appendSystemPrompt].join("\n")).not.toContain(
      "Instructions for s2"
    )
    expect(options.runAuthority?.skills?.only).toEqual(["s1"])
    expect((await getDb().executionRuns.get("matrix-parent"))?.authority?.skills?.only).toEqual([
      "s1",
    ])
  }
)

it.each([false, true].flatMap((marked) => ["run", "session"].map((api) => ({ marked, api }))))(
  "ambiguous plugin $api invocations start unparented or meet the personal fence (marked: $marked)",
  async ({ marked, api }) => {
    const a = await ensureDirectChatExecutionRun({ sessionId: session.id, runId: "overlap-a" })
    const b = await ensureDirectChatExecutionRun({ sessionId: session.id, runId: "overlap-b" })
    if (marked)
      await getDb().executionRuns.update(a.id, {
        personalMarks: [{ person: { kind: "local-person" }, source: "L5", markedAt: 1 }],
      })
    const pluginSession =
      api === "session"
        ? await (
            await import("@/lib/plugin/agent-sdk/session")
          ).createPluginAgentSession({ characterId: character.id }, "overlap-plugin")
        : undefined
    const operation = withPluginExecutionContext("overlap-plugin", { executionRunId: a.id }, () =>
      withPluginExecutionContext("overlap-plugin", { executionRunId: b.id }, () =>
        pluginSession
          ? pluginSession.send("Work", { toolsEnabled: true })
          : runPluginAgent("Work", { toolsEnabled: true }, { pluginId: "overlap-plugin" })
      )
    )
    if (marked) await expect(operation).rejects.toMatchObject({ code: "personal-egress-denied" })
    else {
      await operation
      const children = (await getDb().executionRuns.toArray()).filter(
        (run) => ![a.id, b.id, "matrix-parent"].includes(run.id)
      )
      if (api === "run") expect(children.length).toBeGreaterThan(0)
      else
        expect(modelSends.length + jest.mocked(runAndCaptureAssistantReply).mock.calls.length).toBe(
          1
        )
      for (const child of children) expect(child.parentRunId).toBeUndefined()
    }
  }
)

it("real interactive Squad start leaves teammate plugin children free to request their modes", async () => {
  const { startSquadRun } = await import("@/lib/squads/squad/start-squad-run")
  const { runTeamLifecycle } = await import("@/lib/squads/agent-team-runtime")
  const { useAgentTeamStore } = await import("@/stores/squads/agent-team-store")
  workspaceFixture = true
  const team = {
    id: "real-start-team",
    projectId: "matrix-project",
    name: "Real start",
    description: "",
    task: "Read",
    status: "idle",
    leadId: "real-lead",
    teammateIds: ["real-worker"],
    taskIds: ["real-task"],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(),
    config: {
      maxTeammates: 1,
      maxConcurrentTeammates: 1,
      executionMode: "coordinated",
      displayMode: "expanded",
      repositories: [{ id: "repo", role: "primary", path: "/matrix", writable: true }],
      environmentRef: { environmentId: "matrix-env", versionId: "matrix-env:1" },
      defaultPermissionMode: "default",
      tools: ["Read"],
      defaultMaxSteps: 10,
      requirePlanApproval: false,
      evidencePolicy: {
        requireOutcome: false,
        requireActivity: false,
        requireCodeDiff: false,
        requireVerification: false,
        requireVisualForUi: false,
      },
    },
  } as AgentTeam
  const worker = {
    id: "real-worker",
    teamId: team.id,
    name: "Reader",
    description: "Read",
    role: "teammate",
    status: "idle",
    config: { runtime: "claude", tools: ["Read"] },
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
  } as AgentTeammate
  const task = {
    id: "real-task",
    teamId: team.id,
    title: "Read",
    description: "Read the task",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    order: 0,
    createdAt: new Date(),
  } as import("@/types/agent/agent-team").AgentTeamTask
  await getDb().projectEnvironmentVersions.put({
    id: "matrix-env:1",
    environmentId: "matrix-env",
    projectId: "matrix-project",
    version: 1,
    name: "Matrix",
    setupScript: { default: "" },
    actions: [],
    variables: {},
    keyringReferences: [],
    policy: { requiredRuntimeCapabilities: [] },
    createdAt: 1,
  })
  useAgentTeamStore.setState({
    teams: { [team.id]: team },
    teammates: { [worker.id]: worker },
    tasks: { [task.id]: task },
  })
  let invoked = false
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async (id, _prompt, options, cap) => {
    await cap?.beforeSend?.()
    cap?.onExecutorAccepted?.(id)
    cap?.onExecutorStarted?.(Promise.resolve())
    if (!invoked) {
      invoked = true
      expect(options?.permissionMode).toBe("default")
      const parent = (await getDb().executionRuns.toArray()).find(
        (row) => row.sessionId === id && row.parentRunId === "execution:team:real-start-run"
      )!
      expect(parent).toBeDefined()
      await withPluginExecutionContext(
        "real-squad-plugin",
        { executionRunId: parent.id, sessionId: id },
        () =>
          runPluginAgent(
            "Work",
            { toolsEnabled: true, characterId: character.id },
            { pluginId: "real-squad-plugin" }
          )
      )
      await runPluginAgentTurn(
        {
          characterId: character.id,
          prompt: "Work",
          cwd: "/matrix",
          permissionMode: "acceptEdits",
        },
        { parentRunId: parent.id, grantSource: { kind: "plugin", id: "real-squad-plugin" } }
      )
    }
    return {
      text: "done",
      resultSubtype: "success",
      messageId: crypto.randomUUID(),
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }
  })
  let lifecycle: Promise<unknown> | undefined
  const store = useAgentTeamStore.getState()
  const result = await startSquadRun(
    {
      squadId: team.id,
      runId: "real-start-run",
      goal: "Read",
      origin: "interactive",
      triggeredFrom: { source: "chat" },
    },
    {
      awaitRuntimeReady: async () => true,
      loadStore: async () => ({
        getTeam: (id) => useAgentTeamStore.getState().teams[id],
        getTeammates: () => [worker],
        getTeamTasks: () => [task],
        updateTeam: store.updateTeam,
      }),
      evaluateReadiness: async () => ({ ready: true, blockers: [], evaluatedAt: 1 }),
      findLiveRun: async () => undefined,
      runLifecycle: (input) =>
        (lifecycle = runTeamLifecycle(input.teamId, {
          runId: input.runId,
          storeReader: {
            getTeam: (id) => useAgentTeamStore.getState().teams[id],
            getTeammates: () => [worker],
            getTeamTasks: () => [task],
          },
          storeWriter: {
            addMessage: store.addMessage,
            setTaskStatus: store.setTaskStatus,
            updateTeammate: store.updateTeammate,
          },
          parentPermissionCeiling: input.permissionCeiling,
          notifierDeps: { toast: () => {}, osNotify: async () => {}, log: async () => {} },
        })),
    }
  )
  expect(result.started).toBe(true)
  const completed = await lifecycle
  expect(completed).toMatchObject({ runId: "real-start-run", status: "completed" })
  expect(invoked).toBe(true)
  expect(
    (await getDb().executionRuns.get("execution:team:real-start-run"))?.authority?.permissionMode
  ).toBeUndefined()
  expect([
    ...modelSends.map((send) => send.options.permissionMode),
    ...jest.mocked(runAndCaptureAssistantReply).mock.calls.map((call) => call[2]?.permissionMode),
  ]).toEqual(expect.arrayContaining(["bypassPermissions", "acceptEdits"]))
})

it("deferred turns fence their own marked or missing run at option-build time", async () => {
  const { sandboxSessionRuntime } = await import("@/lib/sandbox/session-runtime")
  const bind = jest.spyOn(sandboxSessionRuntime, "bindSession")
  await ensureDirectChatExecutionRun({ sessionId: session.id, runId: "deferred-private" })
  await getDb().executionRuns.update("deferred-private", {
    personalMarks: [{ person: { kind: "local-person" }, source: "M6", markedAt: 1 }],
  })
  try {
    for (const runId of ["deferred-private", "deferred-missing"]) {
      const options = await resolveSendOptions({
        session: { ...session, sandboxEnabled: true },
        character: { ...character, sandboxEnabled: true, sandboxPolicy: { network: "on" } },
        appSettings: await (await import("@/lib/db/settings")).getSettings(),
        deferredExecutionRun: {},
        executionIdentity: { runId },
        preloadedEnv: {},
        preloadedMcpServers: [],
      })
      expect(options.personalEgressFenced).toBe(true)
      expect(bind).toHaveBeenLastCalledWith(
        expect.objectContaining({
          executionRunId: runId,
          policy: expect.objectContaining({ network: "off" }),
        })
      )
    }
  } finally {
    bind.mockRestore()
  }
})

it("team subagent selection applies to the run without becoming a descendant cap", async () => {
  await getDb().executionRuns.update("matrix-parent", { authority: undefined })
  const options = await resolveSendOptions({
    session: { ...session, kind: "team" },
    character,
    appSettings: await (await import("@/lib/db/settings")).getSettings(),
    executionIdentity: { runId: "matrix-parent" },
    subagentIds: ["workflow-designer"],
    preloadedEnv: {},
    preloadedMcpServers: [],
  })
  expect(Object.keys(options.agents ?? {})).toEqual(["workflow-designer"])
  expect(options.runAuthority?.subagents).toBeUndefined()
  expect((await getDb().executionRuns.get("matrix-parent"))?.authority?.subagents).toBeUndefined()
})

it("a side chat applies parent surface permission but inherits only the parent's explicit run caps", async () => {
  const { recordResolvedPermissionCeiling, clearResolvedPermissionCeiling } =
    await import("@/lib/ai/agent/execution/delegation/dispatch-context-registry")
  recordResolvedPermissionCeiling(session.id, {
    permissionMode: "plan",
    allowedTools: ["A"],
    disallowedTools: ["B"],
  })
  const aside: ChatSession = {
    ...session,
    id: "r11-aside",
    kind: "resource-workbench",
    surfaceBinding: { kind: "session", sessionId: session.id },
    asideWriteAccess: true,
  }
  await getDb().sessions.put(aside)
  const run = await ensureDirectChatExecutionRun({
    sessionId: aside.id,
    runId: "r11-aside-turn",
    parentRunId: "matrix-parent",
  })
  try {
    const options = await build(run.id, aside)
    expect(options.permissionMode).toBe("plan")
    expect(options.runAuthority).toEqual(narrow)
    expect(options.runAuthority?.permissionMode).toBe("default")
    expect(options.runAuthority?.tools?.deny).not.toContain("B")
  } finally {
    clearResolvedPermissionCeiling(session.id)
  }
})

it("pre-upgrade observed surfaces do not cap the real child options", async () => {
  const { caps: _caps, ...legacy } = narrow
  await getDb().executionRuns.update("matrix-parent", {
    authority: legacy,
  })
  const run = await startToolExecutionRun(session.id, { parentRunId: "matrix-parent" })
  const options = await build(run.id)
  await getDb().executionRuns.update("matrix-parent", { authority: undefined })
  const control = await startToolExecutionRun(session.id, { parentRunId: "matrix-parent" })
  const controlOptions = await build(control.id)
  for (const field of [
    "permissionMode",
    "allowedTools",
    "disallowedTools",
    "mcpServers",
    "maxTurns",
    "permissionProfile",
    "agents",
  ] as const)
    expect(options[field]).toEqual(controlOptions[field])
  expect(options.runAuthority?.caps).toBe("explicit-v1")
})

it("a non-thread deferred typed turn uses its own readers, sandbox binding, spec and handle despite another active run", async () => {
  const { buildSendOptions } = await import("@/hooks/chat/claude-chat-send-options")
  const { useProjectStore } = await import("@/stores/project/project-store")
  useProjectStore.setState({ projects: [], activeProjectId: null })
  const { sandboxSessionRuntime } = await import("@/lib/sandbox/session-runtime")
  const { createAgentExecutionHandle } =
    await import("@/lib/ai/agent/execution/agent-execution-handle")
  const { computeExecutionFingerprint } = await import("@/lib/ai/agent/execution/fingerprint")
  const typed = await startToolExecutionRun(session.id, {
    runId: "r11-typed",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const sibling = await startToolExecutionRun(session.id, { runId: "r11-other" })
  sibling.actingIdentity!.lane = "service"
  await getDb().executionRuns.put(sibling)
  const history = jest.mocked(preparePersonalDerivedHistory)
  history.mockClear()
  const bind = jest.spyOn(sandboxSessionRuntime, "bindSession")
  const specs: import("@cognia/agent-config-types/agent-execution").ResolvedAgentExecutionSpec[] =
    []
  try {
    const options = await buildSendOptions(
      {
        ...session,
        sandboxEnabled: true,
        branchSeed: { kind: "summary", content: "Branch context" },
      },
      "typed turn",
      (spec) => specs.push(spec),
      { runId: typed.id, turnId: "r11-turn", attemptId: "a7" },
      undefined,
      { deferExecutionRun: true, localAuthorization: LOCAL_PERSON_RUN },
      { runtimeRef: { kind: "builtin" }, character: { ...character, sandboxEnabled: true } }
    )
    const index = history.mock.calls.findIndex((call) => call[1][0]?.id === "branch-seed")
    expect(index).toBeGreaterThanOrEqual(0)
    expect(history.mock.calls[index][2]?.executionRunId).toBe(typed.id)
    expect((await history.mock.results[index].value).readers).toEqual([{ kind: "local-person" }])
    expect(bind).toHaveBeenLastCalledWith(expect.objectContaining({ executionRunId: typed.id }))
    const spec = specs.at(-1)!
    expect(spec.identity).toMatchObject({
      sessionId: session.id,
      runId: typed.id,
      turnId: "r11-turn",
      attemptId: "a7",
    })
    expect(options.execution?.identity).toEqual({ runId: typed.id, attemptId: "a7" })
    expect(spec.executionFingerprint).toBe(computeExecutionFingerprint(spec))
    expect(spec.executionFingerprint).not.toBe(
      computeExecutionFingerprint({ ...spec, identity: { ...spec.identity, runId: session.id } })
    )
    const handle = createAgentExecutionHandle(session.id, spec)
    expect(handle.spec).toBe(spec)
    expect(handle.spec.identity.runId).toBe(typed.id)
  } finally {
    history.mockClear()
    bind.mockRestore()
  }
})

it("a pruned workflow retry reapplies its own node caps without recording the connector ceiling", async () => {
  const definition = workflow()
  definition.nodes[0].data.params = {
    ...workflowContext().params,
    permissionCap: "acceptEdits",
    allowedTools: ["A", "B"],
    maxTurns: 4,
  }
  const result = await runWorkflow({
    workflow: definition,
    trigger: workflowContext().trigger,
    runId: "r11-pruned-retry",
    lineage: { rootRunId: "gone", retryOfRunId: "gone", retryMode: "current-deployment" },
    securityContext: {
      piiEgressRequired: true,
      sourceTriggerKind: "trigger.connector.inbound",
      permissionCeiling: { permissionMode: "plan", disallowedTools: ["B"] },
    },
  })
  expect(result.status).toBe("succeeded")
  const root = await getDb().executionRuns.get("execution:workflow:r11-pruned-retry")
  expect(root?.parentRunId).toBeUndefined()
  expect(root?.authority).toBeUndefined()
  const options =
    jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)?.[2] ?? modelSends.at(-1)?.options
  expect(options?.permissionMode).toBe("plan")
  expect(options?.disallowedTools).toContain("B")
  expect(options?.runAuthority).toMatchObject({
    caps: "explicit-v1",
    permissionMode: "acceptEdits",
  })
  expect(options?.maxTurns).toBe(4)
  expect(options?.runAuthority?.maxTurns).toBeUndefined()
  expect(options?.runAuthority?.tools?.deny).not.toContain("B")
})

it("deferred turns retain sandbox consumers and plugin hook provenance until personal marks fence them", async () => {
  const { sandboxSessionRuntime } = await import("@/lib/sandbox/session-runtime")
  const { getPluginEventHooks } = await import("@/lib/plugin/messaging/hooks-system")
  const hooks = getPluginEventHooks()
  const hook = jest.spyOn(hooks, "dispatchBuildOptions")
  const bind = jest.spyOn(sandboxSessionRuntime, "bindSession")
  try {
    const options = await resolveSendOptions({
      session: { ...session, sandboxEnabled: true },
      character: { ...character, sandboxEnabled: true },
      appSettings: await (await import("@/lib/db/settings")).getSettings(),
      deferredExecutionRun: {},
      executionIdentity: { runId: "deferred-marked-turn" },
      preloadedEnv: {},
      preloadedMcpServers: [],
    })
    expect(bind).toHaveBeenCalledWith(
      expect.objectContaining({ executionRunId: "deferred-marked-turn" })
    )
    expect(hook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ executionRunId: "deferred-marked-turn" })
    )
    await ensureDirectChatExecutionRun({ sessionId: session.id, runId: "deferred-marked-turn" })
    await getDb().executionRuns.update("deferred-marked-turn", {
      personalMarks: [{ person: { kind: "local-person" }, source: "L4", markedAt: 1 }],
    })
    await expect(
      sandboxSessionRuntime.executeSandbox(options.sandboxRuntimeRef!, {} as never)
    ).rejects.toMatchObject({ code: "personal-egress-denied" })
  } finally {
    bind.mockRestore()
    hook.mockRestore()
  }
})

it.each([false, true])(
  "workflow own maxTurns is not a descendant cap; explicit permission cap=%s",
  async (explicit) => {
    await workflowParent()
    await getDb().executionRuns.update("execution:workflow:matrix-workflow", {
      authority: undefined,
    })
    await runAgentTurn({
      ...workflowContext(),
      params: {
        prompt: "Work",
        characterId: character.id,
        allowedTools: [],
        maxTurns: 5,
        ...(explicit ? { permissionCap: "acceptEdits" } : {}),
      },
    })
    const options = jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]!
    expect(options.maxTurns).toBe(5)
    expect(options.allowedTools).toEqual(expect.arrayContaining(["A", "B"]))
    expect(options.runAuthority?.tools?.allow).toBeUndefined()
    expect(options.runAuthority?.maxTurns).toBeUndefined()
    expect(options.runAuthority?.permissionMode).toBe(explicit ? "acceptEdits" : undefined)
    const own = (await getDb().executionRuns.toArray()).find(
      (row) => row.id === options.execution?.identity.runId
    )!
    const descendant = await startToolExecutionRun(undefined, { parentRunId: own.id })
    expect((await resolveRunAuthority({ runId: descendant.id })).inheritedAuthority?.maxTurns).toBe(
      undefined
    )
  }
)

it("journal recovery reapplies the prior effective caps at the real dispatch options builder", async () => {
  const { registerSubagent } = await import("@/lib/plugin/registries/subagent-registry")
  const { resolveCaller } = await import("@/lib/ai/agent/execution/delegation/dispatch-run")
  registerSubagent("r13-recovery", {
    id: "r13-recovery",
    name: "Recovery",
    description: "Recovery",
    prompt: "Work",
    tools: ["A", "B"],
    maxTurns: 20,
  })
  const initial = await startDispatchRun({
    subagentId: "r13-recovery",
    prompt: "Work",
    toolsEnabled: true,
    background: false,
    parentSessionId: session.id,
    executionRunId: "matrix-parent",
    caller: await resolveCaller(session.id),
  })
  expect(initial.error).toBeUndefined()
  await getDb().executionRuns.delete("matrix-parent")
  jest.mocked(runAndCaptureAssistantReply).mockClear()
  const resumed = await startDispatchRun({
    subagentId: "r13-recovery",
    prompt: "Continue",
    toolsEnabled: true,
    background: false,
    parentSessionId: session.id,
    resumeOfRunId: initial.runId,
    caller: await resolveCaller(session.id),
  })
  expect(resumed.error).toBeUndefined()
  const row = await getDb().executionRuns.get(`execution:job:${resumed.runId}`)
  expect(row?.parentRunId).toBeUndefined()
  expect(row?.authority).toEqual(narrow)
  const options = jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]!
  expect(options.maxTurns).toBe(3)
  expect(options.allowedTools).toEqual(["A"])
  expect(options.permissionMode).toBe(narrow.permissionMode)
  expect(options.runAuthority).toEqual(row!.authority)
})

it.each([
  ["run", false, false],
  ["session", false, false],
  ["run", true, false],
  ["session", true, false],
  ["run", false, true],
  ["session", false, true],
  ["workflow", false, false],
  ["workflow", false, true],
] as const)(
  "deferred build hooks can launch plugin %s; admitted=%s known parent=%s",
  async (kind, admitted, knownParent) => {
    const { getPluginEventHooks } = await import("@/lib/plugin/messaging/hooks-system")
    const { createPluginAgentSession } = await import("@/lib/plugin/agent-sdk/session")
    const hooks = getPluginEventHooks()
    let launched = false
    const hook = jest
      .spyOn(hooks, "dispatchBuildOptions")
      .mockImplementation(async (options, context) => {
        if (options.sessionId === session.id) {
          expect(context?.executionRunId).toBe("reserved-hook-turn")
          expect(context?.executionRunReserved).toBe(true)
          expect(await getDb().executionRuns.get("reserved-hook-turn")).toBeUndefined()
          if (admitted)
            await ensureDirectChatExecutionRun({
              sessionId: session.id,
              runId: "reserved-hook-turn",
              parentRunId: "matrix-parent",
            })
          await withPluginExecutionContext("reserved-hook-plugin", context!, async () => {
            if (kind === "run")
              await runPluginAgent(
                "Work",
                { toolsEnabled: true },
                { pluginId: "reserved-hook-plugin" }
              )
            else if (kind === "workflow") {
              const { createWorkflow } = await import("@/lib/db/workflows")
              const { publishWorkflow } = await import("@/lib/workflow/publish/publish-workflow")
              const { createWorkflowAuthorAPI } =
                await import("@/lib/plugin/api/workflow-author-api")
              const definition = workflow()
              const wf = await createWorkflow({
                name: "Hook workflow",
                nodes: definition.nodes,
                edges: definition.edges,
                settings: definition.settings,
              })
              await publishWorkflow(wf.id, 1)
              const result = await createWorkflowAuthorAPI(
                "reserved-hook-plugin"
              ).executeRunWorkflowTyped({ name: wf.id, input: {} })
              expect(result).toMatchObject({ ok: true })
              if (result.ok) {
                const row = await getDb().executionRuns.get(`execution:workflow:${result.runId}`)
                expect(row?.parentRunId).toBe(knownParent ? "matrix-parent" : undefined)
                expect(row?.authority).toEqual(knownParent ? narrow : undefined)
              }
            } else
              await (
                await createPluginAgentSession(
                  { characterId: character.id },
                  "reserved-hook-plugin"
                )
              ).send("Work")
          })
          launched = true
        }
        return options
      })
    try {
      await resolveSendOptions({
        session,
        character,
        deferredExecutionRun: knownParent ? { parentRunId: "matrix-parent" } : {},
        executionIdentity: { runId: "reserved-hook-turn" },
        preloadedEnv: {},
        preloadedMcpServers: [],
      }).catch((error) => {
        throw new Error(
          `deferred ${kind} admitted=${admitted} known=${knownParent}: ${String(error?.stack ?? error)}`,
          { cause: error }
        )
      })
      expect(launched).toBe(true)
      if (kind === "workflow") {
        if (knownParent) await assertTransport()
      } else if (kind === "run" || admitted || knownParent) {
        expect(persistedAtSend.length).toBeGreaterThan(0)
        expect(persistedAtSend.at(-1)?.parentRunId).toBe(
          admitted ? "reserved-hook-turn" : knownParent ? "matrix-parent" : undefined
        )
        if (admitted || knownParent) expect(persistedAtSend.at(-1)?.authority).toEqual(narrow)
      } else {
        expect(jest.mocked(runAndCaptureAssistantReply)).toHaveBeenCalled()
        expect(
          jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]?.inheritedRunAuthority
        ).toBeUndefined()
      }
    } finally {
      hook.mockRestore()
    }
  }
)

it("a typed desktop turn offers its OAuth HTTP server before acceptance while retaining its reserved identity", async () => {
  const { buildSendOptions } = await import("@/hooks/chat/claude-chat-send-options")
  const { chatHookCredentialContext } = await import("@/hooks/chat/use-claude-chat-controller")
  const { admitPersonalCredential } = await import("./personal-credential")
  const { useProjectStore } = await import("@/stores/project/project-store")
  useProjectStore.setState({ projects: [], activeProjectId: null })
  await getDb().mcpServers.put({
    id: "r12-oauth",
    name: "personal-oauth",
    enabled: true,
    transport: "http",
    config: { url: "https://oauth.example.test/mcp" },
    createdAt: 1,
    updatedAt: 1,
  })
  const before = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__")
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  try {
    const options = await buildSendOptions(
      { ...session, characterId: undefined },
      "hello",
      undefined,
      { runId: "r12-reserved", turnId: "r12-typed", attemptId: "a1" },
      undefined,
      { deferExecutionRun: true, localAuthorization: LOCAL_PERSON_RUN }
    )
    expect(options.mcpServers?.["personal-oauth"]).toMatchObject({
      type: "http",
      headers: { Authorization: "Bearer r12-fixture-token" },
    })
    expect(options.execution?.identity?.runId).toBe("r12-reserved")
    expect(await getDb().executionRuns.get("r12-reserved")).toBeUndefined()
    for (const branch of [undefined, "coordinator-parent"]) {
      const context = await chatHookCredentialContext(
        session.id,
        "r12-reserved",
        LOCAL_PERSON_RUN,
        branch
      )
      expect(await admitPersonalCredential(context, { source: "mcp-oauth" })).toMatchObject({
        ok: true,
      })
      expect(context).not.toHaveProperty("executionRunId")
    }
  } finally {
    if (before) Object.defineProperty(window, "__TAURI_INTERNALS__", before)
    else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
})

it.each(["legacy-paired", "receipt-less-host-state"])(
  "%s drops an empty dispatch id and builds session-distinct execution identities",
  async () => {
    const { buildSendOptions } = await import("@/hooks/chat/claude-chat-send-options")
    const { useProjectStore } = await import("@/stores/project/project-store")
    useProjectStore.setState({ projects: [], activeProjectId: null })
    const runIds: string[] = []
    for (const id of ["r12-paired-a", "r12-paired-b"]) {
      const paired = { ...session, id }
      await getDb().sessions.put(paired)
      const options = await buildSendOptions(paired, "hello", undefined, undefined, undefined, {
        executionRunId: "",
      })
      expect(options.execution?.identity?.runId).toBe(id)
      runIds.push(options.execution!.identity!.runId)
    }
    expect(new Set(runIds).size).toBe(2)
    expect(await getDb().executionRunEvents.where("runId").equals("").count()).toBe(0)
  }
)

it("teammate own subagent selection and inherited caps both keep bare plugin reviewer ids", async () => {
  const { registerSubagent, unregisterSubagentsByPlugin } =
    await import("@/lib/plugin/registries/subagent-registry")
  registerSubagent(
    "reviewer",
    { id: "reviewer", name: "Reviewer", description: "review", prompt: "Review" },
    { pluginId: "r12-p" }
  )
  registerSubagent(
    "writer",
    { id: "writer", name: "Writer", description: "write", prompt: "Write" },
    { pluginId: "r12-p" }
  )
  try {
    await getDb().executionRuns.update("matrix-parent", {
      authority: {
        schemaVersion: 1,
        caps: "explicit-v1",
        subagents: { only: ["reviewer"] },
      },
    })
    const run = await child()
    const options = await resolveSendOptions({
      session,
      character,
      executionIdentity: { runId: run.id },
      subagentIds: ["reviewer"],
      preloadedEnv: {},
      preloadedMcpServers: [],
    })
    expect(Object.keys(options.agents ?? {})).toEqual(["r12-p:reviewer"])
    const context = await teamContext()
    context.team.config.capabilities = { subagentIds: ["reviewer"] }
    await dispatchTeammate(context, {
      taskId: "r12-review",
      prompt: "Review the change",
      access: "read",
      validateOutput: false,
    })
    const dispatched = jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]!
    expect(Object.keys(dispatched.agents ?? {})).toEqual(["r12-p:reviewer"])
  } finally {
    unregisterSubagentsByPlugin("r12-p")
  }
})

it("a typed service-coordinator thread retains local OAuth credential admission", async () => {
  const { buildSendOptions } = await import("@/hooks/chat/claude-chat-send-options")
  await getDb().mcpServers.put({
    id: "typed-oauth",
    name: "typed-oauth",
    enabled: true,
    transport: "http",
    config: { url: "https://oauth.example.test/mcp" },
    createdAt: 1,
    updatedAt: 1,
  })
  const parent = await getDb().executionRuns.get("matrix-parent")
  await getDb().executionRuns.update("matrix-parent", {
    authority: undefined,
    actingIdentity: { ...parent!.actingIdentity!, lane: "service" },
  })
  const row = await ensureDirectChatExecutionRun({
    sessionId: session.id,
    runId: "typed-thread-child",
    parentRunId: "matrix-parent",
  })
  expect(row.actingIdentity?.lane).toBe("service")
  const before = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__")
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  try {
    const options = await buildSendOptions(
      {
        ...session,
        characterId: undefined,
        projectThread: { parentExecutionRunId: "matrix-parent" },
      } as ChatSession,
      "hello",
      undefined,
      { runId: row.id, turnId: "typed-turn", attemptId: "a1" },
      undefined,
      { executionRunId: row.id, localAuthorization: LOCAL_PERSON_RUN }
    )
    expect(options.mcpServers?.["typed-oauth"]).toMatchObject({
      type: "http",
      headers: { Authorization: "Bearer r12-fixture-token" },
    })
    expect(options.execution?.identity.runId).toBe(row.id)
  } finally {
    if (before) Object.defineProperty(window, "__TAURI_INTERNALS__", before)
    else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
})

it.each([false, true])(
  "cross-project typed workflow and subworkflow retain explicit caps=%s",
  async (explicit) => {
    const { createWorkflow } = await import("@/lib/db/workflows")
    const { publishWorkflow } = await import("@/lib/workflow/publish/publish-workflow")
    const { toolFamily, WORKFLOW_RUNNER_TOOL_NAME } = await import("@/lib/workflow/agent-tools")
    const scope = await import("@/lib/db/project-scope")
    const definition = workflow()
    const w2 = await createWorkflow({
      name: "Project C agent",
      nodes: definition.nodes,
      edges: [],
      settings: definition.settings,
    })
    const w1 = await createWorkflow({
      name: "Project B caller",
      nodes: [
        {
          id: "sub",
          type: "flow.subworkflow",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Nested", params: { workflowId: w2.id } },
        },
      ],
      edges: [],
      settings: definition.settings,
    })
    await publishWorkflow(w2.id, 1)
    await publishWorkflow(w1.id, 1)
    if (!explicit) await getDb().executionRuns.update("matrix-parent", { authority: undefined })
    const previousDeployments = process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
    process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = "0"
    const project = jest
      .mocked(scope.resolveScopeProjectId)
      .mockResolvedValueOnce("project-b")
      .mockResolvedValueOnce("project-c")
    try {
      const result = (await toolFamily.run(WORKFLOW_RUNNER_TOOL_NAME, { name: w1.id, input: {} }, {
        executionRunId: "matrix-parent",
        sessionId: session.id,
      } as never)) as { ok: boolean; runId: string }
      expect(result).toMatchObject({ ok: true })
      const rows = await getDb().workflowRuns.toArray()
      const childSource = rows.find((row) => row.workflowId === w2.id)!
      expect(childSource.projectId).toBe("project-c")
      const caller = await getDb().executionRuns.get(`execution:workflow:${result.runId}`)
      expect(caller).toMatchObject({ projectId: "project-b", parentRunId: "matrix-parent" })
      const child = await getDb().executionRuns.get(`execution:workflow:${childSource.id}`)
      expect(child?.parentRunId).toBeUndefined()
      expect(child?.actingIdentity?.rootRunId).toBe(child?.id)
      expect(child?.authority).toEqual(explicit ? narrow : undefined)
      const options = jest.mocked(runAndCaptureAssistantReply).mock.calls.at(-1)![2]!
      expect(options.allowedTools).toEqual(explicit ? ["A"] : ["A", "B"])
      if (explicit) await assertTransport()
    } finally {
      if (previousDeployments === undefined)
        delete process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
      else process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = previousDeployments
      project.mockImplementation(jest.requireActual("@/lib/db/project-scope").resolveScopeProjectId)
    }
  }
)

it.each([
  ["goal", false],
  ["goal", true],
  ["loop", false],
  ["plan", true],
  ["background", false],
  ["chat-error", false],
  ["chat-error", true],
  ["local-person", true],
  // A deleted captured coordinator keeps the observed-root exception.
  ["goal", "missing"],
  ["chat-error", "missing"],
] as const)(
  "reserved %s hooks launch ctx.agent.run with Host-known parent %s",
  async (branch, knownParent) => {
    const { chatHookCredentialContext } = await import("@/hooks/chat/use-claude-chat-controller")
    const { createPluginContext } = await import("@/lib/plugin/core/context")
    const { preloadModulePluginApis } = await import("@/lib/plugin/core/module-plugin-api")
    const { getPluginEventHooks, getPluginLifecycleHooks } =
      await import("@/lib/plugin/messaging/hooks-system")
    const { initializePluginPermissions, revokePluginPermissions } =
      await import("@/lib/plugin/api/permission-api")
    const { getPermissionGuard } = await import("@/lib/plugin/security/permission-guard")
    const { usePluginStore } = await import("@/stores/plugin-runtime")
    const pluginId = `r15-${branch}`
    const before = usePluginStore.getState().plugins
    const plugin = {
      manifest: {
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        type: "frontend",
        capabilities: ["hooks"],
        permissions: ["agent:control"],
      },
      status: "enabled",
      source: "local",
      path: "/fixture",
      config: {},
      hooks: {},
    } as unknown as import("@/types/plugin").Plugin
    await preloadModulePluginApis()
    const ctx = createPluginContext(plugin, {
      createPluginServicesAPI: () => ({ isAvailable: () => false, getProvider: () => undefined }),
      getPlugin: () => plugin,
      getPluginPointGovernanceMode: () => "warn",
    } as unknown as import("@/lib/plugin/core/manager").PluginManager)
    initializePluginPermissions(pluginId, ["agent:control"])
    getPermissionGuard().registerPlugin(pluginId, ["agent:control"])
    let complete!: () => void
    let fail!: (error: unknown) => void
    const completion = new Promise<void>((resolve, reject) => {
      complete = resolve
      fail = reject
    })
    const launch = async () => {
      try {
        await ctx.agent.run("Perform the task.", { toolsEnabled: true, allowedTools: ["A", "B"] })
        complete()
      } catch (error) {
        fail(error)
        throw error
      }
    }
    const hooks: import("@/types/plugin/plugin-hooks").PluginHooksAll =
      branch === "chat-error"
        ? { onChatError: launch }
        : {
            onUserPromptSubmit: async () => {
              await launch()
              return { action: "block" as const, reason: "probe-complete" }
            },
          }
    plugin.hooks = hooks
    usePluginStore.setState({ plugins: { ...before, [pluginId]: plugin } })
    getPluginLifecycleHooks().registerHooks(pluginId, hooks)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const context = await chatHookCredentialContext(
        session.id,
        "r15-unadmitted",
        branch === "local-person" ? LOCAL_PERSON_RUN : undefined,
        knownParent === true
          ? "matrix-parent"
          : knownParent === "missing"
            ? "deleted-coordinator"
            : undefined
      )
      expect(context.executionRunReserved).toBe(true)
      expect(await getDb().executionRuns.get("r15-unadmitted")).toBeUndefined()
      const events = getPluginEventHooks()
      if (branch === "chat-error")
        events.dispatchChatError(session.id, new Error("before dispatch"), context)
      else
        expect(
          await events.dispatchUserPromptSubmit("continue", session.id, {} as never, context)
        ).toMatchObject({ action: "block", reason: "probe-complete" })
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("hook launch did not complete")), 1000)
        }),
      ])
      expect(persistedAtSend.at(-1)?.parentRunId).toBe(
        knownParent === true ? "matrix-parent" : undefined
      )
      expect(persistedAtSend.at(-1)?.authority).toEqual(
        knownParent === true ? narrow : { schemaVersion: 1, caps: "explicit-v1" }
      )
      if (knownParent === true) await assertTransport()
    } finally {
      if (timeout) clearTimeout(timeout)
      getPluginLifecycleHooks().unregisterHooks(pluginId)
      usePluginStore.setState({ plugins: before })
      revokePluginPermissions(pluginId)
      getPermissionGuard().unregisterPlugin(pluginId)
    }
  }
)

it.each(["blocked", "marked-source", "missing-unreserved", "admitted-marked"])(
  "typed workflow reservation keeps the personal egress gate: %s",
  async (kind) => {
    const { createWorkflowAuthorAPI } = await import("@/lib/plugin/api/workflow-author-api")
    const { addPersonalMarksToRun } = await import("./personal-marks")
    const { bindPersonalOperationSources } = await import("./personal-operation")
    const producer = await startToolExecutionRun(undefined)
    await addPersonalMarksToRun({ executionRunId: producer.id }, [
      { person: { kind: "local-person" }, source: "fixture", markedAt: 1 },
    ])
    const context: import("./personal-credential").PersonalCredentialContext = {
      executionRunId: kind === "admitted-marked" ? producer.id : "r15-unadmitted",
      ...(kind !== "missing-unreserved" ? { executionRunReserved: true } : {}),
      ...(kind === "blocked" ? { personalEgressBlocked: true } : {}),
    }
    if (kind === "marked-source")
      bindPersonalOperationSources(context, [{ executionRunId: producer.id }])
    await expect(
      withPluginExecutionContext("r15-gated", context, () =>
        createWorkflowAuthorAPI("r15-gated").executeRunWorkflowTyped({ name: "unused" })
      )
    ).rejects.toMatchObject({ code: "personal-egress-denied" })
    expect(await getDb().workflowRuns.count()).toBe(0)
    expect(jest.mocked(runAndCaptureAssistantReply)).not.toHaveBeenCalled()
  }
)
