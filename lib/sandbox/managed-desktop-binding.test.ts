jest.mock("@/lib/automation/managed-desktop-client", () => ({
  managedDesktopClient: {
    list: jest.fn(),
    listConfigs: jest.fn(),
    delegate: jest.fn(),
    revokeDelegation: jest.fn(),
    listDelegations: jest.fn(),
  },
  watchManagedDesktopDelegations: jest.fn(() => jest.fn()),
  managedDesktopIdentityScope: jest.fn(),
}))
jest.mock("@/lib/db/sandbox-connections", () => ({
  ...jest.requireActual("@/lib/db/sandbox-connections"),
  getSandboxConnection: jest.fn(),
  listSandboxConnections: jest.fn(),
  putSandboxConnection: jest.fn(),
  deleteSandboxConnection: jest.fn(),
}))
jest.mock("@/lib/automation/managed-desktop-handoff-client", () => ({
  managedDesktopHandoffClient: { acceptanceList: jest.fn() },
  watchManagedDesktopAcceptance: jest.fn(() => jest.fn()),
}))
import { managedDesktopHandoffClient } from "@/lib/automation/managed-desktop-handoff-client"

import {
  managedDesktopClient,
  managedDesktopIdentityScope,
  watchManagedDesktopDelegations,
  type ManagedDesktopDelegation,
  type ManagedDesktopConfigSummary,
  type ManagedDesktopResource,
} from "@/lib/automation/managed-desktop-client"
import {
  getSandboxConnection,
  listSandboxConnections,
  putSandboxConnection,
  deleteSandboxConnection,
} from "@/lib/db/sandbox-connections"
import type { SandboxConnectionRow } from "@/types/sandbox"
import {
  bindManagedDesktop,
  unbindManagedDesktop,
  reconcileManagedDesktopBindings,
  requireManagedDesktopDelegation,
  watchManagedDesktopBindings,
  __resetManagedDesktopBindingsForTesting,
} from "./managed-desktop-binding"

const api = jest.mocked(managedDesktopClient)
const grantee = { kind: "session", sessionKey: "session" } as const
const request = { desktopId: "desktop", generation: 3, grantee }
const id = "managed:desktop:3"
let rows: Map<string, SandboxConnectionRow>
let live: ManagedDesktopDelegation[]
let identityEpoch = 0
function delegation(patch: Partial<ManagedDesktopDelegation> = {}): ManagedDesktopDelegation {
  return {
    id: "delegation",
    desktopId: "desktop",
    desktopGeneration: 3,
    providerConfigId: "config",
    grantee,
    mode: "computerUse",
    state: "live",
    endReason: null,
    expiresAt: Date.now() + 60_000,
    revision: 1,
    createdAt: Date.now(),
    endedAt: null,
    ...patch,
  }
}

beforeEach(() => {
  __resetManagedDesktopBindingsForTesting()
  jest.clearAllMocks()
  identityEpoch = 0
  jest.mocked(managedDesktopIdentityScope).mockImplementation((_target, onInvalidated) => {
    const epoch = identityEpoch
    return {
      account: undefined as never,
      hostConfig: undefined,
      assertActive: () => {
        if (epoch !== identityEpoch) {
          onInvalidated?.()
          throw new Error("managed_desktop_session_invalidated")
        }
      },
      assertChannel: jest.fn(),
      dispose: jest.fn(),
    }
  })
  rows = new Map()
  live = [delegation()]
  jest.mocked(managedDesktopHandoffClient.acceptanceList).mockResolvedValue({ runs: [] })
  api.list.mockResolvedValue([
    {
      id: "desktop",
      generation: 3,
      state: "running",
      providerConfigId: "config",
    } as ManagedDesktopResource,
  ])
  api.listConfigs.mockResolvedValue([
    {
      id: "config",
      qualification: "qualified",
      qualificationEvidenceVersion: 2,
      workloadIsolationRevision: 1,
      egressEnforcement: "provider-and-guest-kernel",
      enablement: { agentControl: true },
    } as ManagedDesktopConfigSummary,
  ])
  api.delegate.mockImplementation(async () => live[0])
  api.listDelegations.mockImplementation(async () => ({ delegations: live }))
  api.revokeDelegation.mockImplementation(async (_target, delegationId) => {
    const item = live.find((entry) => entry.id === delegationId)!
    live = live.filter((entry) => entry.id !== delegationId)
    return { ...item, state: "ended", endReason: "revoked" }
  })
  jest.mocked(getSandboxConnection).mockImplementation(async (key) => rows.get(key))
  jest.mocked(listSandboxConnections).mockImplementation(async () => [...rows.values()])
  jest.mocked(putSandboxConnection).mockImplementation(async (row) => {
    rows.set(row.id, row)
  })
  jest.mocked(deleteSandboxConnection).mockImplementation(async (key) => {
    rows.delete(key)
  })
})

