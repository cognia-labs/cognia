import Dexie from "dexie"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createMemory, getMemory, moveMemoryToNamespace } from "@/lib/db/memories"
import { DEFAULT_MEMORY_CONFIG, type Memory } from "@/types/memory/memory"
import type { ChatSession } from "@cognia/agent-config-types"
import { claimMemoryJob, enqueueMemoryJob, withMemoryJobWrite } from "@/lib/db/memory-governance"
import type { ConsolidationPermissions } from "@/lib/memory/consolidate/consolidator"
import { storeMemoryCore } from "@/lib/memory/api/store-memory"
import { withConsolidationTarget } from "./guarded-consolidation-write"
import { buildAutoExtractionDeps } from "./run-memory-extraction"
import { buildProjectMiningDeps } from "./run-project-mining"

jest.mock("@/lib/ai/generation/utility-client", () => ({ buildUtilityLlmClient: jest.fn() }))
jest.mock("@/lib/ai/generation/agent-backed-client", () => ({
  buildAgentBackedLlmClient: jest.fn(),
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: jest.fn(async () => ({})),
  tryBuildMemoryVectorSink: jest.fn(async () => undefined),
  withPersonalMemoryVisibility: (deps: unknown) => deps,
}))
jest.mock("@/lib/memory/retrieve/retriever", () => ({ retrieveMemories: jest.fn() }))
jest.mock("@/lib/memory/agent-policy", () => ({
  ...jest.requireActual("@/lib/memory/agent-policy"),
  resolvePersistedAgentMemoryPolicy: jest.fn(),
}))

import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { buildAgentBackedLlmClient } from "@/lib/ai/generation/agent-backed-client"
import { retrieveMemories } from "@/lib/memory/retrieve/retriever"
import { tryBuildMemoryVectorSink } from "@/lib/memory/runtime/build-deps"
import {
  resolveAgentMemoryPolicy,
  resolvePersistedAgentMemoryPolicy,
} from "@/lib/memory/agent-policy"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.mocked(tryBuildMemoryVectorSink).mockResolvedValue(undefined)
  jest.mocked(resolvePersistedAgentMemoryPolicy).mockResolvedValue(
    resolveAgentMemoryPolicy({
      config: DEFAULT_MEMORY_CONFIG,
      agentPolicy: {
        operations: { recall: true, create: true, update: true, forget: true },
        readableScopes: ["workspace"],
        writableScopes: ["workspace"],
        autoLearn: true,
      },
    })
  )
})
afterAll(fixture.dispose)

const namespace = { scope: "workspace" as const, projectId: "project" }
const candidate = { type: "semantic" as const, text: "Uses pnpm now", importance: 6 }
const permissions: ConsolidationPermissions = {
  canUpdate: true,
  canForget: true,
  scopeAllowed: (_operation, scope) => scope === "workspace",
}

