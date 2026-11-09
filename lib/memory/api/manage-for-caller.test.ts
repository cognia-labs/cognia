/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  createMemory,
  getMemory,
  updateMemory,
  listMemoryRevisions,
  type MemoryCreateInput,
} from "@/lib/db/memories"
import {
  findMemoryOperation,
  memoryOperationRequestHash,
  recordMemoryOperation,
} from "@/lib/db/memory-operations"
import { refreshMemoryBeliefInputs } from "@/lib/db/memory-governance"
import { getDb } from "@/lib/db/schema"
import type { ManageMemoryCommand } from "@/lib/memory/control-plane/manage"
import { manageMemoryForCaller } from "./manage-for-caller"
import { updateExternalMemory } from "./mutate-memory"
import { isMemoryEligibleForRetrieval } from "@cognia/memory/retrieve/retriever"
import { companionCaller } from "./caller"

const mockManage = jest.fn()
jest.mock("@/lib/memory/control-plane/manage", () => ({
  manageMemory: (...args: unknown[]) => mockManage(...args),
}))

jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryVectorSink: jest.fn(async () => undefined),
}))

const mockGetSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({ getSettings: () => mockGetSettings() }))

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)

const device = companionCaller("phone-1")

function row(overrides: Partial<MemoryCreateInput>): MemoryCreateInput {
  return {
    scope: "global",
    type: "semantic",
    text: "fact",
    tags: [],
    importance: 5,
    pinned: false,
    provenance: "user",
    ...overrides,
  }
}

/** Grant the phone only workspace p1. */
function restrictToWorkspace(projectId: string) {
  mockGetSettings.mockResolvedValue({
    memory: {
      principalGrants: { [device.principalId]: { scopes: ["workspace"], projects: [projectId] } },
    },
  })
}

beforeEach(async () => {
  await dbFixture.restore()
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: {} })
  mockManage.mockImplementation(async (command: { id?: string }) => ({
    ok: true,
    memoryId: command.id ?? "mem_new",
  }))
})

