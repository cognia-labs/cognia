jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: jest.fn(),
  getCompanionConfigGeneration: jest.fn(() => 0),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: jest.fn(),
  subscribeRuntimeTargetContext: jest.fn(() => jest.fn()),
}))
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: jest.fn() },
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: { getState: jest.fn(), subscribe: jest.fn() },
}))
import { useAccountStore } from "@/stores/account/account-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: jest.fn(), subscribe: jest.fn() },
  onTransportChange: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/remote-host/management-channel", () => ({
  withManagementChannel: jest.fn(),
  acquireManagementChannel: jest.fn(),
}))
jest.mock("@/lib/tauri/admin-lease", () => ({
  issueHostAdminLease: jest.fn(),
  HostConsentRequiredError: class extends Error {},
}))
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { localTransport } from "@/lib/tauri/transport-instance"
import type { SandboxDesktopFrame } from "@/lib/automation/sandbox-client"
import {
  acquireManagementChannel,
  withManagementChannel,
} from "@/lib/remote-host/management-channel"
import {
  managedDesktopClient,
  managedDesktopErrorKey,
  openManagedDesktop,
  watchManagedDesktopMonitor,
  watchManagedDesktopQualification,
  watchManagedDesktopDelegations,
  MANAGED_DESKTOP_DELEGATION_CHANGED,
  MANAGED_DESKTOP_MONITOR_CHANGED,
  MANAGED_DESKTOP_QUALIFICATION_CHANGED,
} from "./managed-desktop-client"

beforeEach(() => {
  jest.clearAllMocks()
  ;(issueHostAdminLease as jest.Mock).mockReset()
  ;(localTransport.call as jest.Mock).mockReset()
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "owner",
    locked: false,
  })
  ;(useAccountStore.subscribe as jest.Mock).mockImplementation(() => jest.fn())
  ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
    hosts: ["host", "host-b", "same-host"].map((id) => ({
      id,
      config: { deviceId: "paired", accountId: "owner" },
    })),
  })
  ;(useRemoteHostStore.subscribe as jest.Mock).mockImplementation(() => jest.fn())
})

test("routes explicitly local without following the active Host", async () => {
  await managedDesktopClient.listConfigs({ kind: "local" })
  expect(localTransport.call).toHaveBeenCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_list_configs",
    args: {},
  })
  expect(withManagementChannel).not.toHaveBeenCalled()
})

test("reads the installed release status without arguments through the same Host seam", async () => {
  const status = {
    state: "installed",
    source: "bundled",
    imageDigest: `sha256:${"d".repeat(64)}`,
    recipeRevision: "7",
    protocol: "computer-server-0.3.46",
    error: null,
  }
  ;(localTransport.call as jest.Mock).mockResolvedValue(status)
  await expect(managedDesktopClient.releaseStatus({ kind: "local" })).resolves.toEqual(status)
  expect(localTransport.call).toHaveBeenCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_release_status",
    args: {},
  })
})

test("template and monitor reads go through the same Host seam", async () => {
  ;(localTransport.call as jest.Mock).mockResolvedValue([])
  await managedDesktopClient.templateList({ kind: "local" })
  await managedDesktopClient.templateDelete({ kind: "local" }, "tmpl")
  await managedDesktopClient.monitor({ kind: "local" })
  expect((localTransport.call as jest.Mock).mock.calls.map(([, payload]) => payload)).toEqual([
    { name: "managed_desktop_template_list", args: {} },
    { name: "managed_desktop_template_delete", args: { templateId: "tmpl" } },
    { name: "managed_desktop_monitor", args: {} },
  ])
})