describe.each([
  ["extraction", buildAutoExtractionDeps],
  ["project mining", buildProjectMiningDeps],
] as const)("%s namespace guard with real Dexie", (_name, buildDeps) => {
  it.each(["UPDATE", "DELETE", "CONFLICT"])(
    "defers %s when the target moves while the judge runs",
    async (op) => {
      const target = await createMemory({
        ...namespace,
        type: "semantic",
        text: "Uses npm",
        importance: 5,
        provenance: "user",
      })
      jest
        .mocked(retrieveMemories)
        .mockImplementation(async () => [{ memory: (await getMemory(target.id))! }] as never)
      let moved: Memory | undefined
      const complete = jest.fn(async () => {
        moved = await moveMemoryToNamespace(target.id, { scope: "global" })
        return JSON.stringify({ op, targetId: target.id, mergedText: candidate.text })
      })
      jest.mocked(buildUtilityLlmClient).mockReturnValue({ complete })
      jest.mocked(buildAgentBackedLlmClient).mockResolvedValue({ complete })
      const deps = await buildDeps({ session: null, appSettings: null }, DEFAULT_MEMORY_CONFIG)
      const result = await deps!.consolidate({
        ...namespace,
        permissions,
        candidates: [candidate],
        provenance: "user",
      })
      expect(result.applied).toMatchObject([
        { op: "CONFLICT", targetId: target.id, reason: "target_moved" },
      ])
      expect(await getMemory(target.id)).toEqual(moved)
      const rows = (await getDb().memories.toArray()).filter((row) => row.id !== target.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        ...namespace,
        text: candidate.text,
        reviewStatus: "conflict",
        conflictWithIds: [target.id],
      })
      expect(await getDb().memoryAuditEvents.toArray()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ memoryId: rows[0].id, reason: "target_moved" }),
        ])
      )
    }
  )

  it.each(["UPDATE", "DELETE", "CONFLICT"])("applies %s to an unchanged target", async (op) => {
    const target = await createMemory({
      ...namespace,
      type: "semantic",
      text: "Uses npm",
      importance: 5,
      provenance: "user",
    })
    jest.mocked(retrieveMemories).mockResolvedValue([{ memory: target }] as never)
    const complete = async () =>
      JSON.stringify({ op, targetId: target.id, mergedText: candidate.text })
    jest.mocked(buildUtilityLlmClient).mockReturnValue({ complete })
    jest.mocked(buildAgentBackedLlmClient).mockResolvedValue({ complete })
    const deps = await buildDeps({ session: null, appSettings: null }, DEFAULT_MEMORY_CONFIG)
    const result = await deps!.consolidate({
      ...namespace,
      permissions,
      candidates: [candidate],
      provenance: "user",
    })
    expect(result.applied.map((item) => item.op)).toEqual(
      op === "DELETE" ? ["DELETE", "ADD"] : [op]
    )
    const current = (await getMemory(target.id))!
    if (op === "UPDATE") expect(current).toMatchObject({ text: candidate.text, version: 2 })
    if (op === "DELETE") {
      expect(current.status).toBe("invalidated")
      expect(await getMemory(current.supersededById!)).toMatchObject({
        text: candidate.text,
        reviewStatus: "unreviewed",
        conflictWithIds: [],
      })
    }
    if (op === "CONFLICT") expect(current.reviewStatus).toBe("conflict")
    expect(Dexie.currentTransaction).toBeNull()
  })

  it.each(["UPDATE", "DELETE", "CONFLICT"])(
    "refuses %s when policy changes at write time",
    async (op) => {
      const target = await createMemory({
        ...namespace,
        type: "semantic",
        text: "Uses npm",
        importance: 5,
        provenance: "user",
      })
      jest.mocked(retrieveMemories).mockResolvedValue([{ memory: target }] as never)
      const complete = async () =>
        JSON.stringify({ op, targetId: target.id, mergedText: candidate.text })
      jest.mocked(buildUtilityLlmClient).mockReturnValue({ complete })
      jest.mocked(buildAgentBackedLlmClient).mockResolvedValue({ complete })
      const deps = await buildDeps({ session: null, appSettings: null }, DEFAULT_MEMORY_CONFIG)
      const result = await deps!.consolidate({
        ...namespace,
        provenance: "user",
        candidates: [candidate],
        permissions: {
          ...permissions,
          scopeAllowed: () => !Dexie.currentTransaction,
        },
      })
      expect(result.applied).toMatchObject([
        { op: "CONFLICT", reason: op === "DELETE" ? "forget_denied" : "update_denied" },
      ])
      expect(await getMemory(target.id)).toEqual(target)
      expect(await getDb().memories.count()).toBe(2)
    }
  )

  it.each(["moved", "deleted"])(
    "refuses DELETE when its replacement draft is %s during vector I/O",
    async (change) => {
      const target = await createMemory({
        ...namespace,
        type: "semantic",
        text: "Uses npm",
        importance: 5,
        provenance: "user",
      })
      jest.mocked(retrieveMemories).mockResolvedValue([{ memory: target }] as never)
      const complete = async () => JSON.stringify({ op: "DELETE", targetId: target.id })
      jest.mocked(buildUtilityLlmClient).mockReturnValue({ complete })
      jest.mocked(buildAgentBackedLlmClient).mockResolvedValue({ complete })
      let replacementId: string | undefined
      let moved: Memory | undefined
      jest.mocked(tryBuildMemoryVectorSink).mockResolvedValue({
        delete: async () => undefined,
        upsert: async (id) => {
          expect(Dexie.currentTransaction).toBeNull()
          replacementId = id
          if (change === "moved") moved = await moveMemoryToNamespace(id, { scope: "global" })
          else await getDb().memories.delete(id)
        },
      })
      const deps = await buildDeps({ session: null, appSettings: null }, DEFAULT_MEMORY_CONFIG)
      const result = await deps!.consolidate({
        ...namespace,
        provenance: "user",
        candidates: [candidate],
        permissions,
      })
      expect(result.applied).toMatchObject([
        { op: "CONFLICT", reason: change === "moved" ? "target_moved" : "target_unavailable" },
      ])
      expect(await getMemory(target.id)).toEqual(target)
      expect(await getMemory(replacementId!)).toEqual(moved)
      if (moved)
        expect(moved).toMatchObject({ reviewStatus: "conflict", conflictWithIds: [target.id] })
    }
  )
})

