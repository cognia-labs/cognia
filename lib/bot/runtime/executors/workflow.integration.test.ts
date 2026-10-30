/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import { installBot } from "@/lib/db/bot-installations"
import { _seedTriggerSubscriptionsForTest } from "@/lib/workflow/runtime/trigger-subscriptions"
import { drainBotDeliveries } from "@/lib/bot/runtime/delivery-runner"
import { createWorkflow, updateWorkflow } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import { dispatchWorkflowCompletedToBots } from "@/lib/bot/sources/workflow-completed"
import type { PluginBotDef } from "@/types/plugin/plugin-bot"

jest.mock("@/lib/bot/schedule/reconcile-timed-triggers", () => ({
  syncBotTriggerSchedules: jest.fn(),
  removeBotTriggerSchedules: jest.fn(),
}))
// Host capability is environmental; keep all routing, admission, orchestration,
// completion and persistence code real. No live model or external request.
jest.mock("@/lib/workflow/runtime/capability-preflight", () => ({
  ...jest.requireActual("@/lib/workflow/runtime/capability-preflight"),
  preflightCapabilities: () => [],
  remoteCapabilityUnion: async () => [],
}))
jest.mock("@/lib/workflow/runtime/run-title", () => ({
  generateWorkflowRunTitle: async () => null,
}))
const mockExecuteAgentTurn = jest.fn(async (..._args: unknown[]) => ({
  text: "stub",
  channel: "agent",
  toolsAvailable: true,
}))
jest.mock("@/lib/ai/agent/execution/agent-execution-service", () => ({
  executeAgentTurn: (...args: unknown[]) => mockExecuteAgentTurn(...args),
  AgentHostUnavailableError: class extends Error {},
}))

jest.mock("@/lib/bot/sources/workflow-completed", () => {
  const actual = jest.requireActual("@/lib/bot/sources/workflow-completed")
  return {
    ...actual,
    dispatchWorkflowCompletedToBots: jest.fn(actual.dispatchWorkflowCompletedToBots),
  }
})
const NOW = 1_700_000_000_000
jest.setTimeout(30000)
beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  _seedTriggerSubscriptionsForTest([])
  const db = getDb()
  await Promise.all([
    db.botInstallations.clear(),
    db.botEventDeliveries.clear(),
    db.botRunSteps.clear(),
    db.executionRuns.clear(),
    db.executionRunEvents.clear(),
    db.workflowRuns.clear(),
  ])
  jest.mocked(dispatchWorkflowCompletedToBots).mockClear()
  mockExecuteAgentTurn.mockClear()
})
async function workflowBot(withAgent = false) {
  const workflow = await createWorkflow({
    name: "Review workflow",
    nodes: [
      {
        id: "cycle",
        type: "trigger.integration.event",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Start", params: {} },
      },
      ...(withAgent
        ? [
            {
              id: "agent",
              type: "action.agent.turn",
              typeVersion: 1,
              position: { x: 100, y: 0 },
              data: {
                label: "Agent",
                params: {
                  prompt: "inspect",
                  permissionCap: "acceptEdits",
                },
              },
            },
          ]
        : []),
    ] as NonNullable<Parameters<typeof createWorkflow>[0]["nodes"]>,
    edges: withAgent ? [{ id: "edge", source: "cycle", target: "agent" }] : [],
  })
  await updateWorkflow(workflow.id, { settings: { ...workflow.settings, riskGating: false } })
  await publishWorkflow(workflow.id, Date.now())
  const definition = {
    id: "workflow",
    name: "Workflow Bot",
    version: "1",
    executor: "workflow",
    workflow: workflow.id,
    triggers: [{ id: "cycle", kind: "event", source: "workflow", types: ["workflow.succeeded"] }],
    policy: { allowSelfTriggering: false, maxAuthority: "plan", maxAutonomy: "act" },
  } as PluginBotDef
  registerBot("workflow", { id: "review:workflow", definition }, { pluginId: "review" })
  const installation = await installBot({
    id: "boti_workflow",
    definitionId: "review:workflow",
    definitionSource: "plugin",
    pinnedVersion: "1",
    scope: { kind: "account" },
    now: NOW,
  })
  return { workflow, installation }
}