describe("watchManagedDesktopMonitor", () => {
  const monitor = (billedDesktops: number) => ({
    observedAt: 1,
    billedDesktops,
    maximumExposureMicros: {},
    oldestPendingCreateAt: null,
    oldestPendingDeleteAt: null,
    alerts: [],
  })

  test("reads once, then on every change event, and drops stale answers", async () => {
    const unsubscribe = jest.fn()
    ;(localTransport.subscribe as jest.Mock).mockReturnValue(unsubscribe)
    let resolveFirst: (value: unknown) => void = () => undefined
    ;(localTransport.call as jest.Mock)
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(monitor(2))
    const seen: number[] = []
    const stop = watchManagedDesktopMonitor({ kind: "local" }, (m) => seen.push(m.billedDesktops))
    expect(localTransport.subscribe).toHaveBeenCalledWith(
      MANAGED_DESKTOP_MONITOR_CHANGED,
      expect.any(Function)
    )
    const changed = (localTransport.subscribe as jest.Mock).mock.calls[0][1]
    changed({})
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveFirst(monitor(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The older read finished last and is ignored.
    expect(seen).toEqual([2])
    stop()
    expect(unsubscribe).toHaveBeenCalled()
    ;(localTransport.call as jest.Mock).mockResolvedValueOnce(monitor(3))
    changed({})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([2])
  })

  test("holds the remote Host's management channel while watching", async () => {
    const unsubscribe = jest.fn()
    const release = jest.fn()
    const transport = { subscribe: jest.fn(() => unsubscribe), call: jest.fn() }
    ;(acquireManagementChannel as jest.Mock).mockResolvedValue({
      host: { config: {} },
      transport,
      release,
    })
    ;(withManagementChannel as jest.Mock).mockImplementation(async (_host, work) =>
      work({ host: { config: {} }, transport: { call: jest.fn().mockResolvedValue(monitor(1)) } })
    )
    const stop = watchManagedDesktopMonitor({ kind: "remote", hostId: "host" }, jest.fn())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(acquireManagementChannel).toHaveBeenCalledWith("host")
    expect(transport.subscribe).toHaveBeenCalledWith(
      MANAGED_DESKTOP_MONITOR_CHANGED,
      expect.any(Function)
    )
    stop()
    expect(unsubscribe).toHaveBeenCalled()
    expect(release).toHaveBeenCalled()
  })
})

describe("qualification runs", () => {
  test("reads go through the Host seam without an admin lease", async () => {
    ;(localTransport.call as jest.Mock).mockResolvedValue({ runs: [] })
    await managedDesktopClient.qualifyList({ kind: "local" })
    await managedDesktopClient.qualifyStatus({ kind: "local" }, "run-1")
    expect((localTransport.call as jest.Mock).mock.calls.map(([, payload]) => payload)).toEqual([
      { name: "managed_desktop_qualify_list", args: {} },
      { name: "managed_desktop_qualify_status", args: { runId: "run-1" } },
    ])
  })

  test("start, approve and cancel carry an admin lease on a remote Host", async () => {
    const call = jest.fn().mockResolvedValue({ runId: "run-1" })
    const transport = { call }
    ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
      work({ transport, host: { config: { deviceId: "paired", accountId: "owner" } } })
    )
    ;(issueHostAdminLease as jest.Mock).mockResolvedValue({
      token: "lease",
      expiresAt: Date.now() + 60000,
      operations: [
        "managed_desktop_qualify_start",
        "managed_desktop_qualify_approve",
        "managed_desktop_qualify_cancel",
      ],
    })
    const target = { kind: "remote" as const, hostId: "host" }
    await managedDesktopClient.qualifyStatus(target, "run-1")
    expect(issueHostAdminLease).not.toHaveBeenCalled()
    await managedDesktopClient.qualifyStart(target, {
      providerConfigId: "byo",
      scope: "acceptance",
      handoff: { deliveryId: "delivery", script: "test:e2e" },
    })
    expect(issueHostAdminLease).toHaveBeenCalledWith(
      expect.arrayContaining([
        "managed_desktop_qualify_start",
        "managed_desktop_qualify_approve",
        "managed_desktop_qualify_cancel",
      ]),
      600,
      transport
    )
    expect(call).toHaveBeenLastCalledWith("managed_desktop_qualify_start", {
      providerConfigId: "byo",
      scope: "acceptance",
      handoff: { deliveryId: "delivery", script: "test:e2e" },
      adminLease: "lease",
    })
    await managedDesktopClient.qualifyApprove(target, "run-1", "quote-1")
    expect(call).toHaveBeenLastCalledWith("managed_desktop_qualify_approve", {
      runId: "run-1",
      quoteId: "quote-1",
      adminLease: "lease",
    })
    await managedDesktopClient.qualifyCancel(target, "run-1")
    expect(call).toHaveBeenLastCalledWith("managed_desktop_qualify_cancel", {
      runId: "run-1",
      adminLease: "lease",
    })
    expect(issueHostAdminLease).toHaveBeenCalledTimes(1)
  })

  test("the watcher lists runs on its own change event", async () => {
    const unsubscribe = jest.fn()
    ;(localTransport.subscribe as jest.Mock).mockReturnValue(unsubscribe)
    ;(localTransport.call as jest.Mock)
      .mockResolvedValueOnce({ runs: [{ runId: "a" }] })
      .mockResolvedValueOnce({ runs: [{ runId: "b" }, { runId: "a" }] })
    const seen: string[][] = []
    const stop = watchManagedDesktopQualification({ kind: "local" }, (runs) =>
      seen.push(runs.map((run) => run.runId))
    )
    expect(localTransport.subscribe).toHaveBeenCalledWith(
      MANAGED_DESKTOP_QUALIFICATION_CHANGED,
      expect.any(Function)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    ;(localTransport.subscribe as jest.Mock).mock.calls[0][1]({})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([["a"], ["b", "a"]])
    stop()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe("delegations", () => {
  test("delegate and revoke carry an admin lease; listing does not", async () => {
    const call = jest.fn().mockResolvedValue({ delegations: [] })
    const transport = { call }
    ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
      work({ transport, host: { config: { deviceId: "paired", accountId: "owner" } } })
    )
    ;(issueHostAdminLease as jest.Mock).mockResolvedValue({
      token: "lease",
      expiresAt: Date.now() + 60000,
      operations: ["managed_desktop_delegate", "managed_desktop_delegation_revoke"],
    })
    const target = { kind: "remote" as const, hostId: "host" }
    await managedDesktopClient.listDelegations(target)
    expect(call).toHaveBeenLastCalledWith("managed_desktop_delegation_list", {})
    expect(issueHostAdminLease).not.toHaveBeenCalled()
    await managedDesktopClient.delegate(target, {
      desktopId: "desktop",
      generation: 2,
      grantee: { kind: "session", sessionKey: "chat-1" },
    })
    expect(call).toHaveBeenLastCalledWith("managed_desktop_delegate", {
      desktopId: "desktop",
      generation: 2,
      grantee: { kind: "session", sessionKey: "chat-1" },
      adminLease: "lease",
    })
    await managedDesktopClient.revokeDelegation(target, "delegation", 3)
    expect(call).toHaveBeenLastCalledWith("managed_desktop_delegation_revoke", {
      delegationId: "delegation",
      expectedRevision: 3,
      adminLease: "lease",
    })
    expect(issueHostAdminLease).toHaveBeenCalledTimes(1)
  })

  test("the watcher lists delegations on its own change event", async () => {
    ;(localTransport.subscribe as jest.Mock).mockReturnValue(jest.fn())
    ;(localTransport.call as jest.Mock).mockResolvedValue({ delegations: [{ id: "d" }] })
    const seen: string[][] = []
    const stop = watchManagedDesktopDelegations({ kind: "local" }, (list) =>
      seen.push(list.map((delegation) => delegation.id))
    )
    expect(localTransport.subscribe).toHaveBeenCalledWith(
      MANAGED_DESKTOP_DELEGATION_CHANGED,
      expect.any(Function)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([["d"]])
    expect(localTransport.call).toHaveBeenCalledWith("managed_desktop_local_call", {
      name: "managed_desktop_delegation_list",
      args: {},
    })
    stop()
  })

  test("an unqualified agent-control refusal has its own message key", () => {
    expect(managedDesktopErrorKey(new Error("managed_desktop_agent_control_unqualified"))).toBe(
      "agentControlUnqualified"
    )
  })
})

test("local viewer operations use the registered wrapper and preserve their fenced payloads", async () => {
  const ref = { desktopId: "desktop", generation: 3 }
  const session = await openManagedDesktop({ kind: "local" }, ref)
  const lease = { token: "input-lease", fence: 4, expiresAt: Date.now() + 15000 }
  ;(localTransport.call as jest.Mock).mockResolvedValue(lease)
  try {
    expect(session.status).toEqual(expect.any(Function))
    await session.status!()
    await session.frame()
    await session.acquire(true)
    await session.renew(lease)
    await session.input(
      lease,
      {
        screenshot: { bytes: "aA==", width: 1, height: 1, capturedAt: 1, format: "png" },
        frameId: "frame",
        fence: 4,
        expiresAt: Date.now() + 5000,
      },
      { x: 0, y: 0 },
      { kind: "click" }
    )
    await session.release(lease)
    expect(
      (localTransport.call as jest.Mock).mock.calls.map(([command, payload]) => [
        command,
        payload.name,
      ])
    ).toEqual(
      ["status", "frame", "acquire", "renew", "input", "release"].map((verb) => [
        "managed_desktop_local_call",
        `managed_desktop_control_${verb}`,
      ])
    )
    expect(localTransport.call).toHaveBeenCalledWith("managed_desktop_local_call", {
      name: "managed_desktop_control_input",
      args: {
        ...ref,
        token: lease.token,
        fence: 4,
        frameId: "frame",
        point: { x: 0, y: 0 },
        action: { kind: "click" },
      },
    })
    expect(issueHostAdminLease).not.toHaveBeenCalled()
  } finally {
    session.close()
  }
})

test("routes to the named management Host and preserves its generation", async () => {
  const call = jest.fn().mockResolvedValue({ reachable: true })
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport: { call }, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  await managedDesktopClient.health(
    { kind: "remote", hostId: "host-b" },
    { desktopId: "desktop", generation: 4 }
  )
  expect(withManagementChannel).toHaveBeenCalledWith("host-b", expect.any(Function))
  expect(call).toHaveBeenCalledWith("managed_desktop_health", {
    desktopId: "desktop",
    generation: 4,
  })
  expect(localTransport.call).not.toHaveBeenCalled()
})

test("rejects an empty remote target without falling back locally", async () => {
  await expect(managedDesktopClient.listConfigs({ kind: "remote", hostId: " " })).rejects.toThrow(
    "host"
  )
  expect(localTransport.call).not.toHaveBeenCalled()
  expect(withManagementChannel).not.toHaveBeenCalled()
})

test("creation carries opaque Host authorization, never a confirmed flag", async () => {
  const request = {
    providerConfigId: "byo",
    quoteId: "quote",
    authorizationId: "auth",
    idempotencyKey: "attempt",
  }
  await managedDesktopClient.create({ kind: "local" }, request)
  expect(localTransport.call).toHaveBeenCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_create",
    args: request,
  })
})

test("maps only stable Host refusals, suppressing provider bodies", () => {
  expect(managedDesktopErrorKey({ code: "managed_desktop_entitlement_limit" })).toBe(
    "entitlementLimit"
  )
  expect(managedDesktopErrorKey(new Error("token=secret"))).toBe("unknown")
  expect(
    managedDesktopErrorKey({
      code: "forbidden",
      message: "managed_desktop_egress_smoke_unsupported",
    })
  ).toBe("egressSmokeUnsupported")
})

test("requests a short admin lease only for a user mutation and reuses it for the bound Host action", async () => {
  const call = jest.fn().mockResolvedValue({ id: "auth" })
  const transport = { call }
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  ;(issueHostAdminLease as jest.Mock).mockResolvedValue({
    token: "lease",
    expiresAt: Date.now() + 60000,
    operations: [
      "managed_desktop_authorize",
      "managed_desktop_create",
      "managed_desktop_prepare_template",
      "managed_desktop_connect",
      "managed_desktop_delete",
    ],
  })
  const target = { kind: "remote" as const, hostId: "host-b" }
  await managedDesktopClient.quote(target, "byo", 3600)
  expect(issueHostAdminLease).not.toHaveBeenCalled()
  await managedDesktopClient.authorize(target, "byo", "quote", "create")
  expect(issueHostAdminLease).toHaveBeenCalledWith(
    expect.arrayContaining(["managed_desktop_authorize", "managed_desktop_create"]),
    600,
    transport
  )
  expect(call).toHaveBeenCalledWith("managed_desktop_authorize", {
    providerConfigId: "byo",
    quoteId: "quote",
    action: "create",
    adminLease: "lease",
  })
  await managedDesktopClient.create(target, {
    providerConfigId: "byo",
    quoteId: "quote",
    authorizationId: "auth",
    idempotencyKey: "attempt",
  })
  expect(issueHostAdminLease).toHaveBeenCalledTimes(1)
  expect(call).toHaveBeenLastCalledWith(
    "managed_desktop_create",
    expect.objectContaining({ adminLease: "lease", authorizationId: "auth" })
  )
})

test("lease consent refusal prevents the mutation RPC", async () => {
  const call = jest.fn()
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport: { call }, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  ;(issueHostAdminLease as jest.Mock).mockRejectedValue(new Error("REMOTE_CONSENT_REQUIRED"))
  await expect(
    managedDesktopClient.delete(
      { kind: "remote", hostId: "host-b" },
      { desktopId: "desktop", generation: 1 }
    )
  ).rejects.toThrow("REMOTE_CONSENT_REQUIRED")
  expect(call).not.toHaveBeenCalled()
})

test("never reuses an admin lease after the authenticated Host transport changes", async () => {
  const first = { call: jest.fn().mockResolvedValue(undefined) }
  const second = { call: jest.fn().mockResolvedValue(undefined) }
  let current = first
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport: current, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  ;(issueHostAdminLease as jest.Mock).mockImplementation(async (_operations, _ttl, transport) => ({
    token: transport === first ? "first" : "second",
    expiresAt: Date.now() + 60000,
    operations: ["managed_desktop_connect"],
  }))
  const target = { kind: "remote" as const, hostId: "same-host" }
  await managedDesktopClient.connect(target, { desktopId: "desktop", generation: 1 })
  current = second
  await managedDesktopClient.connect(target, { desktopId: "desktop", generation: 1 })
  expect(issueHostAdminLease).toHaveBeenCalledTimes(2)
  expect(second.call).toHaveBeenCalledWith("managed_desktop_connect", {
    desktopId: "desktop",
    generation: 1,
    adminLease: "second",
  })
})

test("evicts a Host-revoked lease without retrying the mutation, renewing only on the next gesture", async () => {
  const revoked = new Error("REMOTE_CONSENT_REQUIRED: admin lease is invalid or expired")
  const call = jest.fn().mockRejectedValueOnce(revoked).mockResolvedValueOnce(undefined)
  const transport = { call }
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  ;(issueHostAdminLease as jest.Mock)
    .mockResolvedValueOnce({
      token: "revoked",
      expiresAt: Date.now() + 60000,
      operations: ["managed_desktop_create"],
    })
    .mockResolvedValueOnce({
      token: "renewed",
      expiresAt: Date.now() + 60000,
      operations: ["managed_desktop_create"],
    })
  const target = { kind: "remote" as const, hostId: "host" }
  const request = {
    providerConfigId: "byo",
    quoteId: "quote",
    authorizationId: "auth",
    idempotencyKey: "attempt",
  }
  await expect(managedDesktopClient.create(target, request)).rejects.toBe(revoked)
  expect(call).toHaveBeenCalledTimes(1)
  expect(issueHostAdminLease).toHaveBeenCalledTimes(1)
  await managedDesktopClient.create(target, request)
  expect(issueHostAdminLease).toHaveBeenCalledTimes(2)
  expect(call).toHaveBeenLastCalledWith("managed_desktop_create", {
    ...request,
    adminLease: "renewed",
  })
})

test.each([
  "network timeout",
  "managed_desktop_host_consent_required",
  "REMOTE_SCOPE_DENIED: admin lease does not cover this operation",
])("retains the lease on unrelated refusal: %s", async (message) => {
  const call = jest.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(undefined)
  const transport = { call }
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  ;(issueHostAdminLease as jest.Mock).mockResolvedValue({
    token: "valid",
    expiresAt: Date.now() + 60000,
    operations: ["managed_desktop_delete"],
  })
  const target = { kind: "remote" as const, hostId: "host" }
  const ref = { desktopId: "desktop", generation: 1 }
  await expect(managedDesktopClient.delete(target, ref)).rejects.toThrow(message)
  expect(call).toHaveBeenCalledTimes(1)
  await managedDesktopClient.delete(target, ref)
  expect(issueHostAdminLease).toHaveBeenCalledTimes(1)
})

function prepareViewer() {
  let accountListener!: () => void
  let hostListener!: () => void
  let authListener!: (state: string) => void
  const host = { id: "chosen", config: { deviceId: "paired", accountId: "owner" } }
  const transport = {
    call: jest.fn(),
    onConnectionStateChange: jest.fn((handler) => {
      authListener = handler
      return jest.fn()
    }),
  }
  const release = jest.fn()
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "owner",
    locked: false,
  })
  ;(useAccountStore.subscribe as jest.Mock).mockImplementation((handler) => {
    accountListener = handler
    return jest.fn()
  })
  ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({ hosts: [host] })
  ;(useRemoteHostStore.subscribe as jest.Mock).mockImplementation((handler) => {
    hostListener = handler
    return jest.fn()
  })
  ;(acquireManagementChannel as jest.Mock).mockResolvedValue({ host, transport, release })
  return {
    transport,
    release,
    accountChanged: () => accountListener(),
    hostChanged: () => hostListener(),
    authChanged: (state: string) => authListener(state),
  }
}

test("viewer pins the selected Host, generation, fenced frame and short lease", async () => {
  const bound = prepareViewer()
  const session = await openManagedDesktop(
    { kind: "remote", hostId: "chosen" },
    { desktopId: "desktop", generation: 3 }
  )
  const lease = { token: "input-lease", fence: 4, expiresAt: Date.now() + 15000 }
  bound.transport.call.mockResolvedValue(lease)
  ;(issueHostAdminLease as jest.Mock).mockResolvedValue({
    token: "step-up",
    expiresAt: Date.now() + 600000,
  })
  await session.acquire(true)
  expect(bound.transport.call).toHaveBeenCalledWith("managed_desktop_control_acquire", {
    desktopId: "desktop",
    generation: 3,
    takeover: true,
    adminLease: "step-up",
  })
  await session.input(
    lease,
    {
      screenshot: { bytes: "aA==", width: 1, height: 1, capturedAt: 1, format: "png" },
      frameId: "opaque-frame",
      fence: 4,
      expiresAt: Date.now() + 5_000,
    },
    { x: 0, y: 0 },
    { kind: "click" }
  )
  expect(bound.transport.call).toHaveBeenLastCalledWith("managed_desktop_control_input", {
    desktopId: "desktop",
    generation: 3,
    token: "input-lease",
    fence: 4,
    frameId: "opaque-frame",
    point: { x: 0, y: 0 },
    action: { kind: "click" },
    adminLease: "step-up",
  })
  expect(issueHostAdminLease).toHaveBeenCalledTimes(1)
  expect(localTransport.call).not.toHaveBeenCalled()
  session.close()
  session.close()
  expect(bound.release).toHaveBeenCalledTimes(1)
})

test.each(["account", "pairing", "authentication", "offline"])(
  "viewer invalidates on %s change without moving control",
  async (change) => {
    const bound = prepareViewer()
    const session = await openManagedDesktop(
      { kind: "remote", hostId: "chosen" },
      { desktopId: "desktop", generation: 1 }
    )
    const invalidated = jest.fn()
    session.onInvalidated?.(invalidated)
    if (change === "account") {
      ;(useAccountStore.getState as jest.Mock).mockReturnValue({
        unlockedAccountId: "other",
        locked: false,
      })
      bound.accountChanged()
    } else if (change === "pairing") {
      ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
        hosts: [{ id: "chosen", config: { deviceId: "new" } }],
      })
      bound.hostChanged()
    } else bound.authChanged(change === "offline" ? "offline" : "unauthenticated")
    expect(invalidated).toHaveBeenCalledTimes(1)
    await expect(session.frame()).rejects.toThrow("session_invalidated")
    expect(bound.transport.call).not.toHaveBeenCalled()
    session.close()
  }
)

