jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: jest.fn(() => ({ dispatchWorkflowTriggerFired: jest.fn() })),
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { appendEvents } from "@/lib/workflow/runtime/event-log"
import { WorkflowAdmissionError } from "@/lib/workflow/runtime/execution-authority"
import type { RunWorkflowResult } from "@/lib/workflow/runtime/orchestrator"
import type { VisualWorkflow, WorkflowRunRow } from "@/types/workflow/visual"

import {
  WORKFLOW_RUN_REJECTED_SENTINEL,
  WorkflowRunRejectedError,
  parseWorkflowRunRejection,
} from "./run-rejection"
import {
  listWorkflowRunEventsPage,
  startWorkflowPreviewRun,
  triggerPublishedWorkflowRun,
  type PublishedWorkflowRunDeps,
  type WorkflowPreviewRunDeps,
} from "./host-commands"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function workflow(overrides: Partial<VisualWorkflow> = {}): VisualWorkflow {
  return {
    id: "wf_preview",
    schemaVersion: 2,
    name: "Preview",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "start", params: {} },
      },
      {
        id: "n_set",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "set", params: { variable: "v", value: 1 } },
      },
    ],
    edges: [{ id: "e1", source: "n_start", target: "n_set" }],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
    ...overrides,
  }
}

const never = <T>() => new Promise<T>(() => {})

function previewDeps(overrides: Partial<WorkflowPreviewRunDeps> = {}): WorkflowPreviewRunDeps {
  return {
    getWorkflow: jest.fn(async () => workflow()),
    runWorkflow: jest.fn((input) => {
      input.onPersisted?.(input.runId!)
      return never<RunWorkflowResult>()
    }),
    runSingleNode: jest.fn((input) => {
      input.onPersisted?.(input.runId!)
      return never<RunWorkflowResult>()
    }),
    getRun: jest.fn(async () => undefined),
    newRunId: () => "run_preview",
    ...overrides,
  }
}

async function rejection(promise: Promise<unknown>): Promise<WorkflowRunRejectedError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(WorkflowRunRejectedError)
  return error as WorkflowRunRejectedError
}

describe("startWorkflowPreviewRun", () => {
  const triggeredBy = { source: "ui" as const, deviceId: "dev_phone" }

  it("answers with the run id once the row exists, without waiting for the run", async () => {
    const deps = previewDeps()
    await expect(
      startWorkflowPreviewRun({ workflowId: "wf_preview", mode: "full", triggeredBy }, deps)
    ).resolves.toEqual({ runId: "run_preview" })
    expect(deps.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_preview",
        honorPinData: true,
        triggeredBy,
        trigger: expect.objectContaining({ kind: "trigger.manual", workflowId: "wf_preview" }),
      })
    )
    expect((deps.runWorkflow as jest.Mock).mock.calls[0][0]).not.toHaveProperty("startStepId")
  })

  it("runs from a step and runs one step the way the desktop canvas does", async () => {
    const deps = previewDeps()
    await startWorkflowPreviewRun(
      { workflowId: "wf_preview", mode: "from-step", stepId: "n_set", triggeredBy },
      deps
    )
    expect(deps.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ startStepId: "n_set", honorPinData: true })
    )
    await startWorkflowPreviewRun(
      { workflowId: "wf_preview", mode: "single-step", stepId: "n_set", triggeredBy },
      deps
    )
    expect(deps.runSingleNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "n_set", runId: "run_preview", triggeredBy })
    )
  })

  it("refuses a workflow the Host does not have", async () => {
    const error = await rejection(
      startWorkflowPreviewRun(
        { workflowId: "wf_missing", mode: "full", triggeredBy },
        previewDeps({ getWorkflow: async () => undefined })
      )
    )
    expect(error.reason).toBe("workflow_not_found")
    expect(error.message.startsWith(WORKFLOW_RUN_REJECTED_SENTINEL)).toBe(true)
  })

  it("refuses an invalid graph and an unknown step before starting anything", async () => {
    const deps = previewDeps({
      getWorkflow: async () =>
        workflow({ edges: [{ id: "e1", source: "n_start", target: "n_ghost" }] }),
    })
    expect(
      (
        await rejection(
          startWorkflowPreviewRun({ workflowId: "wf_preview", mode: "full", triggeredBy }, deps)
        )
      ).reason
    ).toBe("workflow_invalid")
    expect(
      (
        await rejection(
          startWorkflowPreviewRun(
            { workflowId: "wf_preview", mode: "single-step", stepId: "n_ghost", triggeredBy },
            previewDeps()
          )
        )
      ).reason
    ).toBe("step_not_found")
    expect(
      (
        await rejection(
          startWorkflowPreviewRun(
            { workflowId: "wf_preview", mode: "from-step", triggeredBy },
            previewDeps()
          )
        )
      ).reason
    ).toBe("invalid_request")
    expect(deps.runWorkflow).not.toHaveBeenCalled()
  })

  it("hands back a run that ended before it was announced only when its row exists", async () => {
    const failed: RunWorkflowResult = {
      runId: "run_preview",
      status: "failed",
      error: { message: "concurrency limit" },
    }
    const recorded = previewDeps({
      runWorkflow: jest.fn(async () => failed),
      getRun: async () => ({ id: "run_preview" }) as WorkflowRunRow,
    })
    await expect(
      startWorkflowPreviewRun({ workflowId: "wf_preview", mode: "full", triggeredBy }, recorded)
    ).resolves.toEqual({ runId: "run_preview" })

    const unrecorded = previewDeps({ runWorkflow: jest.fn(async () => failed) })
    const error = await rejection(
      startWorkflowPreviewRun({ workflowId: "wf_preview", mode: "full", triggeredBy }, unrecorded)
    )
    expect(error.reason).toBe("run_not_started")
    expect(error.detail).toBe("concurrency limit")
  })
})