it.each(["UPDATE", "DELETE", "CONFLICT"])(
  "runs the %s guard inside the durable job transaction and vector I/O outside it",
  async (op) => {
    const db = getDb()
    await db.sessions.put({ id: "source-session" } as ChatSession)
    const queued = await enqueueMemoryJob({
      kind: "turn-extraction",
      dedupeKey: "guard-test",
      sessionId: "source-session",
      ...namespace,
      provenance: "user",
      evidenceIds: [],
    })
    const claimed = (await claimMemoryJob(queued.id, "worker"))!
    const target = await createMemory({
      ...namespace,
      type: "semantic",
      text: "Uses npm",
      importance: 5,
      provenance: "user",
    })
    jest.mocked(retrieveMemories).mockResolvedValue([{ memory: target }] as never)
    jest.mocked(buildUtilityLlmClient).mockReturnValue({
      complete: async () => JSON.stringify({ op, targetId: target.id, mergedText: candidate.text }),
    })
    const upsert = jest.fn(async () => {
      expect(Dexie.currentTransaction).toBeNull()
    })
    jest
      .mocked(tryBuildMemoryVectorSink)
      .mockResolvedValue({ upsert, delete: async () => undefined })
    let root: IDBTransaction | undefined
    let checked = 0
    const deps = await buildAutoExtractionDeps(
      {
        session: null,
        appSettings: null,
        withCanonicalWrite: (write) =>
          withMemoryJobWrite(claimed, [], async () => {
            root = Dexie.currentTransaction!.idbtrans
            return write()
          }),
        recordCanonicalOperation: async () => {
          expect(Dexie.currentTransaction!.idbtrans).toBe(root)
        },
      },
      DEFAULT_MEMORY_CONFIG
    )
    const result = await deps!.consolidate({
      ...namespace,
      provenance: "user",
      candidates: [candidate],
      permissions: {
        ...permissions,
        scopeAllowed: (_operation, scope) => {
          if (Dexie.currentTransaction) {
            checked += 1
            expect(Dexie.currentTransaction.idbtrans).toBe(root)
            expect(Dexie.currentTransaction.idbtrans!.objectStoreNames.contains("memoryJobs")).toBe(
              true
            )
          }
          return scope === "workspace"
        },
      },
    })
    expect(checked).toBeGreaterThan(0)
    expect(result.applied[0].op).toBe(op)
    expect(upsert).toHaveBeenCalled()
  }
)

it("keeps a DELETE replacement review-only when the target moves after its draft is persisted", async () => {
  const target = await createMemory({
    ...namespace,
    type: "semantic",
    text: "Uses npm",
    importance: 5,
    provenance: "user",
  })
  jest.mocked(retrieveMemories).mockResolvedValue([{ memory: target }] as never)
  jest.mocked(buildUtilityLlmClient).mockReturnValue({
    complete: async () => JSON.stringify({ op: "DELETE", targetId: target.id }),
  })
  let moved: Memory | undefined
  const upsert = jest.fn(async (id: string) => {
    expect(Dexie.currentTransaction).toBeNull()
    expect(await getMemory(id)).toMatchObject({
      reviewStatus: "conflict",
      conflictWithIds: [target.id],
    })
    moved = await moveMemoryToNamespace(target.id, { scope: "global" })
  })
  jest.mocked(tryBuildMemoryVectorSink).mockResolvedValue({ upsert, delete: async () => undefined })
  const deps = await buildAutoExtractionDeps(
    { session: null, appSettings: null },
    DEFAULT_MEMORY_CONFIG
  )
  const result = await deps!.consolidate({
    ...namespace,
    provenance: "user",
    candidates: [candidate],
    permissions,
  })
  expect(result.applied).toMatchObject([{ op: "CONFLICT", reason: "target_moved" }])
  expect(await getMemory(target.id)).toEqual(moved)
  expect(await getDb().memories.count()).toBe(2)
  expect((await getDb().memories.toArray()).filter((row) => row.id !== target.id)).toMatchObject([
    { reviewStatus: "conflict", conflictWithIds: [target.id] },
  ])
})

