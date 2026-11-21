const dispatchWorkflowApiBridgeCommand = jest.fn(
  async (_command: string, _payload: Record<string, unknown>) => ({
    ok: true,
    data: { runId: "run-1" },
  })
)
const probeWorkflowPlacement = jest.fn(async (_payload: Record<string, unknown>) => ({
  compatible: true,
}))
const createWorkflowApiRun = jest.fn(async (_payload: Record<string, unknown>) => ({
  runId: "run-remote",
  status: "pending",
}))
const dispatchPublicWorkflowAppBridgeCommand = jest.fn(
  async (_command: string, _payload: Record<string, unknown>) => ({
    ok: true,
    data: { app: { slug: "review" } },
  })
)
const dispatchDifyBridgeCommand = jest.fn(
  async (_command: string, _payload: Record<string, unknown>) => ({
    ok: true,
    data: { task_id: "run-1" },
  })
)

jest.mock("@/lib/workflow/api/workflow-api-service", () => ({
  dispatchWorkflowApiBridgeCommand: (command: string, payload: Record<string, unknown>) =>
    dispatchWorkflowApiBridgeCommand(command, payload),
  probeWorkflowPlacement: (payload: Record<string, unknown>) => probeWorkflowPlacement(payload),
  createWorkflowApiRun: (payload: Record<string, unknown>) => createWorkflowApiRun(payload),
}))

const createWorkflowAppRunHandoff = jest.fn(async (_input: Record<string, unknown>) => ({
  outcome: "accepted",
  runId: "run_placed",
  status: "pending",
}))
const getHandoffRun = jest.fn(async (_input: Record<string, unknown>) => ({ run: null }))
const cancelHandoffRun = jest.fn(async (_input: Record<string, unknown>) => ({
  runId: "run_placed",
  found: true,
  cancelled: true,
  mode: "aborted",
}))
jest.mock("@/lib/workflow/api/handoff-run-service", () => ({
  createWorkflowAppRunHandoff: (input: Record<string, unknown>) =>
    createWorkflowAppRunHandoff(input),
  getHandoffRun: (input: Record<string, unknown>) => getHandoffRun(input),
  cancelHandoffRun: (input: Record<string, unknown>) => cancelHandoffRun(input),
}))

jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => "acct-1",
}))

jest.mock("@/lib/workflow/apps/public-app-service", () => ({
  dispatchPublicWorkflowAppBridgeCommand: (command: string, payload: Record<string, unknown>) =>
    dispatchPublicWorkflowAppBridgeCommand(command, payload),
}))
jest.mock("@/lib/workflow/apps/dify-bridge-service", () => ({
  dispatchDifyBridgeCommand: (command: string, payload: Record<string, unknown>) =>
    dispatchDifyBridgeCommand(command, payload),
}))

import { dispatchCommand } from "./desktop-write-source"