test("viewer refuses absent frame proof and late acquire after account change", async () => {
  const bound = prepareViewer()
  const session = await openManagedDesktop(
    { kind: "remote", hostId: "chosen" },
    { desktopId: "desktop", generation: 1 }
  )
  await expect(
    session.input(
      { token: "token", fence: 1, expiresAt: 1 },
      // Deliberately malformed: the runtime guard must refuse a frame the
      // type system would not let a Host return.
      {
        screenshot: { bytes: "aA==", width: 1, height: 1, capturedAt: 1, format: "png" },
      } as unknown as SandboxDesktopFrame,
      null,
      { kind: "pressKey", chord: "Enter" }
    )
  ).rejects.toThrow("missing_frame_proof")
  let resolve!: (value: unknown) => void
  ;(issueHostAdminLease as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const pending = session.acquire(false)
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: null,
    locked: true,
  })
  bound.accountChanged()
  resolve({ token: "late" })
  await expect(pending).rejects.toThrow("session_invalidated")
  expect(bound.transport.call).not.toHaveBeenCalled()
  session.close()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("lifecycle calls refuse locked owners before any transport request", async () => {
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "owner",
    locked: true,
  })
  await expect(managedDesktopClient.list({ kind: "local" })).rejects.toThrow(
    "authentication_required"
  )
  expect(localTransport.call).not.toHaveBeenCalled()
})

