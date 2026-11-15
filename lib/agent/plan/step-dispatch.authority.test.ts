/** @jest-environment jsdom */
// Separate integration fixture: the existing dispatch suite mocks admission.
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { dispatchPlanStepNode } from "./step-dispatch"
import { executeAgent } from "@/lib/ai/agent/agent-executor"
import { DEFAULT_PLAN_CONFIG, type AgentPlan } from "@/types/agent/plan"

jest.mock("@/lib/ai/agent/agent-executor", () => ({ executeAgent: jest.fn() }))
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it.each([false, true])(
  "headless steps create their plan parent without a subscriber (session=%s)",
  async (sessionPresent) => {
    const plan: AgentPlan = {
      id: "headless-plan",
      sessionId: "headless-session",
      title: "Headless plan",
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
    }
    if (sessionPresent)
      await getDb().sessions.put({
        id: plan.sessionId,
        title: plan.title,
        createdAt: 1,
        updatedAt: 1,
      })
    jest.mocked(executeAgent).mockImplementation(async (_prompt, config) => {
      if (!config) throw new Error("Plan dispatch did not provide execution options")
      const run = await getDb().executionRuns.get(config.executionIdentity!.runId!)
      expect(run?.parentRunId).toBe(`execution:plan:${plan.id}`)
      expect(await getDb().executionRuns.get(run!.parentRunId!)).toMatchObject({
        kind: "plan",
        sourceId: plan.id,
        sessionId: plan.sessionId,
      })
      return { text: "done", channel: "text", toolsAvailable: false }
    })
    await dispatchPlanStepNode(
      {
        runId: "workflow-plan",
        planId: plan.id,
        plan,
        writer: { setStepStatus: async () => undefined },
      },
      "step",
      new AbortController().signal
    )
    expect(executeAgent).toHaveBeenCalled()
  }
)