describe("manageMemoryForCaller", () => {
  it("runs an unrestricted device's command through manageMemory unchanged", async () => {
    await createMemory(row({ id: "m1" }))
    await expect(
      manageMemoryForCaller({ kind: "pin", id: "m1", pinned: true }, { caller: device })
    ).resolves.toEqual({ ok: true, memoryId: "m1" })
    expect(mockManage).toHaveBeenCalledWith({ kind: "pin", id: "m1", pinned: true })
  })

  it("refuses a row outside the device's namespaces without touching the store", async () => {
    restrictToWorkspace("p1")
    await createMemory(row({ id: "g1", scope: "global" }))
    await expect(
      manageMemoryForCaller({ kind: "delete", id: "g1" }, { caller: device })
    ).resolves.toEqual({ ok: false, reason: "unauthorized_namespace" })
    expect(mockManage).not.toHaveBeenCalled()
  })

  it("checks both sides of a conflict and records the device as the resolver", async () => {
    restrictToWorkspace("p1")
    await createMemory(row({ id: "a", scope: "workspace", projectId: "p1" }))
    await createMemory(row({ id: "b", scope: "workspace", projectId: "p2" }))
    await expect(
      manageMemoryForCaller(
        { kind: "resolve-conflict", keepId: "a", dropId: "b", mode: "keep" },
        { caller: device }
      )
    ).resolves.toEqual({ ok: false, reason: "unauthorized_namespace" })

    await createMemory(row({ id: "c", scope: "workspace", projectId: "p1" }))
    await manageMemoryForCaller(
      { kind: "resolve-conflict", keepId: "a", dropId: "c", mode: "keep-both" },
      { caller: device }
    )
    expect(mockManage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resolve-conflict", actorId: device.principalId })
    )
  })

  it("refuses to create or move a row into a namespace the device cannot reach", async () => {
    restrictToWorkspace("p1")
    await createMemory(row({ id: "w1", scope: "workspace", projectId: "p1" }))
    await expect(
      manageMemoryForCaller(
        { kind: "create", text: "x", type: "semantic", importance: 5, tags: [], scope: "global" },
        { caller: device }
      )
    ).resolves.toEqual({ ok: false, reason: "unauthorized_namespace" })
    await expect(
      manageMemoryForCaller(
        { kind: "relocate", id: "w1", target: { scope: "global" } },
        { caller: device }
      )
    ).resolves.toEqual({ ok: false, reason: "unauthorized_namespace" })
    expect(mockManage).not.toHaveBeenCalled()
  })

  it("leaves an unknown id to manageMemory, which answers not_found", async () => {
    restrictToWorkspace("p1")
    mockManage.mockResolvedValueOnce({ ok: false, reason: "not_found" })
    await expect(
      manageMemoryForCaller({ kind: "pin", id: "ghost", pinned: true }, { caller: device })
    ).resolves.toEqual({ ok: false, reason: "not_found" })
  })

  it("narrows a restricted clear to the rows the device may see", async () => {
    restrictToWorkspace("p1")
    await createMemory(row({ id: "w1", scope: "workspace", projectId: "p1" }))
    await createMemory(row({ id: "w2", scope: "workspace", projectId: "p2" }))
    await createMemory(row({ id: "g1", scope: "global" }))
    await expect(manageMemoryForCaller({ kind: "clear" }, { caller: device })).resolves.toEqual({
      ok: true,
      clearedCount: 1,
    })
    expect(mockManage).toHaveBeenCalledTimes(1)
    expect(mockManage).toHaveBeenCalledWith({ kind: "delete", id: "w1" })
  })

  it("passes an unrestricted clear straight through", async () => {
    mockManage.mockResolvedValueOnce({ ok: true, clearedCount: 4 })
    await expect(
      manageMemoryForCaller({ kind: "clear", query: { status: "invalidated" } }, { caller: device })
    ).resolves.toEqual({ ok: true, clearedCount: 4 })
    expect(mockManage).toHaveBeenCalledWith({ kind: "clear", query: { status: "invalidated" } })
  })

  describe("idempotency", () => {
    const create = {
      kind: "create" as const,
      text: "likes tea",
      type: "semantic" as const,
      importance: 5,
      tags: [],
    }

    it("replays an applied command instead of running it twice", async () => {
      mockManage.mockResolvedValueOnce({ ok: true, memoryId: "mem_tea" })
      const first = await manageMemoryForCaller(create, { caller: device, operationId: "op-1" })
      const second = await manageMemoryForCaller(create, { caller: device, operationId: "op-1" })
      expect(first).toEqual({ ok: true, memoryId: "mem_tea" })
      expect(second).toEqual({ ok: true, memoryId: "mem_tea" })
      expect(mockManage).toHaveBeenCalledTimes(1)
      const receipt = await findMemoryOperation(device.principalId, "op-1")
      expect(receipt).toMatchObject({ kind: "manage", resultCode: "ok", memoryId: "mem_tea" })
    })

    it.each([
      { ok: true, clearedCount: 4 },
      { ok: true, memoryId: "mem_tea", piiRedacted: true },
    ])("replays every success field: %o", async (result) => {
      mockManage.mockResolvedValueOnce(result)
      const command = result.clearedCount ? { kind: "clear" as const } : create
      await expect(
        manageMemoryForCaller(command, { caller: device, operationId: "full" })
      ).resolves.toEqual(result)
      await expect(
        manageMemoryForCaller(command, { caller: device, operationId: "full" })
      ).resolves.toEqual(result)
      expect(mockManage).toHaveBeenCalledTimes(1)
    })

    it("refuses the same operation id carrying a different command", async () => {
      await manageMemoryForCaller(create, { caller: device, operationId: "op-2" })
      await expect(
        manageMemoryForCaller(
          { ...create, text: "likes coffee" },
          {
            caller: device,
            operationId: "op-2",
          }
        )
      ).resolves.toEqual({ ok: false, reason: "idempotency_key_reused" })
    })

    it("frees the key after a refusal so a corrected retry runs", async () => {
      mockManage.mockResolvedValueOnce({ ok: false, reason: "pii_blocked" })
      await expect(
        manageMemoryForCaller(create, { caller: device, operationId: "op-3" })
      ).resolves.toEqual({ ok: false, reason: "pii_blocked" })
      expect(await findMemoryOperation(device.principalId, "op-3")).toBeUndefined()
      await expect(
        manageMemoryForCaller(create, { caller: device, operationId: "op-3" })
      ).resolves.toMatchObject({ ok: true })
      expect(mockManage).toHaveBeenCalledTimes(2)
    })

    it("keeps the key fenced when a multi-step command throws with uncertain completion", async () => {
      mockManage.mockRejectedValueOnce(new Error("boom"))
      await expect(
        manageMemoryForCaller(create, { caller: device, operationId: "op-4" })
      ).rejects.toThrow("boom")
      expect(await findMemoryOperation(device.principalId, "op-4")).toMatchObject({
        resultCode: "pending",
      })
    })

    it("namespaces operation ids per device", async () => {
      await manageMemoryForCaller(create, { caller: device, operationId: "op-5" })
      await manageMemoryForCaller(create, {
        caller: companionCaller("tablet-2"),
        operationId: "op-5",
      })
      expect(mockManage).toHaveBeenCalledTimes(2)
    })
  })
})

