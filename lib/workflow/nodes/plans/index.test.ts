/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "."
import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { buildPlanRepairClient } from "@/lib/agent/plan/repair-client"
import type { AgentPlan } from "@/types/agent/plan"
import { getExecutor } from "../registry"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  getPlanRunContext,
  registerPlanRunContext,
  unregisterPlanRunContext,
} from "@/lib/agent/plan/plan-run-context"

jest.mock("@/lib/agent/plan/repair-client", () => ({ buildPlanRepairClient: jest.fn() }))

const dispatchPlanStepNode = jest.fn()
jest.mock("@/lib/agent/plan/step-dispatch", () => ({
  dispatchPlanStepNode: (...args: unknown[]) => dispatchPlanStepNode(...args),
}))
const mockBuildRendererLlmClient = jest.fn((_args: unknown) => null)
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: (args: unknown) => mockBuildRendererLlmClient(args),
}))

const notePlanCreatedByWorkflow = jest.fn()
jest.mock("@/lib/workflow/runtime/plan-event-trigger", () => ({
  notePlanCreatedByWorkflow: (...args: unknown[]) => notePlanCreatedByWorkflow(...args),
}))

describe("action.plan.create", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
  })

  it("tells the plan-event trigger which workflow created the plan", async () => {
    const executor = getExecutor("action.plan.create" as never, 1)!
    const result = (await executor.execute({
      runId: "r1",
      workflowId: "wf_self",
      params: {
        sessionId: "ses_wf",
        title: "From a workflow",
        steps: [{ title: "one", kind: "agent_turn" }],
      },
      signal: undefined,
    } as never)) as { output: { planId: string } }
    expect(notePlanCreatedByWorkflow).toHaveBeenCalledWith("wf_self", result.output.planId)
  })
})

describe("plan-nodes registration", () => {
  it.each([
    ["action.plan.approve", 1],
    ["action.plan.cancel", 1],
    ["action.plan.create", 1],
    ["action.plan.delete", 1],
    ["action.plan.events", 1],
    ["action.plan.get", 1],
    ["action.plan.list", 1],
    ["action.plan.pause", 1],
    ["action.plan.refine", 1],
    ["action.plan.reject", 1],
    ["action.plan.resume", 1],
    ["action.plan.run", 1],
    ["action.plan.setStepStatus", 1],
    ["action.plan.step.dispatch", 1],
    ["action.plan.updateDraft", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})

/**
 * The dispatch node belongs to its plan's own run (`__plan__:<planId>:…`) and
 * runs on the context that run's driver registered (`runPlan`, or
 * `resumePlanRun` for a crashed run). Without a driver nothing would settle
 * the plan, so it refuses rather than run the step. Anywhere else (an
 * exported or hand-placed node) it refuses too: a workflow must not read and
 * write a plan it does not belong to (WF-24).
 */
describe("action.plan.step.dispatch", () => {
  const runId = "run_resumed"

  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    dispatchPlanStepNode.mockReset()
    dispatchPlanStepNode.mockResolvedValue({ output: { ok: true } })
    unregisterPlanRunContext(runId)
  })

  function run(params: Record<string, unknown>, workflowId: string) {
    const executor = getExecutor("action.plan.step.dispatch" as never, 1)!
    return executor.execute({
      runId,
      workflowId,
      params,
      signal: undefined,
    } as never)
  }

  async function seedPlan() {
    await getDb().agentPlans.put({
      id: "plan_1",
      sessionId: "ses_1",
      title: "T",
      status: "executing",
      steps: [{ id: "s1", title: "Step", kind: "agent_turn", status: "pending" }],
      totalSteps: 1,
      completedSteps: 0,
      createdAt: 1,
      updatedAt: 1,
    } as never)
  }

  it("dispatches the step on the context its plan's driver registered", async () => {
    await seedPlan()
    const plan = (await getDb().agentPlans.get("plan_1"))!
    const writer = { setStepStatus: jest.fn(async () => undefined) }
    registerPlanRunContext({ runId, planId: "plan_1", plan, writer })

    await run({ planId: "plan_1", stepId: "s1" }, "__plan__:plan_1:abc12345")

    expect(dispatchPlanStepNode).toHaveBeenCalledTimes(1)
    const ctx = dispatchPlanStepNode.mock.calls[0]![0] as { planId: string; writer: unknown }
    expect(ctx.planId).toBe("plan_1")
    expect(ctx.writer).toBe(writer)
  })

  it("refuses to run a step of a plan run no driver holds, so the plan never goes unsettled", async () => {
    await seedPlan()

    await expect(
      run({ planId: "plan_1", stepId: "s1" }, "__plan__:plan_1:abc12345")
    ).rejects.toThrow(/no driver holds plan plan_1's run run_resumed/)
    expect(dispatchPlanStepNode).not.toHaveBeenCalled()
    // Nothing is rebuilt behind the driver's back.
    expect(getPlanRunContext(runId)).toBeUndefined()
  })

  it("refuses to drive a plan from a workflow that is not that plan's own run", async () => {
    await seedPlan()

    await expect(run({ planId: "plan_1", stepId: "s1" }, "wf_exported")).rejects.toThrow(
      /only inside plan plan_1's own run/
    )
    // Another plan's run id does not count either.
    await expect(
      run({ planId: "plan_1", stepId: "s1" }, "__plan__:plan_other:abc12345")
    ).rejects.toThrow(/only inside/)
    expect(dispatchPlanStepNode).not.toHaveBeenCalled()
    expect(getPlanRunContext(runId)).toBeUndefined()
  })

  it("still requires both ids", async () => {
    await expect(run({ planId: "plan_1" }, "__plan__:plan_1:abc12345")).rejects.toThrow(
      /'planId' and 'stepId'/
    )
  })
})

describe("action.plan.reject", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
  })

  function reject(params: Record<string, unknown>) {
    const executor = getExecutor("action.plan.reject" as never, 1)!
    return executor.execute({ runId: "r", params, signal: undefined } as never) as Promise<{
      output: { planId: string; changed: boolean; rejected: boolean; plan: { status: string } }
    }>
  }

  async function seed(status: string) {
    await getDb().agentPlans.put({
      id: "plan_r",
      sessionId: "ses_1",
      title: "T",
      source: "manual",
      executionMode: "auto",
      status,
      steps: [],
      totalSteps: 0,
      completedSteps: 0,
      config: {},
      refinementCount: 0,
      generationId: "g",
      createdAt: 1,
      updatedAt: 1,
    } as never)
  }

  it("lands the terminal rejected status and says so", async () => {
    await seed("awaiting_approval")
    const { output } = await reject({ planId: "plan_r", feedback: "not now" })
    expect(output.rejected).toBe(true)
    expect(output.plan.status).toBe("rejected")
    expect((await getDb().agentPlans.get("plan_r"))?.status).toBe("rejected")
  })

  it("reports rejected=false for a plan that already started", async () => {
    await seed("executing")
    const { output } = await reject({ planId: "plan_r" })
    expect(output.rejected).toBe(false)
    expect(output.plan.status).toBe("executing")
  })
})

