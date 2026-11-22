import Dexie from "dexie"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  cancelMemoryJob,
  claimMemoryJob,
  enqueueMemoryJob,
  getMemoryJob,
} from "@/lib/db/memory-governance"
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"
import { createMemory, getMemory, moveMemoryToNamespace, updateMemory } from "@/lib/db/memories"
import { buildAutoExtractionDeps } from "@/lib/memory/write/run-memory-extraction"
import {
  consolidate,
  consolidationOpMemoryId,
  type ConsolidateInput,
  type ConsolidationCandidate,
} from "@/lib/memory/consolidate/consolidator"
import type {
  RunProjectMiningDeps,
  RunProjectMiningInput,
} from "@/lib/memory/write/run-project-mining"
import { DEFAULT_MEMORY_CONFIG, type Memory } from "@/types/memory/memory"
import { drainMemoryJobs, processMemoryJob } from "./job-worker"
import { revokeClaimsForDeletedSession } from "./claim-deletion-closure"

const mockGetSettings = jest.fn()
const mockBuildVectorReader = jest.fn()
const mockBuildProjectMiningDeps = jest.fn()

// Keep the real extractor, consolidator, worker, and Dexie writes. Only the
// provider/vector transport and unrelated history projections are substituted.
jest.mock("@/lib/db/settings", () => ({
  ...jest.requireActual("@/lib/db/settings"),
  getSettings: () => mockGetSettings(),
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: (id: string) => getDb().sessions.get(id),
}))
jest.mock("@/lib/db/messages", () => ({
  listMessages: (id: string) => getDb().messages.where("sessionId").equals(id).sortBy("createdAt"),
}))
jest.mock("@/lib/db/characters", () => ({
  ...jest.requireActual("@/lib/db/characters"),
  resolveCharacterById: async () => undefined,
}))
jest.mock("@/lib/execution/personal-visibility", () => ({
  preparePersonalHistory: async (_id: unknown, messages: unknown[]) => ({
    messages,
    withheldMessageIds: [],
  }),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: () => ({ complete: (...args: unknown[]) => mockComplete(...args) }),
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: () => mockBuildMemoryDeps(),
  tryBuildMemoryVectorReader: (...args: unknown[]) => mockBuildVectorReader(...args),
  tryBuildMemoryVectorSink: async () => ({
    upsert: mockUpsert,
    listIds: mockListVectorIds,
    delete: mockRemoveVectors,
  }),
  withPersonalMemoryVisibility: (deps: unknown) => deps,
  filterPersonalMemories: (rows: unknown[]) => rows,
}))
jest.mock("@/lib/memory/retrieve/retriever", () => ({
  retrieveMemories: () => mockRetrieveMemories(),
}))
jest.mock("@/lib/memory/write/run-project-mining", () => ({
  buildProjectMiningDeps: (...args: unknown[]) => mockBuildProjectMiningDeps(...args),
  runProjectMining: (...args: unknown[]) => mockRunProjectMining(...args),
}))

const mockComplete = jest.fn()
const mockUpsert = jest.fn()
const mockBuildMemoryDeps = jest.fn()
const mockRetrieveMemories = jest.fn()
const mockListVectorIds = jest.fn()
const mockRemoveVectors = jest.fn()
const mockRunProjectMining = jest.fn()
const mockConsolidateProjectClaims = jest.fn()
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: { enabled: true, learnFromChats: true } })
  mockBuildMemoryDeps.mockResolvedValue(undefined)
  mockBuildVectorReader.mockResolvedValue(undefined)
  mockBuildProjectMiningDeps.mockImplementation(async () => ({
    consolidate: (input: ConsolidateInput) => mockConsolidateProjectClaims(input),
  }))
  mockListVectorIds.mockResolvedValue([])
  mockUpsert.mockImplementation(async (id: string, text: string) => {
    expect(Dexie.currentTransaction).toBeNull()
    expect(await getDb().memories.get(id)).toMatchObject({ text })
  })
  await getDb().sessions.put({ id: "source", transcriptRevision: 0 } as never)
  await getDb().messages.bulkPut([
    {
      id: "user",
      sessionId: "source",
      role: "user",
      createdAt: 1,
      parts: [{ type: "text", text: "I always use pnpm" }],
    },
    {
      id: "assistant",
      sessionId: "source",
      role: "assistant",
      createdAt: 2,
      parts: [{ type: "text", text: "Noted." }],
    },
  ] as never)
})
afterAll(fixture.dispose)