function failReceiptWrites(attempts: number) {
  let count = 0
  const fail = (changes: { resultCode?: string }) => {
    if (changes.resultCode === "ok") {
      count += 1
      if (count <= attempts) throw new Error("receipt storage unavailable")
    }
  }
  const table = getDb().memoryOperations
  table.hook("updating", fail)
  return { count: () => count, dispose: () => table.hook("updating").unsubscribe(fail) }
}

describe("receipt persistence failures", () => {
  it("retries only the receipt after a successful multi-step command", async () => {
    const fail = failReceiptWrites(2)
    try {
      mockManage.mockResolvedValueOnce({ ok: true, clearedCount: 3 })
      const command = { kind: "clear" as const }
      const context = { caller: device, operationId: "retry-receipt" }
      await expect(manageMemoryForCaller(command, context)).resolves.toEqual({
        ok: true,
        clearedCount: 3,
      })
      await expect(manageMemoryForCaller(command, context)).resolves.toEqual({
        ok: true,
        clearedCount: 3,
      })
      expect(mockManage).toHaveBeenCalledTimes(1)
      expect(fail.count()).toBe(3)
    } finally {
      fail.dispose()
    }
  })

  it("keeps a successful command pending after bounded receipt retries are exhausted", async () => {
    const fail = failReceiptWrites(Infinity)
    try {
      mockManage.mockResolvedValueOnce({ ok: true, clearedCount: 3 })
      await expect(
        manageMemoryForCaller({ kind: "clear" }, { caller: device, operationId: "exhausted" })
      ).rejects.toMatchObject({ code: "memory_receipt_commit_failed" })
      await expect(
        manageMemoryForCaller({ kind: "clear" }, { caller: device, operationId: "exhausted" })
      ).rejects.toThrow("memory_mutate: operation still in flight")
      expect(mockManage).toHaveBeenCalledTimes(1)
      expect(fail.count()).toBe(3)
      expect(await findMemoryOperation(device.principalId, "exhausted")).toMatchObject({
        resultCode: "pending",
      })
    } finally {
      fail.dispose()
    }
  })

  it("replays an older receipt without a result payload", async () => {
    const command = { kind: "delete" as const, id: "old" }
    await recordMemoryOperation({
      id: `${device.principalId}:legacy`,
      principalId: device.principalId,
      operationId: "legacy",
      requestHash: await memoryOperationRequestHash("manage", command),
      kind: "manage",
      memoryId: "old",
      resultCode: "ok",
      createdAt: 1,
    })
    await expect(
      manageMemoryForCaller(command, { caller: device, operationId: "legacy" })
    ).resolves.toEqual({ ok: true, memoryId: "old" })
    expect(mockManage).not.toHaveBeenCalled()
  })
})