test("lifecycle discards delayed private reads even after account ABA", async () => {
  const result = deferred<unknown[]>()
  const listeners: Array<() => void> = []
  ;(useAccountStore.subscribe as jest.Mock).mockImplementation((listener) => {
    listeners.push(listener)
    return jest.fn()
  })
  ;(localTransport.call as jest.Mock).mockReturnValue(result.promise)
  const request = managedDesktopClient.list({ kind: "local" })
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "other",
    locked: false,
  })
  listeners.forEach((listener) => listener())
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "owner",
    locked: false,
  })
  listeners.forEach((listener) => listener())
  result.resolve([])
  await expect(request).rejects.toThrow("session_invalidated")
})

test.each(["account", "pairing"])(
  "lifecycle refuses %s changes while management channel opens",
  async (change) => {
    const opening = deferred<void>()
    const call = jest.fn()
    const listeners: Array<() => void> = []
    ;(useAccountStore.subscribe as jest.Mock).mockImplementation((listener) => {
      listeners.push(listener)
      return jest.fn()
    })
    ;(useRemoteHostStore.subscribe as jest.Mock).mockImplementation((listener) => {
      listeners.push(listener)
      return jest.fn()
    })
    ;(withManagementChannel as jest.Mock).mockImplementation(async (_host, work) => {
      await opening.promise
      return work({
        transport: { call },
        host: { config: { deviceId: "paired", accountId: "owner" } },
      })
    })
    const request = managedDesktopClient.list({ kind: "remote", hostId: "host" })
    if (change === "account")
      (useAccountStore.getState as jest.Mock).mockReturnValue({
        unlockedAccountId: "other",
        locked: false,
      })
    else
      (useRemoteHostStore.getState as jest.Mock).mockReturnValue({
        hosts: [{ id: "host", config: { deviceId: "repaired" } }],
      })
    listeners.forEach((listener) => listener())
    opening.resolve()
    await expect(request).rejects.toThrow("session_invalidated")
    expect(call).not.toHaveBeenCalled()
  }
)

