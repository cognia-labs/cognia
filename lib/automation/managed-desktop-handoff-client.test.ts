jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: jest.fn(),
  getCompanionConfigGeneration: jest.fn(() => 0),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: jest.fn(),
  subscribeRuntimeTargetContext: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/tauri/admin-lease", () => ({
  issueHostAdminLease: jest.fn(),
  HostConsentRequiredError: class extends Error {},
}))
import { loadCompanionConfig, getCompanionConfigGeneration } from "@/lib/tauri/transport-companion"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: jest.fn(() => jest.fn()) },
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: { getState: jest.fn(), subscribe: jest.fn(() => jest.fn()) },
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: jest.fn(), subscribe: jest.fn(() => jest.fn()) },
  onTransportChange: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/remote-host/management-channel", () => ({ withManagementChannel: jest.fn() }))
import { useAccountStore } from "@/stores/account/account-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { localTransport } from "@/lib/tauri/transport-instance"
import { withManagementChannel } from "@/lib/remote-host/management-channel"
import {
  MANAGED_DESKTOP_HANDOFF_CAPABILITIES,
  managedDesktopHandoffClient,
  managedDesktopHandoffErrorKey,
  type ManagedDesktopHandoffRequest,
  watchManagedDesktopAcceptance,
  validManagedDesktopCriteria,
  ACCEPTANCE_CHANGED_TOPIC,
} from "./managed-desktop-handoff-client"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"

const host = { id: "chosen-host", config: { deviceId: "device", accountId: "owner" } }
const request: ManagedDesktopHandoffRequest = {
  deliveryId: "delivery",
  deliveryRevision: 8,
  mode: "bundle",
  providerConfigId: "provider",
  lifetimeSeconds: 3600,
  criteria: [{ description: "Login works", screenshotRequired: true }],
  acceptanceFiles: ["acceptance/login.md"],
  argv: [],
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(localTransport.call as jest.Mock).mockReset()
  ;(withManagementChannel as jest.Mock).mockReset()
  ;(loadCompanionConfig as jest.Mock).mockReturnValue(null)
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue(null)
  ;(getCompanionConfigGeneration as jest.Mock).mockReturnValue(0)
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    locked: false,
    unlockedAccountId: "owner",
  })
  ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({ hosts: [host] })
})

test.each(["acceptanceStart", "acceptanceAttach", "acceptanceCancel"] as const)(
  "%s reuses the shared remote admin lease path",
  async (method) => {
    const remoteCall = jest.fn().mockResolvedValue({ acceptanceId: "run" })
    const transport = { call: remoteCall }
    jest
      .mocked(issueHostAdminLease)
      .mockResolvedValue({ token: "admin", expiresAt: Date.now() + 60000, operations: [] } as never)
    jest
      .mocked(withManagementChannel)
      .mockImplementation(((_id: string, work: (channel: unknown) => unknown) =>
        work({ host, transport })) as never)
    const target = { kind: "remote", hostId: host.id } as const
    if (method === "acceptanceStart")
      await managedDesktopHandoffClient.acceptanceStart(target, {
        ...request,
        quoteId: "quote",
        idempotencyKey: "click",
      })
    else if (method === "acceptanceAttach")
      await managedDesktopHandoffClient.acceptanceAttach(target, "run", "child")
    else await managedDesktopHandoffClient.acceptanceCancel(target, "run")
    expect(issueHostAdminLease).toHaveBeenCalledWith(
      expect.arrayContaining([
        "managed_desktop_acceptance_start",
        "managed_desktop_acceptance_attach",
        "managed_desktop_acceptance_cancel",
      ]),
      600,
      transport
    )
    expect(remoteCall).toHaveBeenCalledWith(
      expect.stringContaining("managed_desktop_acceptance_"),
      expect.objectContaining({ adminLease: "admin" })
    )
    expect(localTransport.call).not.toHaveBeenCalled()
  }
)

test("evidence tools are local-only and carry the child session key with no caller authority", async () => {
  const checkpoint = {
    acceptanceId: "run",
    sessionKey: "child",
    criterionId: "criterion-0",
    idempotencyKey: "checkpoint",
  }
  await managedDesktopHandoffClient.acceptanceCheckpoint({
    ...checkpoint,
    principalId: "forged",
  } as typeof checkpoint)
  expect(localTransport.call).toHaveBeenLastCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_acceptance_checkpoint",
    args: checkpoint,
  })
  const complete = {
    acceptanceId: "run",
    sessionKey: "child",
    idempotencyKey: "complete",
    outcome: "passed" as const,
    criteria: [
      { criterionId: "criterion-0", outcome: "passed" as const, artifactIds: ["artifact"] },
    ],
    summary: "Done",
  }
  await managedDesktopHandoffClient.acceptanceComplete(complete)
  expect(localTransport.call).toHaveBeenLastCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_acceptance_complete",
    args: complete,
  })
  expect(withManagementChannel).not.toHaveBeenCalled()
})