const reply = JSON.stringify({
  memories: [{ type: "semantic", text: "The user uses pnpm", importance: 6 }],
})

async function enqueue() {
  return enqueueMemoryJob({
    dedupeKey: "turn-extraction:source:turn:2",
    kind: "turn-extraction",
    sessionId: "source",
    scope: "global",
    provenance: "user",
    evidenceIds: [],
  })
}

describe("durable turn-extraction persistence", () => {
  it.each(["outside", "inside"])(
    "fences exactly the recent extractor window when a message %s it is deleted",
    async (position) => {
      await getDb().messages.bulkPut(
        Array.from({ length: 12 }, (_, index) => ({
          id: `older-${index}`,
          sessionId: "source",
          role: "user",
          createdAt: index - 12,
          parts: [{ type: "text", text: `earlier context ${index}` }],
        })) as never
      )
      let started!: () => void
      let release!: (text: string) => void
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      mockComplete.mockImplementationOnce(() => {
        started()
        return new Promise<string>((resolve) => {
          release = resolve
        })
      })
      const job = await enqueueMemoryJob({
        dedupeKey: "turn-extraction:source:turn:14",
        kind: "turn-extraction",
        sessionId: "source",
        scope: "global",
        provenance: "user",
        evidenceIds: [],
      })
      const running = drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
      await Promise.race([
        entered,
        running.then(() => {
          throw new Error("Extractor was not called")
        }),
      ])
      await getDb().messages.delete(position === "outside" ? "older-0" : "older-11")
      release(reply)
      await running
      expect(await getMemoryJob(job.id)).toMatchObject(
        position === "outside"
          ? { status: "succeeded" }
          : { status: "skipped", resultCode: "source_deleted" }
      )
      expect(await getDb().memories.count()).toBe(position === "outside" ? 1 : 0)
      expect(mockUpsert).toHaveBeenCalledTimes(position === "outside" ? 1 : 0)
    }
  )

  it.each(["session-deleted", "message-deleted", "cancelled", "reclaimed"])(
    "writes no canonical memory, evidence or vectors after %s during the provider call",
    async (change) => {
      let release!: (value: string) => void
      let started!: () => void
      const providerStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      mockComplete.mockImplementationOnce(() => {
        started()
        return new Promise<string>((resolve) => {
          release = resolve
        })
      })
      const job = await enqueue()
      const running = drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
      await providerStarted
      if (change === "session-deleted") {
        await getDb().transaction("rw", [getDb().sessions, getDb().messages], async () => {
          await getDb().sessions.delete("source")
          await getDb().messages.where("sessionId").equals("source").delete()
        })
        await revokeClaimsForDeletedSession("source")
      } else if (change === "message-deleted") {
        await getDb().messages.delete("user")
      } else if (change === "cancelled") {
        await cancelMemoryJob(job.id)
      } else {
        const claimed = await getMemoryJob(job.id)
        await claimMemoryJob(job.id, "worker", claimed!.leaseExpiresAt! + 1)
      }
      release(reply)
      await expect(running).resolves.toBe(1)
      expect(await getDb().memories.count()).toBe(0)
      expect(await getDb().memoryEvidence.count()).toBe(0)
      expect(mockUpsert).not.toHaveBeenCalled()
      expect(await getDb().memoryAuditEvents.count()).toBe(0)
      const state = await getMemoryJob(job.id)
      expect(state?.status).toBe(
        change === "reclaimed" ? "running" : change === "message-deleted" ? "skipped" : "cancelled"
      )
      if (change === "reclaimed") expect(state?.fencingEpoch).toBe(2)
    }
  )

  it("skips stale model output when a source message is edited in-place during extraction (N10)", async () => {
    let release!: (value: string) => void
    let started!: () => void
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    mockComplete.mockImplementationOnce(() => {
      started()
      return new Promise<string>((resolve) => {
        release = resolve
      })
    })
    const job = await enqueue()
    const running = drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
    await providerStarted
    await getDb().messages.update("user", {
      parts: [{ type: "text", text: "I always use yarn" }],
    } as never)
    release(reply)
    await expect(running).resolves.toBe(1)
    expect(await getDb().memories.count()).toBe(0)
    expect(await getDb().memoryEvidence.count()).toBe(0)
    expect(await getDb().memoryAuditEvents.count()).toBe(0)
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(await getMemoryJob(job.id)).toMatchObject({
      status: "skipped",
      resultCode: "source_changed",
    })
  })

  it("upserts only committed canonical rows and records their embedded text hash", async () => {
    mockComplete.mockResolvedValue(reply)
    const job = await enqueue()
    await drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
    expect(await getMemoryJob(job.id)).toMatchObject({ status: "succeeded" })
    const [memory] = await getDb().memories.toArray()
    expect(memory).toMatchObject({
      text: "The user uses pnpm",
      vectorDocId: memory.id,
      vectorTextHash: hashContent(memory.text),
    })
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    expect(await getDb().memoryEvidence.count()).toBe(1)
  })

  it("binds evidence before vector I/O so deletion can revoke a committed candidate while the vector is pending", async () => {
    mockComplete.mockResolvedValue(reply)
    let started!: () => void
    let release!: () => void
    const vectorStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    mockUpsert.mockImplementationOnce(() => {
      started()
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const job = await enqueue()
    const running = drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
    await vectorStarted
    const [memory] = await getDb().memories.toArray()
    expect(await getDb().memoryEvidence.toArray()).toEqual([
      expect.objectContaining({ memoryId: memory.id, sessionId: "source" }),
    ])
    await getDb().sessions.delete("source")
    await getDb().messages.where("sessionId").equals("source").delete()
    await revokeClaimsForDeletedSession("source")
    release()
    await running
    expect(await getMemoryJob(job.id)).toMatchObject({ status: "cancelled" })
    expect(await getDb().memoryEvidence.toArray()).toEqual([
      expect.objectContaining({ memoryId: memory.id, validationState: "revoked" }),
    ])
    // The pre-deletion candidate is fully evidenced. No receipt/governance write
    // may land after deletion just because the vector transport finally returns.
    expect(await getMemory(memory.id)).toMatchObject({ text: memory.text })
    expect((await getMemory(memory.id))?.vectorTextHash).toBeUndefined()
    expect(await getDb().memories.count()).toBe(1)
  })

  it("rolls back the canonical row if its atomic evidence binding fails", async () => {
    mockComplete.mockResolvedValue(reply)
    const failEvidence = () => {
      throw new Error("evidence storage failed")
    }
    const db = getDb()
    db.memoryEvidence.hook("creating", failEvidence)
    try {
      const job = await enqueue()
      await drainMemoryJobs({ maxJobs: 1 })
      expect(await getMemoryJob(job.id)).toMatchObject({ status: "retry_wait" })
      expect(await db.memories.count()).toBe(0)
      expect(await db.memoryEvidence.count()).toBe(0)
      expect(await db.memoryAuditEvents.count()).toBe(0)
      expect(mockUpsert).not.toHaveBeenCalled()
    } finally {
      db.memoryEvidence.hook("creating").unsubscribe(failEvidence)
    }
  })

  it("binds earlier candidates before a later judge call and stops later writes when the source is deleted", async () => {
    const target = await createMemory({
      id: "other",
      text: "The user uses npm",
      scope: "global",
      type: "semantic",
      provenance: "user",
      importance: 5,
    })
    mockBuildMemoryDeps.mockResolvedValue({})
    mockRetrieveMemories.mockResolvedValueOnce([]).mockResolvedValueOnce([{ memory: target }])
    let started!: () => void
    let release!: (value: string) => void
    const judgeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    mockComplete
      .mockResolvedValueOnce(
        JSON.stringify({
          memories: [
            { type: "semantic", text: "The user prefers Rust", importance: 5 },
            { type: "semantic", text: "The user uses pnpm", importance: 5 },
          ],
        })
      )
      .mockImplementationOnce(() => {
        started()
        return new Promise<string>((resolve) => {
          release = resolve
        })
      })
    const job = await enqueue()
    const running = drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
    await judgeStarted
    const [earlier] = (await getDb().memories.toArray()).filter((row) => row.id !== target.id)
    expect(await getDb().memoryEvidence.toArray()).toEqual([
      expect.objectContaining({ memoryId: earlier.id }),
    ])
    await getDb().sessions.delete("source")
    await getDb().messages.where("sessionId").equals("source").delete()
    await revokeClaimsForDeletedSession("source")
    release(JSON.stringify({ op: "UPDATE", targetId: target.id, mergedText: "The user uses pnpm" }))
    await running
    expect(await getMemory(target.id)).toEqual(target)
    expect(await getDb().memories.count()).toBe(2)
    expect(await getDb().memoryEvidence.toArray()).toEqual([
      expect.objectContaining({ memoryId: earlier.id, validationState: "revoked" }),
    ])
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    expect(await getMemoryJob(job.id)).toMatchObject({ status: "cancelled" })
  })

  it.each(["provider", "parse", "consolidation"])(
    "retries %s failures up to maxAttempts instead of caching no_output",
    async (failure) => {
      if (failure === "provider") mockComplete.mockRejectedValue(new Error("503"))
      else mockComplete.mockResolvedValue(failure === "parse" ? "malformed JSON" : reply)
      const rejectCreation = () => {
        throw new Error("canonical storage unavailable")
      }
      const db = getDb()
      if (failure === "consolidation") db.memories.hook("creating", rejectCreation)
      try {
        const job = await enqueue()
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          await drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
          const state = await getMemoryJob(job.id)
          expect(state).toMatchObject({ attempt, status: attempt === 4 ? "failed" : "retry_wait" })
          if (attempt < 4) await db.memoryJobs.update(job.id, { nextAttemptAt: Date.now() - 1 })
        }
        expect(await db.memories.count()).toBe(0)
        expect(await db.memoryEvidence.count()).toBe(0)
        expect(mockUpsert).not.toHaveBeenCalled()
        expect((await enqueue()).id).not.toBe(job.id)
      } finally {
        if (failure === "consolidation") db.memories.hook("creating").unsubscribe(rejectCreation)
      }
    }
  )

  it("settles a successful empty extraction as no_output and reuses it", async () => {
    mockComplete.mockResolvedValue('{"memories":[]}')
    const job = await enqueue()
    await drainMemoryJobs({ maxJobs: 1 })
    expect(await getMemoryJob(job.id)).toMatchObject({
      status: "no_output",
      resultCode: "nothing_durable",
    })
    const duplicate = await enqueueMemoryJob(
      {
        dedupeKey: job.dedupeKey,
        kind: job.kind,
        sessionId: job.sessionId,
        scope: job.scope,
        provenance: job.provenance,
        evidenceIds: [],
      },
      { reuseCompleted: true }
    )
    expect(duplicate.id).toBe(job.id)
  })

  it.each(["UPDATE", "DELETE", "CONFLICT"])(
    "fences %s after source deletion during the consolidation provider call",
    async (op) => {
      const existing = await createMemory({
        id: "existing",
        text: "The user uses npm",
        scope: "global",
        type: "semantic",
        provenance: "user",
        importance: 5,
      })
      mockBuildMemoryDeps.mockResolvedValue({})
      mockRetrieveMemories.mockResolvedValue([{ memory: existing }])
      let started!: () => void
      let release!: (reply: string) => void
      const judgeStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      mockComplete.mockResolvedValueOnce(reply).mockImplementationOnce(() => {
        started()
        return new Promise<string>((resolve) => {
          release = resolve
        })
      })
      const job = await enqueue()
      const running = drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
      await judgeStarted
      await getDb().messages.delete("user")
      release(JSON.stringify({ op, targetId: existing.id, mergedText: "The user uses pnpm" }))
      await running
      expect(await getMemory(existing.id)).toEqual(existing)
      expect(await getDb().memories.count()).toBe(1)
      expect(await getDb().memoryEvidence.count()).toBe(0)
      expect(await getDb().memoryAuditEvents.count()).toBe(0)
      expect(mockUpsert).not.toHaveBeenCalled()
      expect(await getMemoryJob(job.id)).toMatchObject({
        status: "skipped",
        resultCode: "source_deleted",
      })
    }
  )

  it("repairs a failed text-update upsert even when the old backend document still exists", async () => {
    const oldText = "The user uses npm"
    const newText = "The user uses pnpm"
    const existing = await createMemory({
      id: "indexed",
      text: oldText,
      scope: "global",
      type: "semantic",
      provenance: "user",
      importance: 5,
      vectorDocId: "indexed",
      vectorTextHash: hashContent(oldText),
    })
    mockBuildMemoryDeps.mockResolvedValue({})
    mockRetrieveMemories.mockResolvedValue([{ memory: existing }])
    mockComplete.mockResolvedValue(
      JSON.stringify({ op: "UPDATE", targetId: "indexed", mergedText: newText })
    )
    mockUpsert.mockRejectedValueOnce(new Error("vector unavailable"))
    mockListVectorIds.mockResolvedValue(["indexed"])
    const deps = await buildAutoExtractionDeps(
      { session: null, appSettings: null },
      DEFAULT_MEMORY_CONFIG
    )
    await deps!.consolidate({
      candidates: [{ type: "semantic", text: newText, importance: 5 }],
      scope: "global",
      provenance: "user",
    })
    expect(await getMemory("indexed")).toMatchObject({
      text: newText,
    })
    expect(await getMemory("indexed")).not.toHaveProperty("vectorTextHash")
    await processMemoryJob({ ...(await enqueue()), kind: "vector-reconcile" })
    expect(await getMemory("indexed")).toMatchObject({ vectorTextHash: hashContent(newText) })
    expect(mockUpsert).toHaveBeenLastCalledWith("indexed", newText)
    // A later text edit, without any vector transport, still exposes drift.
    await updateMemory("indexed", { text: "The user uses bun" })
    expect(await getMemory("indexed")).not.toHaveProperty("vectorTextHash")
  })

  it("re-embeds A after A → B → A when B's upsert succeeds but cancellation fences its receipt", async () => {
    const textA = "The user uses npm"
    const textB = "The user uses pnpm"
    const existing = await createMemory({
      id: "indexed",
      text: textA,
      scope: "global",
      type: "semantic",
      provenance: "user",
      importance: 5,
      vectorDocId: "indexed",
      vectorTextHash: hashContent(textA),
    })
    const vectors = new Map([[existing.id, textA]])
    mockBuildMemoryDeps.mockResolvedValue({})
    mockRetrieveMemories.mockResolvedValue([{ memory: existing }])
    mockComplete
      .mockResolvedValueOnce(reply)
      .mockResolvedValueOnce(
        JSON.stringify({ op: "UPDATE", targetId: existing.id, mergedText: textB })
      )
    const job = await enqueue()
    mockUpsert.mockImplementationOnce(async (id: string, text: string) => {
      expect(Dexie.currentTransaction).toBeNull()
      vectors.set(id, text)
      await cancelMemoryJob(job.id)
    })
    await drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
    expect(await getMemoryJob(job.id)).toMatchObject({ status: "cancelled" })
    expect(await getMemory(existing.id)).toMatchObject({ text: textB })
    expect(vectors.get(existing.id)).toBe(textB)

    // A manual edit has no vector transport. It must not revive A's old receipt.
    await updateMemory(existing.id, { text: textA })
    expect(await getMemory(existing.id)).not.toHaveProperty("vectorTextHash")
    mockListVectorIds.mockResolvedValue([existing.id])
    mockUpsert.mockImplementation(async (id: string, text: string) => {
      vectors.set(id, text)
    })
    await expect(processMemoryJob({ ...job, kind: "vector-reconcile" })).resolves.toEqual({
      status: "succeeded",
      resultCode: "vectors_reconciled",
    })
    expect(mockUpsert).toHaveBeenLastCalledWith(existing.id, textA)
    expect(vectors.get(existing.id)).toBe(textA)
    expect((await getMemory(existing.id))?.vectorTextHash).toBe(hashContent(textA))
  })
})

describe("project-mining governance fence", () => {
  describe.each(["ADD", "CONFLICT", "QUARANTINE", "UPDATE"] as const)("%s", (op) => {
    it.each(["unchanged", "moved", "branch-moved", "path-moved", "cancelled"] as const)(
      "uses the written namespace with character/agent jobs and branch/path claims: %s",
      async (change) => {
        await getDb().sessions.update("source", { projectId: "p1", characterId: "c1" })
        const existing =
          op === "ADD"
            ? undefined
            : await createMemory({
                id: "claim",
                text: "old constraint",
                scope: "workspace",
                projectId: "p1",
                branch: "main",
                pathPattern: "src/**",
                type: "semantic",
                provenance: "user",
                importance: 5,
                projectMemoryKind: "constraint",
                reviewStatus: "verified",
                evidenceState: "legacy",
                contaminationState: "unknown",
                vectorDocId: "claim",
                vectorTextHash: hashContent("old constraint"),
              })
        const job = await enqueueMemoryJob({
          dedupeKey: "project-mining:source:user:assistant:2",
          kind: "project-mining",
          sessionId: "source",
          // The miner targets workspace, without the queued character/agent ids.
          scope: "character",
          characterId: "c1",
          agentId: "a1",
          provenance: "user",
          evidenceIds: [],
        })
        const candidate: ConsolidationCandidate = {
          type: "semantic",
          text: "new constraint",
          importance: 5,
          projectClaim: {
            projectMemoryKind: "constraint",
            evidence: [{ kind: "message", sourceId: "user" }],
          },
        }
        // Exercise persistCandidate's actual scope rules and the real UPDATE
        // operation shape, rather than reproducing those rules in a fixture.
        mockConsolidateProjectClaims.mockImplementationOnce((input: ConsolidateInput) =>
          consolidate(input, {
            client: {
              complete: async () =>
                op === "QUARANTINE"
                  ? "invalid JSON"
                  : JSON.stringify({ op, targetId: existing?.id, mergedText: candidate.text }),
            },
            findSimilar: async () => (existing ? [existing] : []),
            persist: (input) => createMemory({ ...input, id: "created-claim" }),
            update: async (id, text) => {
              await updateMemory(id, { text, bumpVersion: true })
              return { ok: true }
            },
            invalidate: async () => {
              throw new Error("unexpected_forget")
            },
          })
        )
        let memoryId!: string
        let afterCanonical!: Memory
        mockRunProjectMining.mockImplementationOnce(
          async (input: RunProjectMiningInput, deps: RunProjectMiningDeps) => {
            const result = await deps.consolidate({
              scope: input.scope,
              projectId: input.projectId,
              characterId: input.characterId,
              agentId: input.agentId,
              provenance: input.provenance,
              candidates: [candidate],
              branch: "main",
              pathPattern: "src/**",
              failureMode: "quarantine",
            })
            expect(result.applied[0]?.op).toBe(op)
            memoryId = consolidationOpMemoryId(result.applied[0]!)!
            expect(await getMemory(memoryId)).toMatchObject({
              scope: "workspace",
              projectId: "p1",
              branch: "main",
              pathPattern: "src/**",
            })
            expect((await getMemory(memoryId))?.characterId).toBeUndefined()
            expect((await getMemory(memoryId))?.agentId).toBeUndefined()
            if (change === "moved") await moveMemoryToNamespace(memoryId, { scope: "global" })
            if (change === "branch-moved")
              await getDb().memories.update(memoryId, { branch: "release" })
            if (change === "path-moved")
              await getDb().memories.update(memoryId, { pathPattern: "docs/**" })
            if (change === "cancelled") await cancelMemoryJob(job.id)
            afterCanonical = (await getMemory(memoryId))!
            return {
              ...result,
              redactedExcerpts: new Map([["user", "constraint evidence"]]),
            }
          }
        )
        await drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
        expect(await getMemory(memoryId)).toMatchObject({ text: "new constraint" })
        expect(await getMemory(memoryId)).not.toHaveProperty("vectorTextHash")
        if (change === "unchanged") {
          expect(await getMemory(memoryId)).toMatchObject({
            scope: "workspace",
            projectId: "p1",
            evidenceState: "supported",
            reviewStatus: op === "CONFLICT" ? "conflict" : "unreviewed",
          })
          expect(await getDb().memoryEvidence.count()).toBe(1)
          expect(await getDb().memoryAuditEvents.toArray()).toEqual([
            expect.objectContaining({ memoryId, reason: "project_mining" }),
          ])
        } else {
          expect(await getMemory(memoryId)).toEqual(afterCanonical)
          expect(await getDb().memoryEvidence.count()).toBe(0)
          expect(await getDb().memoryAuditEvents.toArray()).toEqual(
            change === "cancelled"
              ? []
              : [expect.objectContaining({ memoryId, reason: "target_moved" })]
          )
        }
        expect(await getMemoryJob(job.id)).toMatchObject({
          status: change === "cancelled" ? "cancelled" : "succeeded",
        })
      }
    )
  })

  it("writes zero episodic memories or evidence when session-distill is cancelled mid-call (N9)", async () => {
    await getDb().messages.bulkPut([
      {
        id: "user-2",
        sessionId: "source",
        role: "user",
        createdAt: 3,
        parts: [{ type: "text", text: "Let us standardize on pnpm across workspaces" }],
      },
      {
        id: "assistant-2",
        sessionId: "source",
        role: "assistant",
        createdAt: 4,
        parts: [{ type: "text", text: "Done, workspaces use pnpm." }],
      },
    ] as never)
    let release!: (value: string) => void
    let started!: () => void
    const distillStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    mockComplete.mockImplementationOnce(() => {
      started()
      return new Promise<string>((resolve) => {
        release = resolve
      })
    })
    const job = await enqueueMemoryJob({
      dedupeKey: "session-distill:source:assistant-2:4",
      kind: "session-distill",
      sessionId: "source",
      scope: "global",
      provenance: "user",
      evidenceIds: [],
    })
    const running = drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
    await distillStarted
    await cancelMemoryJob(job.id)
    release(JSON.stringify({ episodes: [{ text: "Standardized on pnpm", importance: 7 }] }))
    await expect(running).resolves.toBe(1)
    expect(await getDb().memories.count()).toBe(0)
    expect(await getDb().memoryEvidence.count()).toBe(0)
    expect(await getDb().memoryAuditEvents.count()).toBe(0)
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(await getMemoryJob(job.id)).toMatchObject({ status: "cancelled" })
  })

  it.each(["job-cancelled", "run-cancelled"] as const)(
    "writes zero project claims or evidence when real project-mining hits %s mid-call (N9)",
    async (mode) => {
      const actualMining = jest.requireActual(
        "@/lib/memory/write/run-project-mining"
      ) as typeof import("@/lib/memory/write/run-project-mining")
      mockBuildProjectMiningDeps.mockImplementation((...args: unknown[]) =>
        (actualMining.buildProjectMiningDeps as (...a: unknown[]) => unknown)(...args)
      )
      mockRunProjectMining.mockImplementation((...args: unknown[]) =>
        (actualMining.runProjectMining as (...a: unknown[]) => unknown)(...args)
      )
      await getDb().sessions.update("source", { projectId: "p1" })
      await getDb().messages.bulkPut([
        {
          id: "user",
          sessionId: "source",
          role: "user",
          createdAt: 1,
          parts: [
            {
              type: "text",
              text: "why does pnpm build fail in packages/memory/src/index.ts",
            },
          ],
        },
        {
          id: "assistant",
          sessionId: "source",
          role: "assistant",
          createdAt: 2,
          parts: [
            {
              type: "text",
              text: "it must be in SERVER_ONLY_PACKAGES, because the static export breaks otherwise",
            },
          ],
        },
      ] as never)
      await getDb().projectMiningRuns.put({
        id: "pmr_n9",
        projectId: "p1",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        sessionsTotal: 1,
        sessionsScanned: 0,
        windowsQueued: 1,
        claimsCreated: 0,
      } as never)
      let release!: (value: string) => void
      let started!: () => void
      const extractStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      mockComplete.mockImplementationOnce(() => {
        started()
        return new Promise<string>((resolve) => {
          release = resolve
        })
      })
      const job = await enqueueMemoryJob({
        dedupeKey: "project-mining:pmr_n9:source:user:assistant:2",
        kind: "project-mining",
        runId: "pmr_n9",
        sessionId: "source",
        projectId: "p1",
        scope: "workspace",
        provenance: "user",
        evidenceIds: [],
      })
      const running = drainMemoryJobs({ workerId: "worker", maxJobs: 1 })
      await extractStarted
      if (mode === "job-cancelled") {
        await cancelMemoryJob(job.id)
      } else {
        await getDb().projectMiningRuns.update("pmr_n9", { status: "cancelled" })
      }
      release(
        JSON.stringify({
          claims: [
            {
              text: "Keep packages/memory in SERVER_ONLY_PACKAGES so static export succeeds",
              kind: "constraint",
              importance: 7,
              confidence: 0.9,
              observedAtMessageId: "user",
              supportRole: "user",
              evidence: [
                { kind: "message", sourceId: "user" },
                { kind: "message", sourceId: "assistant" },
              ],
            },
          ],
        })
      )
      await expect(running).resolves.toBe(1)
      expect(await getDb().memories.count()).toBe(0)
      expect(await getDb().memoryEvidence.count()).toBe(0)
      expect(await getDb().memoryAuditEvents.count()).toBe(0)
      expect(mockUpsert).not.toHaveBeenCalled()
      expect(await getMemoryJob(job.id)).toMatchObject(
        mode === "job-cancelled"
          ? { status: "cancelled" }
          : { status: "skipped", resultCode: "job_claim_lost" }
      )
    }
  )

  it("preserves concurrent user edit and pin during memory-lifecycle-sweep (N11)", async () => {
    const DAY = 24 * 60 * 60 * 1000
    const oldTime = Date.now() - 365 * DAY
    const longColdText = "We debugged a subtle migration edge case across multiple workspaces. "
      .repeat(6)
      .trim()
    const m1 = await createMemory({
      id: "cold-1",
      text: longColdText,
      scope: "global",
      type: "episodic",
      provenance: "user",
      importance: 1,
    })
    const m2 = await createMemory({
      id: "cold-2",
      text: `${longColdText} Second occurrence.`,
      scope: "global",
      type: "episodic",
      provenance: "user",
      importance: 1,
    })
    await getDb().memories.update(m1.id, { createdAt: oldTime, lastAccessedAt: oldTime })
    await getDb().memories.update(m2.id, { createdAt: oldTime, lastAccessedAt: oldTime })
    mockGetSettings.mockResolvedValue({
      memory: {
        enabled: true,
        compactColdEpisodic: true,
        dedupColdClusters: true,
        coldRetentionThreshold: 0.99,
      },
    })
    mockBuildVectorReader.mockResolvedValue({
      getEmbeddings: async (rows: Memory[]) => {
        // User edits & pins m1 AFTER listActive captured the cold snapshot!
        await updateMemory(m1.id, {
          text: "User corrected and pinned fact",
          pinned: true,
          bumpVersion: true,
        })
        return new Map(rows.map((row) => [row.id, [1, 0, 0]]))
      },
    })
    const sweepJob = await enqueueMemoryJob({
      dedupeKey: "memory-lifecycle-sweep:2026-11-22",
      kind: "memory-lifecycle-sweep",
      scope: "global",
      provenance: "user",
      evidenceIds: [],
    })
    await processMemoryJob(sweepJob)
    const afterM1 = await getMemory(m1.id)
    expect(afterM1).toMatchObject({
      text: "User corrected and pinned fact",
      pinned: true,
      status: "active",
    })
    expect(afterM1?.compactedAt).toBeUndefined()
  })
})