it("projects a live acceptance delegation without minting another grant and admits only its attached child", async () => {
  live = [
    delegation({ grantee: { kind: "acceptance", acceptanceId: "acceptance" }, mode: "acceptance" }),
  ]
  jest.mocked(managedDesktopHandoffClient.acceptanceList).mockResolvedValue({
    runs: [
      {
        acceptanceId: "acceptance",
        childSessionKey: "child",
        state: "running",
        desktopId: "desktop",
        desktopGeneration: 3,
        providerConfigId: "config",
        delegationId: "delegation",
      },
    ],
  } as never)
  await reconcileManagedDesktopBindings()
  expect(api.delegate).not.toHaveBeenCalled()
  expect(rows.get(id)).toMatchObject({
    id,
    config: { delegationId: "delegation", desktopId: "desktop", generation: 3 },
    capabilities: { gui: true },
  })
  await expect(requireManagedDesktopDelegation(rows.get(id)!, "child")).resolves.toBeUndefined()
  await expect(requireManagedDesktopDelegation(rows.get(id)!, "other")).rejects.toMatchObject({
    code: "placement-unavailable",
  })
})

it("cannot borrow an ended, mismatched or unreadable acceptance run", async () => {
  live = [
    delegation({ grantee: { kind: "acceptance", acceptanceId: "acceptance" }, mode: "acceptance" }),
  ]
  await reconcileManagedDesktopBindings()
  const row = rows.get(id)!
  for (const patch of [
    { state: "completed" },
    { desktopGeneration: 4 },
    { acceptanceId: "other" },
    { delegationId: "other" },
  ]) {
    jest.mocked(managedDesktopHandoffClient.acceptanceList).mockResolvedValue({
      runs: [
        {
          acceptanceId: "acceptance",
          childSessionKey: "child",
          state: "running",
          desktopId: "desktop",
          desktopGeneration: 3,
          providerConfigId: "config",
          delegationId: "delegation",
          ...patch,
        },
      ],
    } as never)
    await expect(requireManagedDesktopDelegation(row, "child")).rejects.toMatchObject({
      code: "placement-unavailable",
    })
  }
  jest.mocked(managedDesktopHandoffClient.acceptanceList).mockRejectedValue(new Error("offline"))
  await expect(requireManagedDesktopDelegation(row, "child")).rejects.toMatchObject({
    code: "placement-unavailable",
  })
  live = []
  await reconcileManagedDesktopBindings()
  expect(rows.has(id)).toBe(false)
})

it("waits for a live Host delegation, writes the existing registry, then allows saving the target", async () => {
  let resolve!: (value: ManagedDesktopDelegation) => void
  api.delegate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const saveSetting = jest.fn()
  const binding = bindManagedDesktop(request).then(saveSetting)
  await new Promise((done) => setTimeout(done, 0))
  expect(putSandboxConnection).not.toHaveBeenCalled()
  expect(saveSetting).not.toHaveBeenCalled()
  resolve(live[0])
  await binding
  expect(api.delegate).toHaveBeenCalledWith({ kind: "local" }, request)
  expect(rows.get(id)).toMatchObject({
    id,
    provider: "e2b",
    driver: "computer-server",
    state: "running",
    capabilities: { gui: true, workspaceExec: false },
    config: {
      desktopId: "desktop",
      generation: 3,
      delegationId: "delegation",
      agentControl: true,
      target: { kind: "local" },
    },
  })
  expect(jest.mocked(putSandboxConnection).mock.invocationCallOrder[0]).toBeLessThan(
    saveSetting.mock.invocationCallOrder[0]
  )
  expect(saveSetting).toHaveBeenCalledWith(id)
})