describe("triggerPublishedWorkflowRun", () => {
  const triggeredBy = { source: "api" as const, deviceId: "dev_phone" }

  function publishedDeps(overrides: Partial<PublishedWorkflowRunDeps>): PublishedWorkflowRunDeps {
    return {
      dispatchPlaced: jest.fn(),
      onTriggerFired: jest.fn(),
      ...overrides,
    }
  }

  it("answers a local admission with its run id while the run goes on", async () => {
    const deps = publishedDeps({
      dispatchPlaced: jest.fn((input) => {
        input.onAdmitted?.({ kind: "run", runId: "run_local" })
        return never()
      }),
    })
    await expect(
      triggerPublishedWorkflowRun({ workflowId: "wf_pub", triggeredBy }, deps)
    ).resolves.toEqual({ status: "admitted", runId: "run_local" })
    expect(deps.onTriggerFired).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf_pub", kind: "trigger.manual" })
    )
  })

  it("reports a handoff to another Host, not a run id it does not have", async () => {
    const deps = publishedDeps({
      dispatchPlaced: jest.fn(async (input) => {
        input.onAdmitted?.({ kind: "handoff", dispatchId: "dispatch_1", targetRef: "host_b" })
        return never()
      }),
    })
    await expect(
      triggerPublishedWorkflowRun({ workflowId: "wf_pub", triggeredBy }, deps)
    ).resolves.toEqual({ status: "handed_off", dispatchId: "dispatch_1", targetRef: "host_b" })
  })

  it("refuses a workflow that is not deployed instead of reporting success", async () => {
    const deps = publishedDeps({
      dispatchPlaced: jest.fn(async () => {
        throw new WorkflowAdmissionError("deployment-not-found", "No active production deployment")
      }),
    })
    const error = await rejection(
      triggerPublishedWorkflowRun({ workflowId: "wf_pub", triggeredBy }, deps)
    )
    expect(error.reason).toBe("deployment-not-found")
    expect(parseWorkflowRunRejection(error.message)).toEqual({
      reason: "deployment-not-found",
      detail: "No active production deployment",
    })
    // The 422 detail the companion RPC carries has the sentinel trimmed off.
    expect(parseWorkflowRunRejection("deployment-not-found: gone")).toEqual({
      reason: "deployment-not-found",
      detail: "gone",
    })
    expect(parseWorkflowRunRejection("network down")).toBeNull()
  })
})

describe("listWorkflowRunEventsPage", () => {
  async function seedRun(status: WorkflowRunRow["status"]): Promise<void> {
    await getDb().workflowRuns.put({
      id: "run_remote",
      workflowId: "wf_preview",
      status,
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 1,
      workflowSnapshot: workflow(),
    })
    await appendEvents(
      ["run_started", "step_started", "step_completed"].map((type) => ({
        runId: "run_remote",
        type: type as "run_started",
        ...(type === "run_started" ? {} : { stepId: "n_set" }),
      }))
    )
  }

  it("answers an unknown run with an empty, finished page", async () => {
    await expect(listWorkflowRunEventsPage({ runId: "run_none" })).resolves.toEqual({
      run: null,
      events: [],
      nextSequence: 0,
      terminal: true,
    })
  })

  it("pages a run's events by sequence and says when a finished run is caught up", async () => {
    await seedRun("succeeded")
    const first = await listWorkflowRunEventsPage({ runId: "run_remote", limit: 2 })
    expect(first.run?.id).toBe("run_remote")
    expect(first.events.map((event) => event.type)).toEqual(["run_started", "step_started"])
    expect(first.terminal).toBe(false)
    const second = await listWorkflowRunEventsPage({
      runId: "run_remote",
      afterSequence: first.nextSequence,
      limit: 2,
    })
    expect(second.events.map((event) => event.type)).toEqual(["step_completed"])
    expect(second.terminal).toBe(true)
  })

  it("keeps a live run's stream open and refuses a missing run id", async () => {
    await seedRun("running")
    const page = await listWorkflowRunEventsPage({ runId: "run_remote" })
    expect(page.events).toHaveLength(3)
    expect(page.terminal).toBe(false)
    expect((await rejection(listWorkflowRunEventsPage({ runId: "" }))).reason).toBe(
      "invalid_request"
    )
  })
})