test("lifecycle refuses mutations after identity changes during admin consent", async () => {
  const consent = deferred<unknown>()
  const call = jest.fn()
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport: { call }, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  ;(issueHostAdminLease as jest.Mock).mockReturnValue(consent.promise)
  const request = managedDesktopClient.delete(
    { kind: "remote", hostId: "host" },
    { desktopId: "desktop", generation: 1 }
  )
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "other",
    locked: false,
  })
  consent.resolve({
    token: "late",
    expiresAt: Date.now() + 60000,
    operations: ["managed_desktop_delete"],
  })
  await expect(request).rejects.toThrow("session_invalidated")
  expect(call).not.toHaveBeenCalled()
})

test("lifecycle rejects a stale channel returned under an unchanged Host row", async () => {
  const call = jest.fn()
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport: { call }, host: { config: { deviceId: "obsolete" } } })
  )
  await expect(managedDesktopClient.list({ kind: "remote", hostId: "host" })).rejects.toThrow(
    "session_invalidated"
  )
  expect(call).not.toHaveBeenCalled()
})

test("viewer rejects a private frame that arrives after its owner locks", async () => {
  const bound = prepareViewer()
  const session = await openManagedDesktop(
    { kind: "remote", hostId: "chosen" },
    { desktopId: "desktop", generation: 1 }
  )
  const frame = deferred<unknown>()
  bound.transport.call.mockReturnValue(frame.promise)
  const pending = session.frame()
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "owner",
    locked: true,
  })
  bound.accountChanged()
  frame.resolve({ screenshot: { bytes: "private" } })
  await expect(pending).rejects.toThrow("session_invalidated")
  session.close()
})

