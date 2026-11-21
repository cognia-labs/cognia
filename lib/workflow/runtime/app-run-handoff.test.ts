import {
  isWorkflowAppRunHandoffPayload,
  parseWorkflowAppHandoffCreateReply,
  type WorkflowAppRunHandoffPayload,
} from "./app-run-handoff"

const payload: WorkflowAppRunHandoffPayload = {
  invocationId: "wfi_1",
  runId: "run_1",
  appCaller: "app:wfa_1:release:wfar_1:external:visitor",
  binding: {
    workflowId: "wf_1",
    versionId: "wfv_1",
    deploymentId: "wfd_1",
    deploymentRevision: 4,
    expectedVersionDigest: "wfv1:abc",
  },
  payload: { input: {}, appId: "wfa_1", appReleaseId: "wfar_1" },
}

describe("app-run handoff contract", () => {
  it("accepts a complete job payload and rejects any missing piece of the locked binding", () => {
    expect(isWorkflowAppRunHandoffPayload(payload)).toBe(true)
    expect(isWorkflowAppRunHandoffPayload({ ...payload, appCaller: "member:x" })).toBe(false)
    expect(
      isWorkflowAppRunHandoffPayload({
        ...payload,
        binding: { ...payload.binding, expectedVersionDigest: "" },
      })
    ).toBe(false)
    expect(
      isWorkflowAppRunHandoffPayload({
        ...payload,
        binding: { ...payload.binding, deploymentRevision: -1 },
      })
    ).toBe(false)
    expect(
      isWorkflowAppRunHandoffPayload({ ...payload, payload: { appId: "wfa_1", appReleaseId: "r" } })
    ).toBe(false)
  })

  it("parses typed accept and refuse replies and nothing else", () => {
    expect(parseWorkflowAppHandoffCreateReply({ outcome: "accepted", runId: "run_1" })).toEqual({
      outcome: "accepted",
      runId: "run_1",
      status: "pending",
    })
    expect(
      parseWorkflowAppHandoffCreateReply({
        outcome: "refused",
        refusal: { code: "version_not_found", message: "missing" },
      })
    ).toEqual({
      outcome: "refused",
      refusal: { code: "version_not_found", message: "missing", retryable: false },
    })
    expect(
      parseWorkflowAppHandoffCreateReply({ runId: "run_1", status: "pending" })
    ).toBeUndefined()
    expect(parseWorkflowAppHandoffCreateReply({ outcome: "refused", refusal: {} })).toBeUndefined()
    expect(parseWorkflowAppHandoffCreateReply(null)).toBeUndefined()
  })
})
