import { CompanionError } from "@/lib/tauri/transport-companion"

import {
  WORKFLOW_RUN_REJECTED_CODE,
  WORKFLOW_RUN_REJECTED_SENTINEL,
  WorkflowRunRejectedError,
  parseWorkflowRunRejection,
  workflowRunRefusalOf,
} from "./run-rejection"

describe("WorkflowRunRejectedError", () => {
  it("carries the sentinel the companion RPC turns into a 422, and is not retryable", () => {
    const error = new WorkflowRunRejectedError("step_not_found", "Step n_x is gone")
    expect(error.message).toBe(`${WORKFLOW_RUN_REJECTED_SENTINEL} step_not_found: Step n_x is gone`)
    expect(error.retryable).toBe(false)
    expect(error).toMatchObject({ reason: "step_not_found", detail: "Step n_x is gone" })
  })
})

describe("parseWorkflowRunRejection", () => {
  it("reads the raw message and the one the RPC stripped of its sentinel", () => {
    const raw = new WorkflowRunRejectedError("workflow_invalid", "edge e1: target missing").message
    expect(parseWorkflowRunRejection(raw)).toEqual({
      reason: "workflow_invalid",
      detail: "edge e1: target missing",
    })
    expect(parseWorkflowRunRejection("deployment-not-found: gone")).toEqual({
      reason: "deployment-not-found",
      detail: "gone",
    })
    expect(parseWorkflowRunRejection("network down")).toBeNull()
  })
})

describe("workflowRunRefusalOf", () => {
  it("reads the in-process sentinel and the RPC code, and nothing else", () => {
    expect(
      workflowRunRefusalOf(new WorkflowRunRejectedError("workflow_not_found", "gone"))
    ).toEqual({ reason: "workflow_not_found", detail: "gone" })
    expect(
      workflowRunRefusalOf(
        new CompanionError({
          code: WORKFLOW_RUN_REJECTED_CODE,
          message: "deployment-not-found: No active production deployment",
          retryable: false,
        })
      )
    ).toEqual({ reason: "deployment-not-found", detail: "No active production deployment" })
    // A transport failure that happens to read "word: text" is not a refusal.
    expect(workflowRunRefusalOf(new Error("timeout: host slow"))).toBeNull()
    expect(
      workflowRunRefusalOf(
        new CompanionError({ code: "network", message: "x: y", retryable: true })
      )
    ).toBeNull()
  })

  it("keeps a refusal whose message has no reason as a run that did not start", () => {
    expect(
      workflowRunRefusalOf(
        new CompanionError({ code: WORKFLOW_RUN_REJECTED_CODE, message: "nope", retryable: false })
      )
    ).toEqual({ reason: "run_not_started", detail: "nope" })
  })
})