test("viewer releases a late acquired channel after account ABA", async () => {
  const bound = prepareViewer()
  const listeners: Array<() => void> = []
  ;(useAccountStore.subscribe as jest.Mock).mockImplementation((listener) => {
    listeners.push(listener)
    return jest.fn()
  })
  const channel = deferred<unknown>()
  ;(acquireManagementChannel as jest.Mock).mockReturnValue(channel.promise)
  const opening = openManagedDesktop(
    { kind: "remote", hostId: "chosen" },
    { desktopId: "desktop", generation: 1 }
  )
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "other",
    locked: false,
  })
  listeners.forEach((listener) => listener())
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "owner",
    locked: false,
  })
  listeners.forEach((listener) => listener())
  channel.resolve({
    host: { config: { deviceId: "paired", accountId: "owner" } },
    transport: bound.transport,
    release: bound.release,
  })
  await expect(opening).rejects.toThrow("session_invalidated")
  expect(bound.release).toHaveBeenCalledTimes(1)
  expect(bound.transport.call).not.toHaveBeenCalled()
})

test("another owner cannot use a retained Host row or its cached admin lease", async () => {
  const transport = { call: jest.fn().mockResolvedValue(undefined) }
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  ;(issueHostAdminLease as jest.Mock).mockImplementation(async () => ({
    token: "lease",
    expiresAt: Date.now() + 60000,
    operations: ["managed_desktop_delete"],
  }))
  const target = { kind: "remote" as const, hostId: "host" }
  const desktop = { desktopId: "desktop", generation: 1 }
  await managedDesktopClient.delete(target, desktop)
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "other",
    locked: false,
  })
  await expect(managedDesktopClient.delete(target, desktop)).rejects.toThrow("session_invalidated")
  expect(withManagementChannel).toHaveBeenCalledTimes(1)
  expect(issueHostAdminLease).toHaveBeenCalledTimes(1)
  expect(transport.call).toHaveBeenCalledTimes(1)
})