test("acceptance status/list are reads and the shared watcher refreshes on the exact event", async () => {
  const remoteCall = jest.fn().mockResolvedValue({ runs: [] })
  jest
    .mocked(withManagementChannel)
    .mockImplementation(((_id: string, work: (channel: unknown) => unknown) =>
      work({ host, transport: { call: remoteCall } })) as never)
  await managedDesktopHandoffClient.acceptanceStatus({ kind: "remote", hostId: host.id }, "run")
  expect(remoteCall).toHaveBeenCalledWith("managed_desktop_acceptance_status", {
    acceptanceId: "run",
  })
  expect(issueHostAdminLease).not.toHaveBeenCalled()
  jest.mocked(localTransport.call).mockResolvedValue({ runs: [{ acceptanceId: "run" }] })
  const onRuns = jest.fn()
  const stop = watchManagedDesktopAcceptance({ kind: "local" }, onRuns)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(onRuns).toHaveBeenCalledWith([{ acceptanceId: "run" }])
  expect(localTransport.subscribe).toHaveBeenCalledWith(
    ACCEPTANCE_CHANGED_TOPIC,
    expect.any(Function)
  )
  const refresh = jest.mocked(localTransport.subscribe).mock.calls[0][1]
  refresh({} as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(onRuns).toHaveBeenCalledTimes(2)
  stop()
  refresh({} as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(onRuns).toHaveBeenCalledTimes(2)
})

test("criteria validation enforces UTF-8 bytes, screenshot flags and 50 rows", () => {
  expect(
    validManagedDesktopCriteria([{ description: "中".repeat(341), screenshotRequired: true }])
  ).toBe(true)
  expect(
    validManagedDesktopCriteria([{ description: "中".repeat(342), screenshotRequired: true }])
  ).toBe(false)
  expect(validManagedDesktopCriteria([{ description: "   ", screenshotRequired: false }])).toBe(
    false
  )
  expect(validManagedDesktopCriteria([{ description: "x" }])).toBe(false)
  expect(
    validManagedDesktopCriteria(Array(51).fill({ description: "x", screenshotRequired: false }))
  ).toBe(false)
})

test("routes metadata reads to the named Host without local fallback", async () => {
  const remoteCall = jest.fn().mockResolvedValue([])
  ;(withManagementChannel as jest.Mock).mockImplementation((_id, work) =>
    work({ host, transport: { call: remoteCall } })
  )
  await managedDesktopHandoffClient.deliveries({ kind: "remote", hostId: host.id })
  expect(withManagementChannel).toHaveBeenCalledWith(host.id, expect.any(Function))
  expect(remoteCall).toHaveBeenCalledWith("managed_desktop_handoff_deliveries", {})
  expect(localTransport.call).not.toHaveBeenCalled()
})

test("prepare preserves immutable revision and strips caller authority assertions", async () => {
  await managedDesktopHandoffClient.prepare({ kind: "local" }, {
    ...request,
    ownerPrincipalId: "forged",
    codingRunId: "forged",
    sourceId: "forged",
  } as ManagedDesktopHandoffRequest)
  expect(localTransport.call).toHaveBeenCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_handoff_prepare",
    args: request,
  })
})

test("an absent account or Host cannot fall back to local authority", async () => {
  await expect(
    managedDesktopHandoffClient.deliveries({ kind: "remote", hostId: " " })
  ).rejects.toThrow("host_required")
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    locked: true,
    unlockedAccountId: "owner",
  })
  await expect(managedDesktopHandoffClient.deliveries({ kind: "local" })).rejects.toThrow(
    "authentication_required"
  )
  expect(localTransport.call).not.toHaveBeenCalled()
})

test("account replacement discards a delayed proposal even if the original account returns", async () => {
  ;(localTransport.call as jest.Mock).mockImplementation(async () => {
    const notify = (useAccountStore.subscribe as jest.Mock).mock.calls[0][0]
    ;(useAccountStore.getState as jest.Mock).mockReturnValue({
      locked: false,
      unlockedAccountId: "other",
    })
    notify()
    ;(useAccountStore.getState as jest.Mock).mockReturnValue({
      locked: false,
      unlockedAccountId: "owner",
    })
    notify()
    return { id: "private-proposal" }
  })
  await expect(managedDesktopHandoffClient.prepare({ kind: "local" }, request)).rejects.toThrow(
    "session_invalidated"
  )
  expect((useAccountStore.subscribe as jest.Mock).mock.results[0].value).toHaveBeenCalled()
})

test("re-pairing the named Host invalidates its pending metadata response", async () => {
  const remoteCall = jest.fn().mockImplementation(async () => {
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
      hosts: [{ ...host, config: { deviceId: "replacement" } }],
    })
    ;(useRemoteHostStore.subscribe as jest.Mock).mock.calls[0][0]()
    return []
  })
  ;(withManagementChannel as jest.Mock).mockImplementation((_id, work) =>
    work({ host, transport: { call: remoteCall } })
  )
  await expect(
    managedDesktopHandoffClient.deliveries({ kind: "remote", hostId: host.id })
  ).rejects.toThrow("session_invalidated")
})