describe("canonical command and receipt atomicity", () => {
  beforeEach(() => {
    mockManage.mockImplementation(
      jest.requireActual("@/lib/memory/control-plane/manage").manageMemory
    )
  })

  it.each([
    "pin",
    "review",
    "update",
    "retrieval-feedback",
    "invalidate",
    "restore",
    "relocate",
    "delete",
    "restore-revision",
  ] as const)(
    "rolls back %s if its receipt cannot commit, then applies/replays once",
    async (kind) => {
      const initial = await createMemory(
        row({ id: "atomic", type: "procedural", reviewStatus: "pending_instruction" })
      )
      let command: ManageMemoryCommand
      switch (kind) {
        case "pin":
          command = { kind, id: initial.id, pinned: true }
          break
        case "review":
          command = { kind, id: initial.id, status: "verified" }
          break
        case "update":
          command = { kind, id: initial.id, patch: { text: "email dev@example.com" } }
          break
        case "retrieval-feedback":
          command = { kind, id: initial.id, verdict: "helpful" }
          break
        case "invalidate":
          command = { kind, id: initial.id }
          break
        case "restore":
          await updateMemory(initial.id, { status: "invalidated", invalidatedAt: 1 })
          command = { kind, id: initial.id }
          break
        case "relocate":
          command = { kind, id: initial.id, target: { scope: "workspace", projectId: "p1" } }
          break
        case "delete":
          command = { kind, id: initial.id }
          break
        case "restore-revision": {
          await updateMemory(initial.id, { text: "new wording", bumpVersion: true })
          const revision = (await listMemoryRevisions(initial.id))[0]
          command = { kind, id: initial.id, revisionId: revision.id }
          break
        }
      }
      const before = await getMemory(initial.id)
      const auditsBefore = await getDb().memoryAuditEvents.count()
      const evidenceBefore = await getDb().memoryEvidence.count()
      const revisionsBefore = await listMemoryRevisions(initial.id)
      const fail = failReceiptWrites(1)
      const context = { caller: device, operationId: `atomic-${kind}` }
      try {
        await expect(manageMemoryForCaller(command, context)).rejects.toThrow(
          "receipt storage unavailable"
        )
        expect(await getMemory(initial.id)).toEqual(before)
        expect(await getDb().memoryAuditEvents.count()).toBe(auditsBefore)
        expect(await getDb().memoryEvidence.count()).toBe(evidenceBefore)
        expect(await listMemoryRevisions(initial.id)).toEqual(revisionsBefore)
        expect(await findMemoryOperation(device.principalId, context.operationId)).toBeUndefined()
      } finally {
        fail.dispose()
      }
      const first = await manageMemoryForCaller(command, context)
      await refreshMemoryBeliefInputs([initial.id])
      const after = await getMemory(initial.id)
      expect(first.ok).toBe(true)
      expect(await manageMemoryForCaller(command, context)).toEqual(first)
      expect(await getMemory(initial.id)).toEqual(after)
      if (kind === "update") expect(first).toMatchObject({ piiRedacted: true })
      if (kind === "review") expect(after?.reviewStatus).toBe("verified")
      if (kind === "retrieval-feedback") expect(after?.retrievalFeedback?.positive).toBe(1)
    }
  )

  it("rolls feedback back on audit failure so the retry increments it only once", async () => {
    await createMemory(row({ id: "feedback" }))
    const fail = () => {
      throw new Error("audit unavailable")
    }
    getDb().memoryAuditEvents.hook("creating", fail)
    const command = {
      kind: "retrieval-feedback" as const,
      id: "feedback",
      verdict: "helpful" as const,
    }
    const context = { caller: device, operationId: "audit-feedback" }
    try {
      await expect(manageMemoryForCaller(command, context)).rejects.toThrow("audit unavailable")
      expect((await getMemory("feedback"))?.retrievalFeedback).toBeUndefined()
    } finally {
      getDb().memoryAuditEvents.hook("creating").unsubscribe(fail)
    }
    await manageMemoryForCaller(command, context)
    await manageMemoryForCaller(command, context)
    expect((await getMemory("feedback"))?.retrievalFeedback?.positive).toBe(1)
  })
})

it("withholds an externally edited procedure until the console review action re-verifies it", async () => {
  mockManage.mockImplementation(
    jest.requireActual("@/lib/memory/control-plane/manage").manageMemory
  )
  await createMemory(
    row({ id: "instruction", type: "procedural", provenance: "explicit", reviewStatus: "verified" })
  )
  const result = await updateExternalMemory(
    "instruction",
    { text: "Use a new procedure" },
    {
      caller: device,
      operationId: "external-edit",
    }
  )
  expect(result).toMatchObject({ ok: true, reviewRequired: true })
  const pending = await getMemory("instruction")
  expect(pending?.reviewStatus).toBe("pending_instruction")
  expect(isMemoryEligibleForRetrieval(pending!)).toBe(false)
  expect(
    await getDb().memoryAuditEvents.where("memoryId").equals("instruction").toArray()
  ).toContainEqual(expect.objectContaining({ reason: "external_procedural_edit_requires_review" }))
  await manageMemoryForCaller(
    { kind: "review", id: "instruction", status: "verified" },
    {
      caller: device,
      operationId: "human-review",
    }
  )
  expect(isMemoryEligibleForRetrieval((await getMemory("instruction"))!)).toBe(true)
})