test.each([undefined, "another-owner"])(
  "registered Host with accountId %s cannot be read by current owner",
  async (accountId) => {
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
      hosts: [{ id: "host", config: { deviceId: "paired", accountId } }],
    })
    await expect(managedDesktopClient.list({ kind: "remote", hostId: "host" })).rejects.toThrow(
      "session_invalidated"
    )
    expect(withManagementChannel).not.toHaveBeenCalled()
    expect(localTransport.call).not.toHaveBeenCalled()
  }
)

test("lifecycle rejects a delayed remote quote after pairing ABA", async () => {
  const quote = deferred<unknown>()
  const transport = { call: jest.fn().mockReturnValue(quote.promise) }
  const listeners: Array<() => void> = []
  ;(useRemoteHostStore.subscribe as jest.Mock).mockImplementation((listener) => {
    listeners.push(listener)
    return jest.fn()
  })
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  const pending = managedDesktopClient.quote({ kind: "remote", hostId: "host" }, "byo", 3600)
  ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
    hosts: [{ id: "host", config: { deviceId: "repaired" } }],
  })
  listeners.forEach((listener) => listener())
  ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
    hosts: [{ id: "host", config: { deviceId: "paired", accountId: "owner" } }],
  })
  listeners.forEach((listener) => listener())
  quote.resolve({ id: "private-old-quote" })
  await expect(pending).rejects.toThrow("session_invalidated")
})