it.each([
  { state: "ended" as const },
  { expiresAt: 1 },
  { desktopGeneration: 4 },
  { grantee: { kind: "session" as const, sessionKey: "other" } },
])("never writes a refused or mismatched delegation: %j", async (patch) => {
  live = [delegation(patch)]
  await expect(bindManagedDesktop(request)).rejects.toMatchObject({
    code: "placement-unavailable",
    message: "managed_delegation_missing",
  })
  expect(putSandboxConnection).not.toHaveBeenCalled()
})

it("does not write when delegate fails or the configuration cannot grant GUI", async () => {
  api.delegate.mockRejectedValueOnce(new Error("Host refused"))
  await expect(bindManagedDesktop(request)).rejects.toThrow("Host refused")
  expect(putSandboxConnection).not.toHaveBeenCalled()
  api.listConfigs.mockResolvedValueOnce([])
  await expect(bindManagedDesktop(request)).rejects.toThrow("managed_delegation_missing")
  expect(api.delegate).toHaveBeenCalledTimes(1)
})

it("revokes before removing the row and refuses subsequent calls", async () => {
  await bindManagedDesktop(request)
  const row = rows.get(id)!
  await unbindManagedDesktop(id, grantee)
  expect(api.revokeDelegation).toHaveBeenCalledWith({ kind: "local" }, "delegation", 1)
  expect(api.revokeDelegation.mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(deleteSandboxConnection).mock.invocationCallOrder[0]
  )
  expect(rows.has(id)).toBe(false)
  await expect(requireManagedDesktopDelegation(row, "session")).rejects.toMatchObject({
    message: "managed_delegation_missing",
  })
})

it("prunes ended generations from Host events without using stale event data", async () => {
  await bindManagedDesktop(request)
  const stop = watchManagedDesktopBindings()
  live = []
  jest.mocked(watchManagedDesktopDelegations).mock.calls[0][1]([delegation()])
  await new Promise((done) => setTimeout(done, 0))
  expect(rows.has(id)).toBe(false)
  stop()
})

it("keeps the binding watcher alive after a transient picker closes", async () => {
  await bindManagedDesktop(request)
  const persistentEvent = jest.mocked(watchManagedDesktopDelegations).mock.calls[0][1]
  const persistentStop = jest.mocked(watchManagedDesktopDelegations).mock.results[0].value
  const closePicker = watchManagedDesktopBindings()
  closePicker()
  expect(persistentStop).not.toHaveBeenCalled()
  live = []
  persistentEvent([])
  await new Promise((done) => setTimeout(done, 0))
  expect(rows.has(id)).toBe(false)
  expect(persistentStop).toHaveBeenCalled()
})

it("keeps watching restored rows after a transient picker reconciles then closes", async () => {
  await bindManagedDesktop(request)
  __resetManagedDesktopBindingsForTesting()
  jest.mocked(watchManagedDesktopDelegations).mockClear()
  const closePicker = watchManagedDesktopBindings()
  jest.mocked(watchManagedDesktopDelegations).mock.calls[0][1](live)
  await new Promise((done) => setTimeout(done, 0))
  const persistentEvent = jest.mocked(watchManagedDesktopDelegations).mock.calls[1][1]
  closePicker()
  live = []
  persistentEvent([])
  await new Promise((done) => setTimeout(done, 0))
  expect(rows.has(id)).toBe(false)
})

it("does not write through a new account after a suspended binding DB read", async () => {
  jest.mocked(getSandboxConnection).mockImplementationOnce(async () => {
    identityEpoch++
    return undefined
  })
  await expect(bindManagedDesktop(request)).rejects.toThrow("managed_desktop_session_invalidated")
  expect(putSandboxConnection).not.toHaveBeenCalled()
  expect(deleteSandboxConnection).not.toHaveBeenCalled()
  expect(api.revokeDelegation).not.toHaveBeenCalled()
})

it("does not delete a new account's rows after a suspended reconciliation DB read", async () => {
  await bindManagedDesktop(request)
  live = []
  jest.mocked(listSandboxConnections).mockImplementationOnce(async () => {
    identityEpoch++
    return [...rows.values()]
  })
  await expect(reconcileManagedDesktopBindings()).rejects.toThrow(
    "managed_desktop_session_invalidated"
  )
  expect(deleteSandboxConnection).not.toHaveBeenCalled()
})