it("rechecks namespace for owner writes without permissions and never invokes their mutation", async () => {
  const target = await createMemory({
    ...namespace,
    type: "semantic",
    text: "Uses npm",
    importance: 5,
    provenance: "user",
  })
  await moveMemoryToNamespace(target.id, { scope: "global" })
  const mutate = jest.fn(async () => undefined)
  expect(await withConsolidationTarget(target.id, { expected: target }, "update", mutate)).toEqual({
    ok: false,
    reason: "target_moved",
  })
  expect(mutate).not.toHaveBeenCalled()
})

it("rolls back DELETE invalidation and draft promotion together if canonical bookkeeping fails", async () => {
  const target = await createMemory({
    ...namespace,
    type: "semantic",
    text: "Uses npm",
    importance: 5,
    provenance: "user",
  })
  jest.mocked(retrieveMemories).mockResolvedValue([{ memory: target }] as never)
  jest.mocked(buildUtilityLlmClient).mockReturnValue({
    complete: async () => JSON.stringify({ op: "DELETE", targetId: target.id }),
  })
  const deps = await buildAutoExtractionDeps(
    {
      session: null,
      appSettings: null,
      recordCanonicalOperation: async (operation) => {
        if (operation.op === "ADD") throw new Error("bookkeeping failed")
      },
    },
    DEFAULT_MEMORY_CONFIG
  )
  await expect(
    deps!.consolidate({ ...namespace, provenance: "user", candidates: [candidate], permissions })
  ).rejects.toThrow("bookkeeping failed")
  expect(await getMemory(target.id)).toEqual(target)
  const rows = (await getDb().memories.toArray()).filter((row) => row.id !== target.id)
  expect(rows).toMatchObject([{ reviewStatus: "conflict", conflictWithIds: [target.id] }])
})

it.each(["UPDATE", "DELETE", "CONFLICT"])(
  "preserves the review draft through storeMemoryCore for %s",
  async (op) => {
    const target = await createMemory({
      ...namespace,
      type: "semantic",
      text: "Uses npm",
      importance: 5,
      provenance: "user",
    })
    jest.mocked(retrieveMemories).mockResolvedValue([{ memory: target }] as never)
    let moved: Memory | undefined
    jest.mocked(buildUtilityLlmClient).mockReturnValue({
      complete: async () => {
        moved = await moveMemoryToNamespace(target.id, { scope: "global" })
        return JSON.stringify({ op, targetId: target.id, mergedText: candidate.text })
      },
    })
    const result = await storeMemoryCore({
      ...namespace,
      text: candidate.text,
      provenance: "explicit",
    })
    expect(result).toMatchObject({
      ok: true,
      stored: true,
      consolidated: true,
      applied: ["CONFLICT"],
    })
    expect(await getMemory(target.id)).toEqual(moved)
    if (!result.ok) throw new Error("store refused")
    expect(await getMemory(result.memoryId!)).toMatchObject({
      reviewStatus: "conflict",
      conflictWithIds: [target.id],
    })
  }
)

it("skips vector receipts and store governance patches after a post-update relocation", async () => {
  const target = await createMemory({
    ...namespace,
    type: "semantic",
    text: "Uses npm",
    importance: 5,
    provenance: "user",
  })
  jest.mocked(retrieveMemories).mockResolvedValue([{ memory: target }] as never)
  jest.mocked(buildUtilityLlmClient).mockReturnValue({
    complete: async () =>
      JSON.stringify({ op: "UPDATE", targetId: target.id, mergedText: candidate.text }),
  })
  let moved: Memory | undefined
  jest.mocked(tryBuildMemoryVectorSink).mockResolvedValue({
    delete: async () => undefined,
    upsert: async () => {
      expect(Dexie.currentTransaction).toBeNull()
      moved = await moveMemoryToNamespace(target.id, { scope: "global" })
    },
  })
  const result = await storeMemoryCore({
    ...namespace,
    text: candidate.text,
    provenance: "explicit",
  })
  expect(result).toMatchObject({ ok: true, applied: ["UPDATE"] })
  expect(await getMemory(target.id)).toEqual(moved)
  expect((await getMemory(target.id))?.text).toBe(candidate.text)
  expect(await getDb().memoryEvidence.count()).toBe(0)
})
