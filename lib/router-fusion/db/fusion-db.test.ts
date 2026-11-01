import "fake-indexeddb/auto"

import Dexie from "dexie"

import { MAX_ATTEMPTS } from "@/lib/queue/retry-policy"

import {
  FUSION_DB_SCHEMA_VERSION,
  FUSION_SCHEMA,
  FUSION_TABLE_NAMES,
  __resetFusionDbForTesting,
  fusionDatabaseName,
  getFusionDb,
  isFusionDatabaseName,
  openFusionDb,
} from "./fusion-db"
import { drainFusionOutbox, type OutboxAppliers } from "./outbox"

describe("fusion database lifecycle", () => {
  afterEach(() => {
    __resetFusionDbForTesting()
    jest.restoreAllMocks()
  })

  it("derives its name from the main database so it follows accounts and targets", () => {
    expect(fusionDatabaseName("cognia-account-acct_1-encrypted-v1")).toBe(
      "cognia-account-acct_1-encrypted-v1-router-fusion-v1"
    )
    expect(isFusionDatabaseName("cognia-account-acct_1-encrypted-v1-router-fusion-v1")).toBe(true)
    expect(isFusionDatabaseName("cognia-account-acct_1-encrypted-v1")).toBe(false)
    expect(() => fusionDatabaseName("")).toThrow()
  })

  it("declares every store it types", () => {
    const db = getFusionDb("main-a")
    expect(FUSION_TABLE_NAMES.sort()).toEqual(Object.keys(FUSION_SCHEMA).sort())
    for (const table of FUSION_TABLE_NAMES) expect(db[table]).toBeDefined()
  })

  it("keeps every earlier store's index layout across the B2, B3 and B4 bumps", () => {
    // Earlier store layouts survive later bumps; v6 adds an outbox index and
    // explicitly upgrades its rows without changing the other stores.
    expect(FUSION_DB_SCHEMA_VERSION).toBeGreaterThanOrEqual(4)
    expect(FUSION_SCHEMA.fusionRuns).toContain("actorKeyId")
    expect(FUSION_SCHEMA.fusionIdempotency).toBe("&scopedKey, runId, expiresAt")
    expect(FUSION_SCHEMA.fusionFeedback).toBe("&feedbackId, runId, createdAt")
    expect(FUSION_SCHEMA.fusionApiSessions).toBe("&apiSessionId, sessionId, actorKeyId")
    expect(FUSION_SCHEMA.fusionToolOperations).toBe(
      "&operationId, runId, [runId+logicalStepId], createdAt"
    )
    // B4 (delegate): the approval a person gave, the change a run produced, and
    // the step journal a resumed run replays from.
    expect(FUSION_SCHEMA.fusionAcceptanceApprovals).toBe(
      "&id, runId, [runId+status], [runId+requestDigest], createdAt"
    )
    expect(FUSION_SCHEMA.fusionPatchSets).toBe(
      "&patchSetId, runId, baseRevision, patchSha256, expiresAt"
    )
    expect(FUSION_SCHEMA.fusionDelegateSteps).toBe(
      "&[runId+stepId], runId, [runId+state], kind, createdAt"
    )
  })

  it("upgrades real v5 rows to v6 without hiding pending effects in the due index", async () => {
    const v5Schema = {
      fusionAccount: "&id",
      fusionRuns:
        "&runId, sessionId, status, surface, actorKeyId, createdAt, [sessionId+createdAt]",
      fusionRunEvents: "[runId+seq], runId, createdAt",
      fusionSessionLocks: "&sessionId, runId",
      fusionRouteDecisions: "&decisionId, runId",
      fusionReservations: "&reservationId, runId, [runId+state], stageId, attemptId",
      fusionCallAttempts:
        "&attemptId, runId, [runId+logicalStepId], [runId+state], state, createdAt",
      fusionLedger: "&dedupeKey, runId, attemptId, kind, createdAt",
      fusionArtifacts: "&artifactId, runId, contentSha256, expiresAt",
      fusionConfigSnapshots: "&digest, createdAt",
      fusionOutbox: "&effectId, runId, kind, status, createdAt",
      fusionIdempotency: "&scopedKey, runId, expiresAt",
      fusionFeedback: "&feedbackId, runId, createdAt",
      fusionApiSessions: "&apiSessionId, sessionId, actorKeyId",
      fusionToolOperations: "&operationId, runId, [runId+logicalStepId], createdAt",
      fusionAcceptanceApprovals: "&id, runId, [runId+status], [runId+requestDigest], createdAt",
      fusionPatchSets: "&patchSetId, runId, baseRevision, patchSha256, expiresAt",
      fusionDelegateSteps: "&[runId+stepId], runId, [runId+state], kind, createdAt",
      fusionRoutingSamples: "&sampleId, runId, groupId, actionHash, decidedAt, expiresAt",
      fusionPredictorManifests: "&manifestSha256, kind, active, createdAt",
      fusionShadowDecisions: "&shadowId, sampleId, manifestSha256, createdAt, expiresAt",
    }
    const now = 10_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    const older = new Dexie(fusionDatabaseName("main-upgrade-v6"))
    older.version(5).stores(v5Schema)
    await older.open()
    const row = (effectId: string, attempts: number, status = "pending") => ({
      effectId,
      runId: "r5",
      kind: "usage_row",
      payload: {},
      status,
      attempts,
      lastError: attempts ? "account db closed" : null,
      createdAt: 100,
      appliedAt: null,
    })
    await older
      .table("fusionOutbox")
      .bulkAdd([
        row("untried", 0),
        row("retry", 1),
        row("last-try", MAX_ATTEMPTS - 1),
        row("capped", MAX_ATTEMPTS),
        row("over-cap", MAX_ATTEMPTS + 1),
        row("applied", MAX_ATTEMPTS, "applied"),
        row("skipped", 1, "skipped"),
        { ...row("already-due", 0), nextAttemptAt: 200 },
      ])
    older.close()

    const upgraded = await openFusionDb("main-upgrade-v6")
    expect(FUSION_DB_SCHEMA_VERSION).toBe(6)
    expect(FUSION_SCHEMA).toEqual({
      ...v5Schema,
      fusionOutbox: `${v5Schema.fusionOutbox}, [status+nextAttemptAt]`,
    })
    const due = await upgraded.fusionOutbox
      .where("[status+nextAttemptAt]")
      .between(["pending", Dexie.minKey], ["pending", now], true, true)
      .toArray()
    expect(due.map((effect) => effect.effectId).sort()).toEqual([
      "already-due",
      "last-try",
      "retry",
      "untried",
    ])
    const rows = await upgraded.fusionOutbox.toArray()
    for (const effect of rows) {
      expect(effect.nextAttemptAt).toBe(effect.effectId === "already-due" ? 200 : effect.createdAt)
    }
    for (const effectId of ["capped", "over-cap"]) {
      expect(await upgraded.fusionOutbox.get(effectId)).toMatchObject({
        status: "deadletter",
        deadletteredAt: now,
        lastError: "account db closed",
      })
    }
    expect((await upgraded.fusionOutbox.get("applied"))?.status).toBe("applied")
    expect((await upgraded.fusionOutbox.get("skipped"))?.status).toBe("skipped")
    const apply = jest.fn(async () => "applied" as const)
    const appliers: OutboxAppliers = {
      usage_row: apply,
      execution_run_milestone: apply,
      execution_run_projection: apply,
      session_message: apply,
    }
    expect((await drainFusionOutbox(upgraded, appliers, { now: () => now })).applied).toBe(4)
  })

  it("opens a database a B3 build created and adds delegate's stores to it", async () => {
    const name = fusionDatabaseName("main-upgrade-b4")
    const {
      fusionAcceptanceApprovals: _approvals,
      fusionPatchSets: _patchSets,
      fusionDelegateSteps: _steps,
      // v5's stores are WP-F2's to assert; this case is about the B3 → B4 step.
      fusionRoutingSamples: _samples,
      fusionPredictorManifests: _manifests,
      fusionShadowDecisions: _shadows,
      ...b3Schema
    } = FUSION_SCHEMA as Record<string, string>
    const older = new Dexie(name)
    older.version(3).stores(b3Schema)
    await older.open()
    await older.table("fusionFeedback").put({ feedbackId: "f3", runId: "r3", createdAt: 1 })
    older.close()

    const upgraded = await openFusionDb("main-upgrade-b4")
    expect(upgraded.verno).toBe(FUSION_DB_SCHEMA_VERSION)
    // The B3 row survived the bump.
    await expect(upgraded.fusionFeedback.get("f3")).resolves.toMatchObject({ runId: "r3" })
    // And the delegate stores are usable, including the compound primary key.
    await upgraded.fusionDelegateSteps.put({
      runId: "r3",
      stepId: "delegate:verify:1",
      kind: "acceptance_run",
      requestHash: "h",
      state: "committed",
      receipt: "{}",
      encryptedReceipt: null,
      createdAt: 1,
      updatedAt: 1,
    })
    await expect(
      upgraded.fusionDelegateSteps.get(["r3", "delegate:verify:1"])
    ).resolves.toMatchObject({ state: "committed" })
    await expect(
      upgraded.fusionAcceptanceApprovals.where("[runId+status]").equals(["r3", "pending"]).count()
    ).resolves.toBe(0)
  })

  it("opens a database a B2 build created without losing a row", async () => {
    const name = fusionDatabaseName("main-upgrade")
    const {
      fusionApiSessions: _sessions,
      fusionToolOperations: _operations,
      ...b2Schema
    } = FUSION_SCHEMA
    const older = new Dexie(name)
    older.version(2).stores(b2Schema)
    await older.open()
    await older.table("fusionFeedback").put({ feedbackId: "f1", runId: "r1", createdAt: 1 })
    older.close()

    const upgraded = await openFusionDb("main-upgrade")
    expect(upgraded.verno).toBe(FUSION_DB_SCHEMA_VERSION)
    await expect(upgraded.fusionFeedback.get("f1")).resolves.toMatchObject({ runId: "r1" })
    await upgraded.fusionApiSessions.put({
      apiSessionId: "a1",
      sessionId: "s1",
      actorKeyId: "k",
      createdAt: 1,
    })
    await expect(upgraded.fusionApiSessions.where("sessionId").equals("s1").count()).resolves.toBe(
      1
    )
  })

  it("is not created until something opens it", async () => {
    getFusionDb("main-lazy")
    expect(await Dexie.exists(fusionDatabaseName("main-lazy"))).toBe(false)
    await openFusionDb("main-lazy")
    expect(await Dexie.exists(fusionDatabaseName("main-lazy"))).toBe(true)
  })

  it("closes the previous account's database when the main database changes", async () => {
    const first = await openFusionDb("main-1")
    const second = await openFusionDb("main-2")
    expect(first.isOpen()).toBe(false)
    expect(second.isOpen()).toBe(true)
    expect(getFusionDb("main-2")).toBe(second)
  })

  it("turns an open failure into an infrastructure fault", async () => {
    const db = getFusionDb("main-broken")
    jest.spyOn(db, "open").mockRejectedValueOnce(new Error("indexedDB blocked by policy"))
    await expect(openFusionDb("main-broken")).rejects.toMatchObject({
      name: "RouterFusionInfrastructureError",
      code: "db_unavailable",
    })
    // The broken instance is not reused.
    expect(getFusionDb("main-broken")).not.toBe(db)
  })

  it("steps aside when a deletion path deletes it while open", async () => {
    // Account deletion, target removal, the layout reset and "clear all data"
    // delete the database by name without loading this module; the open
    // instance must close instead of blocking them, and must not be reused.
    const db = await openFusionDb("main-delete")
    await Dexie.delete(fusionDatabaseName("main-delete"))
    expect(await Dexie.exists(fusionDatabaseName("main-delete"))).toBe(false)
    expect(db.isOpen()).toBe(false)
    expect(getFusionDb("main-delete")).not.toBe(db)
  })

  it.each(["close", "account switch", "versionchange"])(
    "cancels an outbox wake on %s",
    async (path) => {
      const mainName = `main-wake-${path}`
      const db = await openFusionDb(mainName)
      await db.fusionOutbox.add({
        effectId: "future",
        runId: "r",
        kind: "usage_row",
        payload: {},
        status: "pending",
        attempts: 0,
        lastError: null,
        createdAt: 1,
        nextAttemptAt: 100,
        appliedAt: null,
      })
      const cancel = jest.fn()
      const scheduleWake = jest.fn(() => cancel)
      const apply = async () => "applied" as const
      await drainFusionOutbox(
        db,
        {
          usage_row: apply,
          execution_run_milestone: apply,
          execution_run_projection: apply,
          session_message: apply,
        },
        { now: () => 1, scheduleWake }
      )
      expect(scheduleWake).toHaveBeenCalledWith(99, expect.any(Function))
      if (path === "close") __resetFusionDbForTesting()
      else if (path === "account switch") getFusionDb("main-wake-next")
      else await Dexie.delete(fusionDatabaseName(mainName))
      expect(cancel).toHaveBeenCalledTimes(1)
    }
  )
})
