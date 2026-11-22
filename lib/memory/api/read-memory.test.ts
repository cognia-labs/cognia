import {
  authorizeMemoryRead,
  countMemoriesExternal,
  getMemoryExternal,
  listMemoriesExternal,
  narrowReaderToCaller,
} from "./read-memory"
import { localUserCaller } from "./caller"
import type { TrustedMemoryCaller } from "@cognia/memory/types/caller"
import type { Memory } from "@/types/memory/memory"

const mockGetSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
}))

const mockListMemories = jest.fn()
const mockGetMemory = jest.fn()
jest.mock("@/lib/db/memories", () => ({
  listMemories: (...args: unknown[]) => mockListMemories(...(args as [])),
  getMemory: (...args: unknown[]) => mockGetMemory(...(args as [])),
}))

const mockResolvePolicy = jest.fn()
jest.mock("@/lib/memory/agent-policy", () => ({
  resolvePersistedAgentMemoryPolicy: (...args: unknown[]) => mockResolvePolicy(...args),
}))

const mockFilterPairedMemories = jest.fn()
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  filterPairedMemories: (...args: unknown[]) => mockFilterPairedMemories(...args),
}))

function row(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    text: "fact",
    scope: "global",
    type: "semantic",
    importance: 5,
    provenance: "external",
    evidenceState: "legacy",
    reviewStatus: "unreviewed",
    contaminationState: "unknown",
    sensitivity: "unknown",
    status: "active",
    tags: [],
    pinned: false,
    version: 1,
    accessCount: 0,
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
  mockResolvePolicy.mockResolvedValue({
    canRecall: true,
    readableScopes: ["global", "workspace", "character", "agent"],
  })
  mockListMemories.mockResolvedValue([])
  mockGetMemory.mockResolvedValue(undefined)
  mockFilterPairedMemories.mockImplementation(async (rows: Memory[], reader: unknown) =>
    reader === "owner" ? rows : rows.filter((item) => item.provenance !== "user")
  )
})

describe("authorizeMemoryRead", () => {
  it("rechecks persisted principal grants on every call and excludes global data", async () => {
    const caller: TrustedMemoryCaller = { principalId: "plugin:p", transport: "plugin" }
    mockGetSettings.mockResolvedValue({
      memory: { principalGrants: { "plugin:p": { scopes: ["workspace"], projects: ["p1"] } } },
    })
    const first = await authorizeMemoryRead(caller)
    expect(first.ok && first.read.isAuthorized(row())).toBe(false)
    expect(first.ok && first.read.isAuthorized(row({ scope: "workspace", projectId: "p1" }))).toBe(
      true
    )
    mockGetSettings.mockResolvedValue({
      memory: { principalGrants: { "plugin:p": { scopes: [] } } },
    })
    const revoked = await authorizeMemoryRead(caller)
    expect(
      revoked.ok && revoked.read.isAuthorized(row({ scope: "workspace", projectId: "p1" }))
    ).toBe(false)
  })

  it("denies when memory is disabled or temporary", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    expect(await authorizeMemoryRead(localUserCaller())).toEqual({
      ok: false,
      reason: "disabled",
    })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    expect(await authorizeMemoryRead(localUserCaller())).toEqual({
      ok: false,
      reason: "temporary",
    })
  })

  it("denies when the resolved policy forbids recall", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: false, readableScopes: [] })
    expect(await authorizeMemoryRead(localUserCaller())).toEqual({
      ok: false,
      reason: "policy_denied",
    })
  })

  it("resolves the policy from the caller binding, never the request", async () => {
    const caller: TrustedMemoryCaller = {
      principalId: "plugin:demo",
      transport: "plugin",
      policyCharacterId: "agent-1",
      sessionId: "sess-1",
    }
    await authorizeMemoryRead(caller)
    expect(mockResolvePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "agent-1", sessionId: "sess-1" })
    )
  })

  it("authorizes rows by readable scope and caller namespaces", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: true, readableScopes: ["global"] })
    const caller: TrustedMemoryCaller = {
      principalId: "plugin:demo",
      transport: "plugin",
      namespaces: { projects: ["p1"] },
    }
    const result = await authorizeMemoryRead(caller)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.read.isAuthorized(row({ scope: "global" }))).toBe(true)
    expect(result.read.isAuthorized(row({ scope: "workspace" }))).toBe(false)
    expect(result.read.isAuthorized(row({ scope: "global", projectId: "p9" }))).toBe(false)
    expect(result.read.isAuthorized(row({ scope: "global", projectId: "p1" }))).toBe(true)
  })
})

describe("narrowReaderToCaller", () => {
  const bounded: TrustedMemoryCaller = {
    principalId: "plugin:demo",
    transport: "plugin",
    namespaces: { projects: ["p1"], characterIds: ["c1"], agentIds: ["a1"] },
  }

  it("passes request filters through for an unconstrained caller", () => {
    expect(narrowReaderToCaller({ projectId: "p9", characterId: "c9" }, localUserCaller())).toEqual(
      { projectId: "p9", characterId: "c9" }
    )
  })

  it("keeps in-set filters and fails closed on an out-of-set one", () => {
    expect(narrowReaderToCaller({ projectId: "p1" }, bounded)).toEqual(
      expect.objectContaining({ projectId: "p1" })
    )
    expect(narrowReaderToCaller({ projectId: "p9" }, bounded)).toBeNull()
    expect(narrowReaderToCaller({ agentId: "a9" }, bounded)).toBeNull()
  })
})