describe("desktop write source workflow API bridge", () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    "workflow_api_run_create",
    "workflow_api_run_get",
    "workflow_api_events_list",
    "workflow_api_run_cancel",
  ])("routes %s to the shared workflow API service", async (command) => {
    const payload = { accountId: "acct-1" }

    await expect(dispatchCommand(command, payload)).resolves.toEqual({
      ok: true,
      data: { runId: "run-1" },
    })
    expect(dispatchWorkflowApiBridgeCommand).toHaveBeenCalledWith(command, payload)
  })

  it.each([
    "workflow_app_bootstrap",
    "workflow_app_run_create",
    "workflow_app_run_get",
    "workflow_app_events_list",
    "workflow_app_run_cancel",
    "workflow_app_chat_message",
    "workflow_app_feedback_submit",
    "workflow_app_mcp",
    "workflow_app_batch_template",
    "workflow_app_batch_create",
    "workflow_app_batch_get",
    "workflow_app_batch_pause",
    "workflow_app_batch_resume",
    "workflow_app_batch_cancel",
    "workflow_app_batch_export",
    "workflow_app_human_input_list",
    "workflow_app_human_input_submit",
    "workflow_app_human_input_file_upload",
  ])("routes %s to the public application authority", async (command) => {
    const payload = { appSlug: "review" }
    await expect(dispatchCommand(command, payload)).resolves.toEqual({
      ok: true,
      data: { app: { slug: "review" } },
    })
    expect(dispatchPublicWorkflowAppBridgeCommand).toHaveBeenCalledWith(command, payload)
  })

  it.each([
    "dify_workflow_run",
    "dify_workflow_status",
    "dify_events_list",
    "dify_task_stop",
    "dify_chat_message",
    "dify_conversations_list",
    "dify_messages_list",
    "dify_conversation_rename",
    "dify_conversation_delete",
    "dify_conversation_variables",
    "dify_message_feedback",
    "dify_file_upload",
  ])("routes %s to the Dify compatibility authority", async (command) => {
    const payload = { apiKey: "cog_app_secret" }
    await expect(dispatchCommand(command, payload)).resolves.toEqual({
      ok: true,
      data: { task_id: "run-1" },
    })
    expect(dispatchDifyBridgeCommand).toHaveBeenCalledWith(command, payload)
  })

  it("probes and admits authenticated Host-to-Host workflow placement", async () => {
    await expect(
      dispatchCommand("workflow_placement_probe", {
        deploymentId: "dep-1",
        expectedVersionDigest: "wfv1:digest",
      })
    ).resolves.toEqual({ compatible: true })
    expect(probeWorkflowPlacement).toHaveBeenCalledWith({
      accountId: "acct-1",
      deploymentId: "dep-1",
      expectedVersionDigest: "wfv1:digest",
      scopes: ["workflow:read"],
    })

    const trigger = {
      workflowId: "wf-1",
      kind: "trigger.cron",
      payload: { scheduled: true },
      originAt: 100,
    }
    await expect(
      dispatchCommand("workflow_handoff_create", {
        deploymentId: "dep-1",
        expectedVersionDigest: "wfv1:digest",
        idempotencyKey: "occurrence-1",
        trigger,
        callerDeviceId: "source-host-device",
      })
    ).resolves.toEqual({ runId: "run-remote", status: "pending" })
    expect(createWorkflowApiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-1",
        deploymentId: "dep-1",
        expectedVersionDigest: "wfv1:digest",
        idempotencyKey: "occurrence-1",
        trigger,
        entrypoint: "trigger",
        caller: "host:source-host-device",
        // A forwarded occurrence keeps its automatic origin (WF-22), so the
        // risk gate treats it exactly as it would on the sending Host.
        triggeredBy: { source: "trigger", deviceId: "source-host-device" },
      })
    )
  })

  describe("placed Workflow App runs (WF-13)", () => {
    const binding = {
      workflowId: "wf_1",
      versionId: "wfv_1",
      deploymentId: "wfd_1",
      deploymentRevision: 4,
      expectedVersionDigest: "wfv1:abc",
    }
    const create = {
      ...binding,
      idempotencyKey: "wfi_serving",
      runId: "run_placed",
      payload: { input: {}, appId: "wfa_1", appReleaseId: "wfar_1" },
    }

    it("admits a placed App run as the RPC-verified calling Host", async () => {
      await expect(
        dispatchCommand("workflow_app_handoff_create", {
          ...create,
          callerDeviceId: "source-host-device",
        })
      ).resolves.toEqual({ outcome: "accepted", runId: "run_placed", status: "pending" })
      expect(createWorkflowAppRunHandoff).toHaveBeenCalledWith({
        accountId: "acct-1",
        callerDeviceId: "source-host-device",
        request: create,
      })
    })

    it("refuses an App handoff without the verified caller or with a broken binding", async () => {
      await expect(dispatchCommand("workflow_app_handoff_create", create)).rejects.toThrow(
        /callerDeviceId is required/
      )
      await expect(
        dispatchCommand("workflow_app_handoff_create", {
          ...create,
          expectedVersionDigest: "",
          callerDeviceId: "source-host-device",
        })
      ).rejects.toThrow(/binding is invalid/)
      await expect(
        dispatchCommand("workflow_app_handoff_create", {
          ...create,
          payload: { appId: "wfa_1" },
          callerDeviceId: "source-host-device",
        })
      ).rejects.toThrow(/payload is invalid/)
      expect(createWorkflowAppRunHandoff).not.toHaveBeenCalled()
    })

    it("scopes run reads and cancels to the calling Host", async () => {
      await dispatchCommand("workflow_handoff_run_get", {
        runId: "run_placed",
        afterSequence: 3,
        limit: 50,
        disclosure: { payload: "{}", label: "public workflow result" },
        callerDeviceId: "source-host-device",
      })
      expect(getHandoffRun).toHaveBeenCalledWith({
        accountId: "acct-1",
        callerDeviceId: "source-host-device",
        request: {
          runId: "run_placed",
          afterSequence: 3,
          limit: 50,
          disclosure: { payload: "{}", label: "public workflow result" },
        },
      })
      await dispatchCommand("workflow_handoff_run_cancel", {
        runId: "run_placed",
        callerDeviceId: "source-host-device",
      })
      expect(cancelHandoffRun).toHaveBeenCalledWith({
        accountId: "acct-1",
        callerDeviceId: "source-host-device",
        runId: "run_placed",
      })
      await expect(
        dispatchCommand("workflow_handoff_run_get", {
          runId: "run_placed",
          afterSequence: -1,
          callerDeviceId: "d",
        })
      ).rejects.toThrow(/afterSequence/)
      await expect(
        dispatchCommand("workflow_handoff_run_cancel", { runId: "run_placed" })
      ).rejects.toThrow(/callerDeviceId is required/)
    })
  })
})
