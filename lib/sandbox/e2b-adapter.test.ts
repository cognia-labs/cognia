jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))
import { localTransport } from "@/lib/tauri/transport-instance"
jest.mock("@/lib/automation/managed-desktop-client", () => ({ managedDesktopClient: {} }))
import type { SandboxConnectionRow } from "@/types/sandbox"
import type { ManagedDesktopClient } from "@/lib/automation/managed-desktop-client"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import { buildE2bSandboxAdapter } from "./e2b-adapter"
import { runSandboxOperation, type SandboxAdapterOutcome } from "./lifecycle-contract"

function row(qualified = false): SandboxConnectionRow {
  return {
    id: "row",
    name: "desktop",
    provider: "e2b",
    driver: "computer-server",
    config: {
      provider: "e2b",
      providerConfigId: "byo",
      target: { kind: "remote", hostId: "host-b" },
      desktopId: "desktop",
      generation: 2,
      qualification: qualified ? "qualified" : "unqualified",
      qualificationEvidenceVersion: 2,
      workloadIsolationRevision: 1,
      egressEnforcement: "provider-and-guest-kernel",
    },
    state: "uninitialized",
    capabilities: defaultSandboxCapabilities("e2b", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: 0,
    updatedAt: 0,
  }
}
function client() {
  return {
    create: jest.fn(),
    connect: jest.fn(),
    health: jest.fn(),
    delete: jest.fn(),
  } as unknown as jest.Mocked<ManagedDesktopClient>
}

test("unqualified create refuses even with a forged stored capability", async () => {
  const source = row()
  const api = client()
  const adapter = buildE2bSandboxAdapter(source, {}, { managedClient: api })
  await expect(
    runSandboxOperation(adapter, { ...source, connectionId: source.id }, "create", (a) =>
      a.create?.({ ...source, connectionId: source.id })
    )
  ).rejects.toMatchObject({ code: "provider-unqualified" })
  expect(api.create).not.toHaveBeenCalled()
})

test("a qualified create still requires Host-recorded authorization", async () => {
  const source = row(true)
  const api = client()
  const adapter = buildE2bSandboxAdapter(source, {}, { managedClient: api })
  await expect(adapter.create!({ ...source, connectionId: source.id })).rejects.toMatchObject({
    code: "authorization-required",
  })
  expect(api.create).not.toHaveBeenCalled()
})

test("connect and cleanup remain Host-bound while unqualified", async () => {
  const source = row()
  const api = client()
  const outcome: SandboxAdapterOutcome = {}
  const resource = { id: "desktop", generation: 2, state: "running" }
  api.connect.mockResolvedValue(resource as never)
  const adapter = buildE2bSandboxAdapter(source, outcome, { managedClient: api })
  const ctx = { ...source, connectionId: source.id }
  await adapter.connect!(ctx)
  expect(api.connect).toHaveBeenCalledWith(
    source.config.provider === "e2b" ? source.config.target : null,
    { desktopId: "desktop", generation: 2 }
  )
  expect(outcome.managedDesktop).toEqual(resource)
  await adapter.delete!(ctx)
  expect(api.delete).toHaveBeenCalled()
})

test("Phase 1 never advertises GUI, workspace, pause, resume or stop", async () => {
  const source = row(true)
  const api = client()
  const adapter = buildE2bSandboxAdapter(source, {}, { managedClient: api })
  for (const operation of [
    "gui",
    "workspaceRead",
    "workspaceExec",
    "suspend",
    "resume",
    "start",
    "stop",
  ] as const) {
    await expect(
      runSandboxOperation(adapter, { ...source, connectionId: source.id }, operation, () =>
        Promise.resolve()
      )
    ).rejects.toMatchObject({ code: "unsupported-operation" })
  }
})

test.each([undefined, 0, 1, 3])(
  "legacy evidence %s cannot create despite qualified and authorized flags",
  async (version) => {
    const source = row(true)
    if (source.config.provider !== "e2b") throw new Error("fixture")
    source.config.qualificationEvidenceVersion = version
    const api = client()
    const adapter = buildE2bSandboxAdapter(
      source,
      {},
      {
        managedClient: api,
        managedCreation: {
          providerConfigId: "byo",
          quoteId: "q",
          authorizationId: "a",
          idempotencyKey: "k",
        },
      }
    )
    await expect(adapter.create!({ ...source, connectionId: source.id })).rejects.toMatchObject({
      code: "provider-unqualified",
    })
    expect(api.create).not.toHaveBeenCalled()
  }
)

test("qualified workspace routes to the exact managed id and passes the grantee without Host fallback", async () => {
  const source = row(true)
  source.id = "managed:desktop:2"
  source.state = "running"
  if (source.config.provider !== "e2b") throw new Error("fixture")
  source.config = {
    ...source.config,
    target: { kind: "local" },
    delegationId: "grant",
    agentControl: true,
    ...{ operationsQualified: true },
  }
  const adapter = buildE2bSandboxAdapter(
    source,
    {},
    { managedAgent: { sessionKey: "session", characterId: "character" } }
  )
  jest.mocked(localTransport.call).mockResolvedValue({ exitCode: 0 })
  const ctx = { ...source, connectionId: source.id }
  await adapter.workspaceExec!(ctx, { argv: ["id"] })
  expect(localTransport.call).toHaveBeenLastCalledWith(
    "cua_sandbox_exec",
    expect.objectContaining({
      connectionId: "managed:desktop:2",
      sessionKey: "session",
      characterId: "character",
      argv: ["id"],
    })
  )
  await adapter.workspaceRead!(ctx, "/home/cua/file")
  expect(localTransport.call).toHaveBeenLastCalledWith(
    "cua_sandbox_read_file",
    expect.objectContaining({
      connectionId: "managed:desktop:2",
      sessionKey: "session",
      path: "/home/cua/file",
    })
  )
  await expect(
    buildE2bSandboxAdapter(source, {}).workspaceExec!(ctx, { argv: ["id"] })
  ).rejects.toThrow("managed_desktop_delegation_required")
})

test("managed workspace refuses stale Host truth and unattested execution policy", async () => {
  const source = row(true)
  source.id = "managed:desktop:2"
  source.state = "running"
  if (source.config.provider !== "e2b") throw new Error("fixture")
  source.config = {
    ...source.config,
    target: { kind: "local" },
    delegationId: "grant",
    agentControl: true,
    ...{ operationsQualified: false },
  }
  const ctx = { ...source, connectionId: source.id }
  const unavailable = buildE2bSandboxAdapter(
    source,
    {},
    { managedAgent: { sessionKey: "session" } }
  )
  await expect(unavailable.workspaceRead!(ctx, "/home/cua/a")).rejects.toMatchObject({
    code: "provider-unqualified",
  })
  await expect(unavailable.workspaceExec!(ctx, { argv: ["id"] })).rejects.toMatchObject({
    code: "provider-unqualified",
  })
  source.config = { ...source.config, ...{ operationsQualified: true } }
  const adapter = buildE2bSandboxAdapter(source, {}, { managedAgent: { sessionKey: "session" } })
  await expect(
    adapter.workspaceExec!(ctx, { argv: ["cat"], stdin: "normal file write" })
  ).rejects.toThrow("managed_desktop_exec_env_stdin_unsupported")
  await expect(adapter.workspaceExec!(ctx, { argv: ["id"], env: { CI: "1" } })).rejects.toThrow(
    "managed_desktop_exec_env_stdin_unsupported"
  )
  await expect(
    adapter.workspaceExec!(ctx, {
      argv: ["id"],
      policy: {
        readable: [],
        writable: [],
        targetFiles: [],
        maxCpuSeconds: 1,
        maxMemoryMb: 0,
        network: "off",
        networkHosts: [],
      },
    })
  ).rejects.toMatchObject({ code: "policy-not-attested" })
  await expect(
    buildE2bSandboxAdapter(source, {}).workspaceRead!(ctx, "/home/cua/a")
  ).rejects.toThrow("managed_desktop_delegation_required")
})

test("managed exec attests nested cwd and fixed VM shape before dispatch", async () => {
  const source = row(true)
  source.id = "managed:desktop:2"
  source.state = "running"
  if (source.config.provider !== "e2b") throw new Error("fixture")
  source.config = {
    ...source.config,
    target: { kind: "local" },
    delegationId: "grant",
    agentControl: true,
    ...{ operationsQualified: true, cpuCount: 2, memoryMb: 2048 },
  }
  const adapter = buildE2bSandboxAdapter(source, {}, { managedAgent: { sessionKey: "session" } })
  const ctx = { ...source, connectionId: source.id }
  const policy = {
    readable: ["/home/cua/project/src"],
    writable: ["/home/cua/project"],
    targetFiles: [],
    maxCpuSeconds: 1,
    maxMemoryMb: 1,
    network: "off" as const,
    networkHosts: [],
  }
  jest.mocked(localTransport.call).mockClear().mockResolvedValue({ exitCode: 0 })
  await adapter.workspaceExec!(ctx, {
    argv: ["bash", "-lc", "pwd"],
    cwd: "/home/cua/project",
    policy,
  })
  expect(localTransport.call).toHaveBeenCalledTimes(1)
  expect(localTransport.call).toHaveBeenLastCalledWith(
    "cua_sandbox_exec",
    expect.objectContaining({ cwd: "/home/cua/project" })
  )
  jest.mocked(localTransport.call).mockClear()
  for (const request of [
    { argv: ["id"], cwd: "/etc" },
    { argv: ["id"], policy: { ...policy, network: "allowlist" as const } },
    { argv: ["id"], policy: { ...policy, readable: ["/etc/passwd"] } },
  ])
    await expect(adapter.workspaceExec!(ctx, request)).rejects.toMatchObject({
      code: "policy-not-attested",
    })
  await expect(adapter.workspaceRead!(ctx, "/etc/passwd")).rejects.toMatchObject({
    code: "policy-not-attested",
  })
  expect(localTransport.call).not.toHaveBeenCalled()
})