test("production executor is available while unsupported axes stay dormant", () => {
  expect(MANAGED_DESKTOP_HANDOFF_CAPABILITIES).toEqual({
    productionExecution: true,
    livePreview: false,
    crossHost: false,
    projectAutomaticAcceptance: false,
  })
  expect(managedDesktopHandoffErrorKey(new Error("token=private"))).toBe("prepareFailed")
  expect(managedDesktopHandoffErrorKey("managed_desktop_handoff_provenance_required")).toBe(
    "sourceUnavailable"
  )
})

test.each([undefined, "previous-owner"])(
  "refuses registered Host owned by %s before channel acquisition",
  async (accountId) => {
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
      hosts: [{ ...host, config: { ...host.config, accountId } }],
    })
    await expect(
      managedDesktopHandoffClient.deliveries({ kind: "remote", hostId: host.id })
    ).rejects.toThrow("session_invalidated")
    expect(withManagementChannel).not.toHaveBeenCalled()
  }
)

test("pairing ABA while acquiring a channel refuses metadata before sending", async () => {
  const remoteCall = jest.fn()
  ;(withManagementChannel as jest.Mock).mockImplementation(async (_id, work) => {
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
      hosts: [{ ...host, config: { ...host.config, deviceId: "new-device" } }],
    })
    for (const [notify] of (useRemoteHostStore.subscribe as jest.Mock).mock.calls) notify()
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({ hosts: [host] })
    for (const [notify] of (useRemoteHostStore.subscribe as jest.Mock).mock.calls) notify()
    return work({ host, transport: { call: remoteCall } })
  })
  await expect(
    managedDesktopHandoffClient.prepare({ kind: "remote", hostId: host.id }, request)
  ).rejects.toThrow("session_invalidated")
  expect(remoteCall).not.toHaveBeenCalled()
})

test("rejects a channel from a replaced pairing before metadata mutation", async () => {
  const remoteCall = jest.fn()
  ;(withManagementChannel as jest.Mock).mockImplementation((_id, work) =>
    work({
      host: { ...host, config: { ...host.config, deviceId: "old-device" } },
      transport: { call: remoteCall },
    })
  )
  await expect(
    managedDesktopHandoffClient.prepare({ kind: "remote", hostId: host.id }, request)
  ).rejects.toThrow("session_invalidated")
  expect(remoteCall).not.toHaveBeenCalled()
})

test("supports the stable manifest Host alias through the same owner-bound channel", async () => {
  const remoteCall = jest.fn().mockResolvedValue([])
  ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
    hosts: [
      { ...host, featureManifest: { schemaVersion: 2, hostIdentity: { id: "stable-host" } } },
    ],
  })
  ;(withManagementChannel as jest.Mock).mockImplementation((_id, work) =>
    work({ host, transport: { call: remoteCall } })
  )
  await managedDesktopHandoffClient.deliveries({ kind: "remote", hostId: "stable-host" })
  expect(remoteCall).toHaveBeenCalledWith("managed_desktop_handoff_deliveries", {})
})

test("supports the active paired Host without requiring a registered Host row", async () => {
  const config = { targetId: "paired-host", accountId: "owner", deviceId: "paired-device" }
  const remoteCall = jest.fn().mockResolvedValue([])
  ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({ hosts: [] })
  ;(loadCompanionConfig as jest.Mock).mockReturnValue(config)
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue({
    targetId: "paired-host",
    accountId: "owner",
  })
  ;(withManagementChannel as jest.Mock).mockImplementation((_id, work) =>
    work({ host: { id: "companion:paired-host", config }, transport: { call: remoteCall } })
  )
  await managedDesktopHandoffClient.deliveries({ kind: "remote", hostId: "companion:paired-host" })
  expect(remoteCall).toHaveBeenCalledWith("managed_desktop_handoff_deliveries", {})
  await managedDesktopHandoffClient.prepare(
    { kind: "remote", hostId: "companion:paired-host" },
    request
  )
  expect(remoteCall).toHaveBeenLastCalledWith("managed_desktop_handoff_prepare", request)
})

test("paired Host generation changes while acquiring permanently invalidate handoff", async () => {
  const config = { targetId: "paired-host", accountId: "owner", deviceId: "paired-device" }
  const remoteCall = jest.fn()
  ;(loadCompanionConfig as jest.Mock).mockReturnValue(config)
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue({
    targetId: "paired-host",
    accountId: "owner",
  })
  ;(withManagementChannel as jest.Mock).mockImplementation(async (_id, work) => {
    ;(getCompanionConfigGeneration as jest.Mock).mockReturnValue(1)
    for (const [notify] of (subscribeRuntimeTargetContext as jest.Mock).mock.calls) notify()
    ;(getCompanionConfigGeneration as jest.Mock).mockReturnValue(0)
    return work({ host: { id: "companion:paired-host", config }, transport: { call: remoteCall } })
  })
  await expect(
    managedDesktopHandoffClient.deliveries({ kind: "remote", hostId: "companion:paired-host" })
  ).rejects.toThrow("session_invalidated")
  expect(remoteCall).not.toHaveBeenCalled()
})
