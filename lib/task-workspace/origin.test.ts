jest.mock("@/lib/platform/detect", () => ({
  isTauri: jest.fn(() => true),
  isHeadlessHost: jest.fn(() => false),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: jest.fn(() => ({ accountId: "account-a", targetId: "host-a" })),
}))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: jest.fn(() => ({ target: null })),
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: { getState: jest.fn(() => ({ activeHostId: null })) },
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: jest.fn() },
  transport: { call: jest.fn() },
}))
jest.mock("@/lib/remote-host/target-transport", () => ({ openRemoteHostTarget: jest.fn() }))
jest.mock("@/lib/tauri/admin-lease", () => ({ issueHostAdminLease: jest.fn() }))

import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { localTransport, transport } from "@/lib/tauri/transport-instance"
import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { callTaskWorkspaceOrigin } from "./origin"

beforeEach(() => jest.clearAllMocks())

it("reads local history through local IPC even while global routing points elsewhere", async () => {
  ;(localTransport.call as jest.Mock).mockResolvedValue({ runId: "old-run" })
  await expect(
    callTaskWorkspaceOrigin({ kind: "local" }, "task_workspace_get_patch_set", { runId: "old-run" })
  ).resolves.toEqual({ runId: "old-run" })
  expect(transport.call).not.toHaveBeenCalled()
})

it("reads and approves an old remote run on its original explicit Host", async () => {
  const target = { transport: { call: jest.fn().mockResolvedValue("reverted") }, close: jest.fn() }
  ;(openRemoteHostTarget as jest.Mock).mockResolvedValue(target)
  ;(issueHostAdminLease as jest.Mock).mockResolvedValue({ token: "host-a-lease" })
  const origin = { kind: "remote" as const, hostId: "host-a", accountId: "account-a" }
  await callTaskWorkspaceOrigin(origin, "task_workspace_undo", { runId: "old-run" }, true)
  expect(openRemoteHostTarget).toHaveBeenCalledWith("host-a")
  expect(issueHostAdminLease).toHaveBeenCalledWith(["task_workspace_undo"], 120, target.transport)
  expect(target.transport.call).toHaveBeenCalledWith("task_workspace_undo", {
    runId: "old-run",
    adminLease: "host-a-lease",
  })
  expect(target.close).toHaveBeenCalledTimes(1)
  expect(transport.call).not.toHaveBeenCalled()
})

it("refuses cross-account history before opening credentials", async () => {
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValueOnce({ accountId: "account-b" })
  await expect(
    callTaskWorkspaceOrigin(
      { kind: "remote", hostId: "host-a", accountId: "account-a" },
      "task_workspace_get_patch_set",
      {}
    )
  ).rejects.toThrow("another account")
  expect(openRemoteHostTarget).not.toHaveBeenCalled()
})

it("refuses a same-account paired target switch while opening its record", async () => {
  const initial = { accountId: "account-a", targetId: "host-a", routingGeneration: 1 }
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue(initial)
  const target = { transport: { call: jest.fn() }, close: jest.fn() }
  ;(openRemoteHostTarget as jest.Mock).mockImplementation(async () => {
    ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue({
      ...initial,
      targetId: "host-b",
      routingGeneration: 2,
    })
    return target
  })
  await expect(
    callTaskWorkspaceOrigin(
      { kind: "remote", hostId: "companion:host-a", accountId: "account-a" },
      "task_workspace_get_patch_set",
      {}
    )
  ).rejects.toThrow("connection changed")
  expect(target.transport.call).not.toHaveBeenCalled()
  expect(target.close).toHaveBeenCalledTimes(1)
})

it("does not mutate after the paired device route changes during lease issuance", async () => {
  const initial = { accountId: "account-a", targetId: "host-a", routingGeneration: 1 }
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue(initial)
  const target = { transport: { call: jest.fn() }, close: jest.fn() }
  ;(openRemoteHostTarget as jest.Mock).mockResolvedValue(target)
  ;(issueHostAdminLease as jest.Mock).mockImplementation(async () => {
    ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue({
      ...initial,
      routingGeneration: 2,
    })
    return { token: "old-device" }
  })
  await expect(
    callTaskWorkspaceOrigin(
      { kind: "remote", hostId: "companion:host-a", accountId: "account-a" },
      "task_workspace_undo",
      {},
      true
    )
  ).rejects.toThrow("connection changed")
  expect(target.transport.call).not.toHaveBeenCalled()
})
