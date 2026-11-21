/**
 * @jest-environment jsdom
 *
 * Live-subscription coverage for `initTriggerSubscriptions()`.
 *
 * `trigger-subscriptions.test.ts` seeds the cache through
 * `_seedTriggerSubscriptionsForTest`, which calls `rebuildIndex` directly and
 * never touches Dexie — so nothing there runs the `Dexie.liveQuery` call, and
 * `initTriggerSubscriptions` swallows any failure into a `log.warn`. That
 * combination means a broken `liveQuery` binding (see the interop note in
 * `lib/db/outbound-jobs.ts`) leaves the whole suite green while the trigger
 * index silently never populates on a real device. This file closes that hole
 * by driving the cache exclusively through real Dexie writes.
 *
 * The index is built from ACTIVE production deployments and the versions they
 * select, never from `workflows` draft rows (WF-06): a saved-but-unpublished
 * filter must not change which events start the published graph.
 */
import "fake-indexeddb/auto"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { WorkflowVersion } from "@/types/workflow/deployment"
import type { WorkflowNodeKind, WorkflowRow } from "@/types/workflow/visual"

import {
  disposeTriggerSubscriptions,
  findMatchingWorkflows,
  initTriggerSubscriptions,
} from "./trigger-subscriptions"

// Constructing the Dexie instance costs ~1s+ per `__resetDbForTesting()` +
// `getDb()` cycle (see the note in lib/db/schema.ts), and the default 5s
// budget is not enough for that hook once the directory runs in parallel.
jest.setTimeout(30_000)

function wf(id: string, type: WorkflowNodeKind, params: Record<string, unknown> = {}): WorkflowRow {
  return {
    id,
    schemaVersion: 2,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: `${id}_n1`,
        type,
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { params },
      },
    ] as WorkflowRow["nodes"],
    edges: [],
    settings: {} as WorkflowRow["settings"],
  }
}

let versionSeq = 0

/** Write an immutable version of `row` and point the production deployment at it. */
async function publish(row: WorkflowRow): Promise<WorkflowVersion> {
  const accountId = getActiveAccountId()
  versionSeq += 1
  const version = {
    id: `wfv_${row.id}_${versionSeq}`,
    accountId,
    workflowId: row.id,
    sequence: versionSeq,
    definition: row,
    digest: `digest_${versionSeq}`,
    name: row.name,
    createdAt: versionSeq,
  } as unknown as WorkflowVersion
  await getDb().workflowVersions.put(version)
  await pointDeployment(row.id, version.id, "active")
  return version
}

async function pointDeployment(
  workflowId: string,
  versionId: string,
  status: "active" | "disabled"
): Promise<void> {
  const accountId = getActiveAccountId()
  const id = `wfd_${workflowId}`
  const existing = await getDb().workflowDeployments.get(id)
  await getDb().workflowDeployments.put({
    id,
    accountId,
    workflowId,
    environment: "production",
    versionId,
    revision: (existing?.revision ?? 0) + 1,
    status,
    createdAt: existing?.createdAt ?? 0,
    updatedAt: Date.now(),
  })
}

