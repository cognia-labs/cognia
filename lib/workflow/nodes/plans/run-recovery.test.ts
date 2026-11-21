import type { InFlightRunRow, VisualWorkflow, WorkflowRunRow } from "@/types/workflow/visual"

const mockResumePlanRun = jest.fn(async (_row: WorkflowRunRow) => "succeeded" as const)
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({ resumePlanRun: (row: WorkflowRunRow) => mockResumePlanRun(row) }),
}))

const mockRegister = jest.fn((_owner: unknown) => () => undefined)
jest.mock("@/lib/workflow/runtime/resume-controller", () => ({
  registerRunRecoveryOwner: (owner: unknown) => mockRegister(owner),
}))

import { installPlanRunRecovery, planRunRecoveryOwner } from "./run-recovery"

function inFlight(workflowId: string, snapshotId = workflowId): InFlightRunRow {
  return {
    runId: "run_1",
    workflowId,
    startedAt: 0,
    snapshot: { id: snapshotId } as VisualWorkflow,
  }
}

describe("planRunRecoveryOwner", () => {
  it("claims a plan's own synthesized run, by its workflow id or its snapshot", () => {
    expect(planRunRecoveryOwner.owns(inFlight("__plan__:plan_1:abc12345"))).toBe(true)
    expect(planRunRecoveryOwner.owns(inFlight("wf_mirror", "__plan__:plan_1:abc12345"))).toBe(true)
  })

  it("leaves every other run to the generic replay", () => {
    expect(planRunRecoveryOwner.owns(inFlight("wf_exported"))).toBe(false)
    expect(planRunRecoveryOwner.owns(inFlight("__team__:t1:abc"))).toBe(false)
  })

  it("continues an owned run through the plan runtime, which settles the plan", async () => {
    const row = { id: "run_1", workflowId: "__plan__:plan_1:abc12345" } as WorkflowRunRow
    await expect(planRunRecoveryOwner.resume!(row)).resolves.toBe("succeeded")
    expect(mockResumePlanRun).toHaveBeenCalledWith(row)
  })

  it("installs itself as a recovery owner and hands back the unregister", () => {
    const unregister = installPlanRunRecovery()
    expect(mockRegister).toHaveBeenCalledWith(planRunRecoveryOwner)
    expect(typeof unregister).toBe("function")
  })
})