it("fences the identity of queued operations when they are requested", async () => {
  let finish!: (value: ManagedDesktopDelegation) => void
  api.delegate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done
      })
  )
  const first = bindManagedDesktop(request)
  await new Promise((done) => setTimeout(done, 0))
  const queued = reconcileManagedDesktopBindings()
  identityEpoch++
  const settled = Promise.allSettled([first, queued])
  finish(live[0])
  expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"])
  expect(api.listDelegations).not.toHaveBeenCalled()
  expect(putSandboxConnection).not.toHaveBeenCalled()
})

it("accepts only this session or the bound character", async () => {
  await bindManagedDesktop(request)
  const row = rows.get(id)!
  await expect(requireManagedDesktopDelegation(row, "other")).rejects.toThrow(
    "managed_delegation_missing"
  )
  live = [delegation({ grantee: { kind: "character", characterId: "agent" } })]
  await expect(requireManagedDesktopDelegation(row, "other", "agent")).resolves.toBeUndefined()
  await expect(requireManagedDesktopDelegation(row, "other", "wrong-agent")).rejects.toThrow(
    "managed_delegation_missing"
  )
})

it("retains another grantee's live routing projection when one delegation ends", async () => {
  await bindManagedDesktop(request)
  live.push(
    delegation({ id: "character-delegation", grantee: { kind: "character", characterId: "agent" } })
  )
  await unbindManagedDesktop(id, grantee)
  expect(rows.get(id)?.config).toMatchObject({ delegationId: "character-delegation" })
  await expect(
    requireManagedDesktopDelegation(rows.get(id)!, "other", "agent")
  ).resolves.toBeUndefined()
})

it("does not remove a target when Host revocation fails", async () => {
  await bindManagedDesktop(request)
  api.revokeDelegation.mockRejectedValueOnce(new Error("offline"))
  await expect(unbindManagedDesktop(id, grantee)).rejects.toThrow("offline")
  expect(rows.has(id)).toBe(true)
})

it("revokes the Host delegation even if its local row is already absent", async () => {
  await bindManagedDesktop(request)
  rows.clear()
  await unbindManagedDesktop(id, grantee)
  expect(api.revokeDelegation).toHaveBeenCalledWith({ kind: "local" }, "delegation", 1)
})

it("refuses placement with the managed reason when the Host cannot confirm authority", async () => {
  await bindManagedDesktop(request)
  api.listDelegations.mockRejectedValueOnce(new Error("Host offline"))
  await expect(requireManagedDesktopDelegation(rows.get(id)!, "session")).rejects.toMatchObject({
    code: "placement-unavailable",
    message: "managed_delegation_missing",
  })
})

it("revokes a delegation if its row cannot be persisted", async () => {
  jest.mocked(putSandboxConnection).mockRejectedValueOnce(new Error("database unavailable"))
  await expect(bindManagedDesktop(request)).rejects.toThrow("database unavailable")
  expect(api.revokeDelegation).toHaveBeenCalledTimes(1)
  expect(rows.has(id)).toBe(false)
})

it("preserves another live grantee's row when persisting a new binding fails", async () => {
  await bindManagedDesktop(request)
  const character = delegation({
    id: "character",
    grantee: { kind: "character", characterId: "agent" },
  })
  live.push(character)
  api.delegate.mockResolvedValueOnce(character)
  jest.mocked(putSandboxConnection).mockRejectedValueOnce(new Error("database unavailable"))
  await expect(
    bindManagedDesktop({ ...request, grantee: { kind: "character", characterId: "agent" } })
  ).rejects.toThrow("database unavailable")
  expect(rows.get(id)?.config).toMatchObject({ delegationId: "delegation" })
})

it("does not revoke an idempotently reused delegation on a projection failure", async () => {
  await bindManagedDesktop(request)
  jest.mocked(putSandboxConnection).mockRejectedValueOnce(new Error("database unavailable"))
  await expect(bindManagedDesktop(request)).rejects.toThrow("database unavailable")
  expect(api.revokeDelegation).not.toHaveBeenCalled()
  expect(rows.get(id)?.config).toMatchObject({ delegationId: "delegation" })
})