describe("listMemoriesExternal", () => {
  it("returns only rows the caller may see, bounded by limit", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: true, readableScopes: ["global"] })
    mockListMemories.mockResolvedValue([
      row({ id: "in-scope", scope: "global" }),
      row({ id: "out-scope", scope: "workspace" }),
    ])
    const result = await listMemoriesExternal({}, localUserCaller())
    expect(result).toEqual({
      ok: true,
      memories: [expect.objectContaining({ id: "in-scope" })],
    })
  })

  it("returns an empty result rather than revealing an unauthorized namespace", async () => {
    const caller: TrustedMemoryCaller = {
      principalId: "plugin:demo",
      transport: "plugin",
      namespaces: { projects: ["p1"] },
    }
    const result = await listMemoriesExternal({ projectId: "p9" }, caller)
    expect(result).toEqual({ ok: true, memories: [] })
    expect(mockListMemories).not.toHaveBeenCalled()
  })

  it("propagates the deny reason from the authorization boundary", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    expect(await listMemoriesExternal({}, localUserCaller())).toEqual({
      ok: false,
      reason: "disabled",
    })
  })

  it("clamps the limit to the documented range", async () => {
    mockListMemories.mockResolvedValue(Array.from({ length: 250 }, (_, i) => row({ id: `m-${i}` })))
    const result = await listMemoriesExternal({ limit: 10_000 }, localUserCaller())
    if (result.ok) expect(result.memories).toHaveLength(200)
  })
})

describe("getMemoryExternal", () => {
  it("returns the row when authorized, undefined when invisible", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: true, readableScopes: ["global"] })
    mockGetMemory.mockResolvedValue(row({ scope: "global" }))
    expect(await getMemoryExternal("m1", localUserCaller())).toMatchObject({ id: "m1" })

    mockGetMemory.mockResolvedValue(row({ scope: "workspace" }))
    expect(await getMemoryExternal("m1", localUserCaller())).toBeUndefined()
  })

  it("returns undefined when reads are denied", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: false, readableScopes: [] })
    expect(await getMemoryExternal("m1", localUserCaller())).toBeUndefined()
    expect(mockGetMemory).not.toHaveBeenCalled()
  })

  it("hides a revision snapshot even when its scope is readable", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: true, readableScopes: ["global"] })
    mockGetMemory.mockResolvedValue(
      row({
        id: "snap1",
        scope: "global",
        status: "invalidated",
        revisionOf: "m1",
        supersededById: "m1",
      })
    )
    expect(await getMemoryExternal("snap1", localUserCaller())).toBeUndefined()
    expect(mockGetMemory).toHaveBeenCalledWith("snap1")
  })

  it("still returns an ordinary invalidated (non-snapshot) row", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: true, readableScopes: ["global"] })
    mockGetMemory.mockResolvedValue(row({ scope: "global", status: "invalidated" }))
    expect(await getMemoryExternal("m1", localUserCaller())).toMatchObject({
      id: "m1",
      status: "invalidated",
    })
  })
})

describe("countMemoriesExternal", () => {
  it("counts only authorized active rows in a readable scope", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: true, readableScopes: ["global"] })
    mockListMemories.mockResolvedValue([
      row({ id: "a", scope: "global" }),
      row({ id: "b", scope: "global", projectId: "p1" }),
    ])
    const caller: TrustedMemoryCaller = {
      principalId: "plugin:demo",
      transport: "plugin",
      namespaces: { projects: ["p1"] },
    }
    expect(await countMemoriesExternal("global", caller)).toBe(2)
  })

  it("reads as 0 for a scope the caller cannot read or a foreign characterId", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: true, readableScopes: ["global"] })
    expect(await countMemoriesExternal("workspace", localUserCaller())).toBe(0)

    const caller: TrustedMemoryCaller = {
      principalId: "plugin:demo",
      transport: "plugin",
      namespaces: { characterIds: ["c1"] },
    }
    expect(await countMemoriesExternal("global", caller, "c9")).toBe(0)
    expect(mockListMemories).not.toHaveBeenCalled()
  })

  it("withholds owner-personal memories from paired member callers across list, get, and count", async () => {
    const personal = row({ id: "owner-personal", provenance: "user", text: "owner secret" })
    const shared = row({ id: "shared-fact", provenance: "external", text: "shared fact" })
    mockListMemories.mockResolvedValue([personal, shared])
    mockGetMemory.mockImplementation(async (id: string) =>
      id === "owner-personal" ? personal : id === "shared-fact" ? shared : undefined
    )

    const memberCaller: TrustedMemoryCaller = {
      principalId: "companion:dev-member",
      transport: "companion",
      pairedReader: "member",
    }
    const ownerCaller: TrustedMemoryCaller = {
      principalId: "companion:dev-owner",
      transport: "companion",
      pairedReader: "owner",
    }

    const memberList = await listMemoriesExternal({}, memberCaller)
    expect(memberList).toEqual({ ok: true, memories: [shared] })
    await expect(getMemoryExternal("owner-personal", memberCaller)).resolves.toBeUndefined()
    await expect(getMemoryExternal("shared-fact", memberCaller)).resolves.toEqual(shared)
    await expect(countMemoriesExternal("global", memberCaller)).resolves.toBe(1)

    const ownerList = await listMemoriesExternal({}, ownerCaller)
    expect(ownerList).toEqual({ ok: true, memories: [personal, shared] })
    await expect(getMemoryExternal("owner-personal", ownerCaller)).resolves.toEqual(personal)
    await expect(countMemoriesExternal("global", ownerCaller)).resolves.toBe(2)
  })
})