describe("action.plan.refine ledger attribution", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    mockBuildRendererLlmClient.mockClear()
  })

  async function seedPlan(sessionProjectId: string | undefined) {
    await getDb().sessions.put({
      id: "ses_ledger",
      title: "S",
      ...(sessionProjectId ? { projectId: sessionProjectId } : {}),
      createdAt: new Date(1),
      updatedAt: new Date(1),
    } as never)
    await getDb().agentPlans.put({
      id: "plan_l",
      sessionId: "ses_ledger",
      title: "T",
      source: "manual",
      executionMode: "auto",
      status: "draft",
      steps: [],
      totalSteps: 0,
      completedSteps: 0,
      config: {},
      refinementCount: 0,
      generationId: "g",
      createdAt: 1,
      updatedAt: 1,
    } as never)
  }

  function refine(projectId?: string) {
    const executor = getExecutor("action.plan.refine" as never, 1)!
    return executor.execute({
      runId: "r",
      stepId: "step_refine",
      ...(projectId ? { projectId } : {}),
      params: { planId: "plan_l" },
      signal: undefined,
    } as never)
  }

  it("books the planner call on agentsWorkflows in the plan's conversation workspace", async () => {
    await seedPlan("ws-conversation")
    await expect(refine("ws-workflow")).rejects.toThrow(/planner model/)
    expect(mockBuildRendererLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: "plan-refine",
        ledgerSurface: "agentsWorkflows",
        workspaceId: "ws-conversation",
      })
    )
  })

  it("falls back to the workflow's workspace when the conversation names none", async () => {
    await seedPlan(undefined)
    await expect(refine("ws-workflow")).rejects.toThrow(/planner model/)
    expect(mockBuildRendererLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-workflow" })
    )
  })
})

describe("action.plan.run repair client", () => {
  it.each([true, false])("forwards the signal and optional client: %s", async (configured) => {
    const runtime = getPlanRuntime()
    const plan = { id: "plan_repair", sessionId: "ses" } as AgentPlan
    const get = jest.spyOn(runtime, "getPlan").mockResolvedValue(plan)
    const run = jest.spyOn(runtime, "runPlan").mockResolvedValue({ status: "completed" })
    const client = { complete: jest.fn() }
    jest.mocked(buildPlanRepairClient).mockResolvedValue(configured ? client : undefined)
    const signal = new AbortController().signal
    try {
      await getExecutor("action.plan.run" as never, 1)!.execute({
        runId: "wf_run",
        projectId: "wf_workspace",
        params: { planId: plan.id },
        signal,
      } as never)
      expect(buildPlanRepairClient).toHaveBeenCalledWith(
        plan,
        "workflow-plan-repair",
        "wf_workspace"
      )
      expect(run).toHaveBeenCalledWith(plan.id, { signal, ...(configured ? { client } : {}) })
    } finally {
      get.mockRestore()
      run.mockRestore()
    }
  })
})