test("lifecycle preserves the active paired Host target without a remote store row", async () => {
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue({
    accountId: "owner",
    targetId: "paired-host",
    routingGeneration: 1,
  })
  ;(loadCompanionConfig as jest.Mock).mockReturnValue({
    targetId: "paired-host",
    accountId: "owner",
    deviceId: "paired",
    devicePrivateKeyJwk: { d: "private" },
    serviceToken: "private",
  })
  const call = jest.fn().mockResolvedValue([])
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({
      transport: { call },
      host: { config: { targetId: "paired-host", accountId: "owner", deviceId: "paired" } },
    })
  )
  await expect(
    managedDesktopClient.list({ kind: "remote", hostId: "companion:paired-host" })
  ).resolves.toEqual([])
  expect(call).toHaveBeenCalledWith("managed_desktop_list", {})
})

test("lifecycle preserves a registered Host manifest identity alias", async () => {
  ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
    hosts: [
      {
        id: "row-id",
        featureManifest: { schemaVersion: 2, hostIdentity: { id: "manifest-host" } },
        config: { deviceId: "paired", accountId: "owner" },
      },
    ],
  })
  const call = jest.fn().mockResolvedValue([])
  ;(withManagementChannel as jest.Mock).mockImplementation((_host, work) =>
    work({ transport: { call }, host: { config: { deviceId: "paired", accountId: "owner" } } })
  )
  await expect(
    managedDesktopClient.list({ kind: "remote", hostId: "manifest-host" })
  ).resolves.toEqual([])
})

test.each([undefined, "another-owner"])(
  "paired Host config with accountId %s cannot borrow the active owner identity",
  async (accountId) => {
    ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue({
      accountId: "owner",
      targetId: "paired-host",
      routingGeneration: 1,
    })
    ;(loadCompanionConfig as jest.Mock).mockReturnValue({
      targetId: "paired-host",
      deviceId: "paired",
      accountId,
    })
    await expect(
      managedDesktopClient.list({ kind: "remote", hostId: "companion:paired-host" })
    ).rejects.toThrow("session_invalidated")
    expect(withManagementChannel).not.toHaveBeenCalled()
  }
)

test("preserves versioned Host qualification projections without upgrading legacy replies", async () => {
  const legacy = {
    id: "legacy",
    qualification: "qualified",
    egressEnforcement: "provider-enforced",
  }
  const current = {
    id: "current",
    qualification: "qualified",
    qualificationEvidenceVersion: 2,
    workloadIsolationRevision: 1,
    egressEnforcement: "provider-and-guest-kernel",
  }
  ;(localTransport.call as jest.Mock).mockResolvedValue([legacy, current])
  expect(await managedDesktopClient.listConfigs({ kind: "local" })).toEqual([legacy, current])
  expect(legacy).not.toHaveProperty("qualificationEvidenceVersion")
})