async function exerciseWorkflow(withAgent = false) {
  const setup = await workflowBot(withAgent)
  await dispatchWorkflowCompletedToBots({
    workflowId: "organic",
    workflowName: "Organic",
    runId: "organic-run",
    status: "succeeded",
  })
  const outcomes = await drainBotDeliveries({ owner: "regression", resolveCwd: () => undefined })
  expect(outcomes.some((item) => item.outcome.status === "completed")).toBe(true)
  // Completion fanout is intentionally asynchronous. Await its actual source
  // dispatch rather than clearing the DB while it is still enqueuing.
  for (
    let n = 0;
    n < 600 && jest.mocked(dispatchWorkflowCompletedToBots).mock.results.length < 2;
    n++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(jest.mocked(dispatchWorkflowCompletedToBots).mock.results).toHaveLength(2)
  const completion = await jest.mocked(dispatchWorkflowCompletedToBots).mock.results[1].value
  return { ...setup, completion }
}

test("published Workflow completion retains Bot lineage and cannot reenter its producer", async () => {
  const { workflow, installation, completion } = await exerciseWorkflow()
  expect(completion.enqueued).toHaveLength(0)
  expect(completion.rejected).toEqual(
    expect.arrayContaining([expect.objectContaining({ installationId: installation.id })])
  )
  expect(
    (await getDb().botEventDeliveries.toArray()).filter((row) => row.status === "pending")
  ).toHaveLength(0)
  const children = await getDb().workflowRuns.where("workflowId").equals(workflow.id).toArray()
  expect(children).toHaveLength(1)
  expect(children[0].securityContext?.botProvenance).toMatchObject({
    selfProduced: true,
    depth: 1,
    producedByInstallationId: installation.id,
  })
  expect(
    await drainBotDeliveries({ owner: "regression", resolveCwd: () => undefined })
  ).toHaveLength(0)
})

test("published Workflow agent inherits the Bot parent ceiling despite an edit-capable node", async () => {
  const { workflow } = await exerciseWorkflow(true)
  expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(1)
  const options = mockExecuteAgentTurn.mock.calls[0][1] as unknown as {
    permissionCeiling: unknown
    capabilityGrants: unknown[]
  }
  expect(options.permissionCeiling).toMatchObject({ permissionMode: "plan" })
  expect(options.capabilityGrants).toEqual(
    expect.arrayContaining([expect.objectContaining({ permissionMode: "acceptEdits" })])
  )
  const [child] = await getDb().workflowRuns.where("workflowId").equals(workflow.id).toArray()
  expect(child.securityContext?.permissionCeiling).toMatchObject({ permissionMode: "plan" })
})

test.each(["1", "0"])(
  "Bot plan ceiling survives completion-triggered Workflow delegation (version flag %s)",
  async (flag) => {
    const previousFlag = process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
    process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = flag
    try {
      const a = await createWorkflow({
        name: "Bot target A",
        nodes: [
          {
            id: "cycle",
            type: "trigger.integration.event",
            typeVersion: 1,
            position: { x: 0, y: 0 },
            data: { label: "Start", params: {} },
          },
        ],
        edges: [],
      })
      const b = await createWorkflow({
        name: "Chained target B",
        nodes: [
          {
            id: "done",
            type: "trigger.workflow.completed",
            typeVersion: 1,
            position: { x: 0, y: 0 },
            data: { label: "On A", params: { workflowId: a.id, status: "succeeded" } },
          },
          {
            id: "agent",
            type: "action.agent.turn",
            typeVersion: 1,
            position: { x: 100, y: 0 },
            data: { label: "Agent", params: { prompt: "inspect", permissionCap: "acceptEdits" } },
          },
        ],
        edges: [{ id: "edge", source: "done", target: "agent" }],
      })
      for (const wf of [a, b]) {
        await updateWorkflow(wf.id, { settings: { ...wf.settings, riskGating: false } })
        await publishWorkflow(wf.id, Date.now())
      }
      _seedTriggerSubscriptionsForTest([b])
      const definition = {
        id: "chain",
        name: "Chained workflow Bot",
        version: "1",
        executor: "workflow",
        workflow: a.id,
        triggers: [
          { id: "cycle", kind: "event", source: "workflow", types: ["workflow.succeeded"] },
        ],
        policy: { allowSelfTriggering: false, maxAuthority: "plan", maxAutonomy: "act" },
      } as PluginBotDef
      registerBot("chain", { id: "fresh:chain", definition }, { pluginId: "fresh" })
      await installBot({
        id: "boti_chain",
        definitionId: "fresh:chain",
        definitionSource: "plugin",
        pinnedVersion: "1",
        scope: { kind: "account" },
        now: NOW,
      })
      await dispatchWorkflowCompletedToBots({
        workflowId: "organic",
        workflowName: "Organic",
        runId: "organic-run",
        status: "succeeded",
      })
      const outcomes = await drainBotDeliveries({
        owner: "fresh-review",
        resolveCwd: () => undefined,
      })
      expect(outcomes[0].outcome.status).toBe("completed")
      for (let n = 0; n < 600; n++) {
        const child = (await getDb().workflowRuns.where("workflowId").equals(b.id).toArray())[0]
        if (child?.status === "succeeded" || child?.status === "failed") break
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(1)
      const options = mockExecuteAgentTurn.mock.calls[0][1] as {
        permissionCeiling?: { permissionMode?: string }
      }
      expect(options.permissionCeiling).toMatchObject({ permissionMode: "plan" })
      const [child] = await getDb().workflowRuns.where("workflowId").equals(b.id).toArray()
      expect(child.securityContext).toMatchObject({
        piiEgressRequired: true,
        permissionCeiling: { permissionMode: "plan" },
        botProvenance: { selfProduced: true, depth: 1 },
      })
      for (const result of jest.mocked(dispatchWorkflowCompletedToBots).mock.results)
        await result.value
      _seedTriggerSubscriptionsForTest([])
    } finally {
      if (previousFlag === undefined) delete process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
      else process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS = previousFlag
    }
  }
)