/** Poll until `predicate` holds — liveQuery emission timing is scheduler-dependent. */
async function until(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function matchedIds(type: WorkflowNodeKind, ctx: Record<string, unknown> = {}): string[] {
  return findMatchingWorkflows(type, ctx).map((entry) => entry.workflowId)
}

beforeEach(async () => {
  versionSeq = 0
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

afterEach(() => {
  disposeTriggerSubscriptions()
})

describe("initTriggerSubscriptions (live Dexie subscription)", () => {
  it("populates the cache from active deployments without any direct seeding", async () => {
    await publish(wf("wf_live", "trigger.chat.message", { characterId: "char_a" }))

    initTriggerSubscriptions()

    // Nothing else writes this cache in this file — reaching a non-empty index
    // proves `Dexie.liveQuery(...)` was callable, emitted, and reached
    // `rebuildIndex`.
    await until(
      () => matchedIds("trigger.chat.message", { characterId: "char_a" }).length > 0,
      "the initial liveQuery emission"
    )
    expect(matchedIds("trigger.chat.message", { characterId: "char_a" })).toEqual(["wf_live"])
  })

  it("keeps tracking the table after the first emission", async () => {
    initTriggerSubscriptions()
    const first = await publish(wf("wf_a", "trigger.chat.message"))
    await until(() => matchedIds("trigger.chat.message").length === 1, "the first workflow")

    // A second publish must reach the cache too — an initial-read-only
    // implementation would stall at one row.
    await publish(wf("wf_b", "trigger.chat.message"))
    await until(() => matchedIds("trigger.chat.message").length === 2, "the second workflow")
    expect(matchedIds("trigger.chat.message").sort()).toEqual(["wf_a", "wf_b"])

    // Unpublishing (pointer disabled) propagates on the same subscription.
    await pointDeployment("wf_a", first.id, "disabled")
    await until(() => matchedIds("trigger.chat.message").length === 1, "the unpublish to propagate")
    expect(matchedIds("trigger.chat.message")).toEqual(["wf_b"])
  })

  it("stops updating once disposed", async () => {
    initTriggerSubscriptions()
    await publish(wf("wf_a", "trigger.chat.message"))
    await until(() => matchedIds("trigger.chat.message").length === 1, "the first workflow")

    disposeTriggerSubscriptions()
    expect(matchedIds("trigger.chat.message")).toEqual([])

    await publish(wf("wf_b", "trigger.chat.message"))
    // Give a still-open subscription time to emit; the cache must stay empty.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(matchedIds("trigger.chat.message")).toEqual([])
  })

  it("re-opening after dispose rebuilds from the current table contents", async () => {
    await publish(wf("wf_a", "trigger.connector.inbound", { adapterId: "tg" }))
    initTriggerSubscriptions()
    await until(
      () => matchedIds("trigger.connector.inbound", { adapterId: "tg" }).length === 1,
      "first open"
    )

    disposeTriggerSubscriptions()
    initTriggerSubscriptions()
    await until(
      () => matchedIds("trigger.connector.inbound", { adapterId: "tg" }).length === 1,
      "the re-opened subscription"
    )
    expect(matchedIds("trigger.connector.inbound", { adapterId: "tg" })).toEqual(["wf_a"])
  })

  it("excludes built-in and template definitions", async () => {
    await publish(wf("wf_real", "trigger.chat.message"))
    await publish({ ...wf("wf_tpl", "trigger.chat.message"), isTemplate: true })
    await publish({ ...wf("wf_builtin", "trigger.chat.message"), isBuiltIn: true })

    initTriggerSubscriptions()
    await until(() => matchedIds("trigger.chat.message").length > 0, "the liveQuery emission")
    expect(matchedIds("trigger.chat.message")).toEqual(["wf_real"])
  })

  it("matches the published filter, not a saved draft (WF-06)", async () => {
    const live = wf("wf_chat", "trigger.chat.message", { sessionId: "live-session" })
    await getDb().workflows.put(live)
    await publish(live)
    initTriggerSubscriptions()
    await until(
      () => matchedIds("trigger.chat.message", { sessionId: "live-session" }).length === 1,
      "the published filter"
    )

    // Save a draft with a different filter, without publishing it.
    await getDb().workflows.put(
      wf("wf_chat", "trigger.chat.message", { sessionId: "draft-session" })
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(matchedIds("trigger.chat.message", { sessionId: "live-session" })).toEqual(["wf_chat"])
    expect(matchedIds("trigger.chat.message", { sessionId: "draft-session" })).toEqual([])
  })

  it("follows a publish and a rollback of the deployment pointer", async () => {
    const v1 = await publish(wf("wf_r", "trigger.chat.message", { sessionId: "s1" }))
    initTriggerSubscriptions()
    await until(
      () => matchedIds("trigger.chat.message", { sessionId: "s1" }).length === 1,
      "version 1"
    )

    await publish(wf("wf_r", "trigger.chat.message", { sessionId: "s2" }))
    await until(
      () => matchedIds("trigger.chat.message", { sessionId: "s2" }).length === 1,
      "version 2"
    )
    expect(matchedIds("trigger.chat.message", { sessionId: "s1" })).toEqual([])

    await pointDeployment("wf_r", v1.id, "active")
    await until(
      () => matchedIds("trigger.chat.message", { sessionId: "s1" }).length === 1,
      "the rollback"
    )
    expect(matchedIds("trigger.chat.message", { sessionId: "s2" })).toEqual([])
  })

  it("skips a pointer whose version belongs to another workflow", async () => {
    const foreign = await publish(wf("wf_other", "trigger.chat.message"))
    await pointDeployment("wf_bad", foreign.id, "active")
    initTriggerSubscriptions()
    await until(() => matchedIds("trigger.chat.message").length > 0, "the liveQuery emission")
    expect(matchedIds("trigger.chat.message")).toEqual(["wf_other"])
  })
})
