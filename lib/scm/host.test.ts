import { SCM_HOST_COMMANDS, createScmHost, scmErrorCode } from "./host"

jest.mock("@/lib/task-workspace/user-action", () => ({
  approvalAwareTransport: { call: jest.fn(async () => "via-transport") },
}))

describe("createScmHost", () => {
  it("maps every method to its host command with named arguments", async () => {
    const call = jest.fn(async () => ({}))
    const host = createScmHost(call as never)
    await host.captureChangeset({ workspaceId: "ws", title: "t" })
    await host.recordChangesetReview("cs", { verdict: "approve" } as never)
    await host.approveChangeset("cs", "sha", "user")
    await host.analyzeIntegration(["a", "b"])
    await host.publishIntegration("int", "cand", ["unit"])
    await host.listChangesets()
    expect(call.mock.calls).toEqual([
      ["task_workspace_changeset_capture", { input: { workspaceId: "ws", title: "t" } }],
      [
        "task_workspace_changeset_record_review",
        { changesetId: "cs", review: { verdict: "approve" } },
      ],
      ["task_workspace_changeset_approve", { changesetId: "cs", headSha: "sha", approver: "user" }],
      ["task_workspace_integration_analyze", { changesetIds: ["a", "b"], targetRef: null }],
      [
        "task_workspace_integration_publish",
        { integrationId: "int", candidateSha: "cand", requiredChecks: ["unit"] },
      ],
      ["task_workspace_changeset_list", { filter: {} }],
    ])
  })

  it("sends the executor hold and the stop confirmation only when given", async () => {
    const call = jest.fn(async () => ({}))
    const host = createScmHost(call as never)
    const check = { profileId: "unit" } as never
    await host.recordIntegrationCheck("int", "cand", check)
    await host.recordIntegrationCheck("int", "cand", check, { executorStopUnprovenUntil: 9 })
    await host.abortIntegration("int")
    await host.abortIntegration("int", { executorStopped: false })
    await host.abortIntegration("int", { executorStopped: true })
    expect(call.mock.calls).toEqual([
      [
        "task_workspace_integration_record_check",
        { integrationId: "int", candidateSha: "cand", check },
      ],
      [
        "task_workspace_integration_record_check",
        { integrationId: "int", candidateSha: "cand", check, executorStopUnprovenUntil: 9 },
      ],
      ["task_workspace_integration_abort", { integrationId: "int" }],
      ["task_workspace_integration_abort", { integrationId: "int" }],
      ["task_workspace_integration_abort", { integrationId: "int", executorStopped: true }],
    ])
  })

  it("goes through the approval-aware transport by default", async () => {
    await expect(createScmHost().getIntegration("int")).resolves.toBe("via-transport")
  })

  it("names every command once, in the task_workspace family", () => {
    const names = Object.values(SCM_HOST_COMMANDS)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names)
      expect(name).toMatch(/^task_workspace_(changeset|integration)_[a-z_]+$/)
  })
})

describe("scmErrorCode", () => {
  it("reads the code of a structured host error and nothing else", () => {
    expect(scmErrorCode({ code: "target_moved", message: "m", retryable: false })).toBe(
      "target_moved"
    )
    expect(scmErrorCode(new Error("target moved"))).toBeNull()
    expect(scmErrorCode("target moved")).toBeNull()
    expect(scmErrorCode({ code: 3 })).toBeNull()
    expect(scmErrorCode(null)).toBeNull()
  })
})
