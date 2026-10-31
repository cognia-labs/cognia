/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { waitFor } from "@testing-library/react"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import * as database from "@/lib/db/schema"
jest.mock("@/lib/db/schema", () => ({
  ...jest.requireActual("@/lib/db/schema"),
  getDb: jest.fn(jest.requireActual("@/lib/db/schema").getDb),
}))
import {
  createExecutionRun,
  getExecutionRun,
  listExecutionRunEvents,
  listVisibleExecutionRunEvents,
  runEventJournal,
} from "@/lib/db/execution-runs"
import type { ExecutionRun } from "@/types/execution/run"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import {
  authorityFromPermissionCeiling,
  connectorRequester,
  observeActingAuthority,
  observeTenantServiceData,
  recordedRunMetadata,
  recordAbsorbedRequester,
  recordRunAuthority,
  snapshotActingAuthority,
  requestersFromRunOrigin,
  runTriggerFromOrigin,
  startToolExecutionRun,
  finishToolExecutionRun,
  resolveRunActingIdentity,
  LOCAL_PERSON_RUN,
  bindToolCallRun,
  toolCallExecutionRunId,
  activeToolExecutionRunId,
} from "./acting-authority"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { assertLarkActingIdentity } from "@/lib/skills/built-in/lark/acting-identity"
import { subSessionId } from "@/lib/claude/team-session-id"

const principal = {
  kind: "platform" as const,
  platform: "lark",
  adapterId: "adapter",
  remoteUserId: "alice",
}
const identity = recordedRunMetadata("requester", { requesters: [principal] }).actingIdentity!
const seed = (overrides: Partial<ExecutionRun> = {}): ExecutionRun => ({
  id: "run",
  kind: "agent-turn",
  sourceId: "run",
  sessionId: "session",
  title: "Test",
  status: "running",
  currentRevision: 0,
  startedAt: 1,
  updatedAt: 1,
  actingIdentity: identity,
  ...overrides,
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("binds the exact IPC turn and attempt without falling back on unknown or conflicting correlations", () => {
  bindToolCallRun("correlation", "turn", "run", "attempt")
  expect(toolCallExecutionRunId("correlation", "turn", "attempt")).toBe("run")
  expect(toolCallExecutionRunId("correlation", "turn", "other")).toBe("")
  expect(toolCallExecutionRunId("correlation", "other")).toBe("")
  expect(toolCallExecutionRunId("correlation")).toBeUndefined()
  bindToolCallRun("correlation", "turn", "replacement", "attempt")
  expect(toolCallExecutionRunId("correlation", "turn", "attempt")).toBe("")
})

it("releases the host binding even when terminal persistence cannot read storage", async () => {
  const run = await startToolExecutionRun("failed-storage", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  jest.mocked(database.getDb).mockImplementationOnce(() => {
    throw new Error("storage unavailable")
  })
  await expect(finishToolExecutionRun(run.id)).rejects.toThrow("storage unavailable")
  expect(activeToolExecutionRunId("failed-storage")).toBeUndefined()
})

it("rolls back local admission if its first journal append fails", async () => {
  const db = getDb()
  const failJournal = () => {
    throw new Error("journal unavailable")
  }
  db.executionRunEvents.hook("creating", failJournal)
  try {
    await expect(
      startToolExecutionRun("rejected-entry", {
        runId: "rejected-run",
        localAuthorization: LOCAL_PERSON_RUN,
      })
    ).rejects.toThrow("journal unavailable")
  } finally {
    db.executionRunEvents.hook("creating").unsubscribe(failJournal)
  }
  expect(await getExecutionRun("rejected-run")).toBeUndefined()
  expect(activeToolExecutionRunId("rejected-entry")).toBeUndefined()
  expect(await resolveRunActingIdentity("rejected-entry")).toBeUndefined()
})

it("rolls back local admission if a post-create run read fails", async () => {
  const db = getDb()
  const failRead = (row: ExecutionRun) => {
    if (row) throw new Error("run read unavailable")
    return row
  }
  db.executionRuns.hook("reading", failRead)
  try {
    await expect(
      startToolExecutionRun("rejected-read", {
        runId: "rejected-read-run",
        localAuthorization: LOCAL_PERSON_RUN,
      })
    ).rejects.toThrow("run read unavailable")
  } finally {
    db.executionRuns.hook("reading").unsubscribe(failRead)
  }
  expect(await getExecutionRun("rejected-read-run")).toBeUndefined()
  expect(activeToolExecutionRunId("rejected-read")).toBeUndefined()
})

it.each([
  [true, "failed"],
  ["cancelled", "cancelled"],
] as const)(
  "settles minimal entries as %s and releases the host binding",
  async (outcome, status) => {
    const run = await startToolExecutionRun("terminal", { localAuthorization: LOCAL_PERSON_RUN })
    expect(activeToolExecutionRunId("terminal")).toBe(run.id)
    await finishToolExecutionRun(run.id, outcome)
    expect((await getExecutionRun(run.id))?.status).toBe(status)
    expect(activeToolExecutionRunId("terminal")).toBeUndefined()
  }
)

it("admits desktop, foreground/background children and a local team conversation member through persisted roots", async () => {
  await getDb().sessions.put({ id: "desktop" } as never)
  const root = await startToolExecutionRun("desktop", { localAuthorization: LOCAL_PERSON_RUN })
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "desktop", executionRunId: root.id })
  ).resolves.toBeUndefined()
  for (const sessionId of [
    "background-child",
    "foreground-child",
    subSessionId("desktop", "member", "turn"),
  ]) {
    if (!sessionId.includes(":team:")) {
      await getDb().sessions.put({
        id: sessionId,
        parentSessionId: "desktop",
        kind: "subagent",
      } as never)
    }
    const child = await startToolExecutionRun(sessionId, { parentRunId: root.id })
    expect(child.actingIdentity?.rootRunId).toBe(root.id)
    await expect(
      assertLarkActingIdentity("a1", { sessionId, executionRunId: child.id })
    ).resolves.toBeUndefined()
    await finishToolExecutionRun(child.id)
  }
  await finishToolExecutionRun(root.id)
})

it.each(["synced-bot", "synced-plugin", "forked-programmatic"])(
  "refuses %s even after every session creator/owner marker was lost",
  async (sessionId) => {
    await getDb().sessions.put({ id: sessionId } as never)
    const run = await startToolExecutionRun(sessionId)
    await expect(
      assertLarkActingIdentity("a1", { sessionId, executionRunId: run.id })
    ).rejects.toMatchObject({ name: "LarkActingIdentityError" })
  }
)

it("refuses missing/ambiguous runs, exact mismatches, missing identities and corrupted root reads", async () => {
  await getDb().sessions.put({ id: "desktop" } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "desktop" })).rejects.toMatchObject({
    name: "LarkActingIdentityError",
  })
  const root = await startToolExecutionRun("desktop", { localAuthorization: LOCAL_PERSON_RUN })
  const sibling = await startToolExecutionRun("desktop")
  await expect(assertLarkActingIdentity("a1", { sessionId: "desktop" })).rejects.toMatchObject({
    name: "LarkActingIdentityError",
  })
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "desktop", executionRunId: root.id })
  ).resolves.toBeUndefined()
  expect(await resolveRunActingIdentity("other-session", root.id)).toBeUndefined()
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "desktop", executionRunId: "missing" })
  ).rejects.toMatchObject({ name: "LarkActingIdentityError" })
  await getDb().executionRuns.update(root.id, { actingIdentity: undefined })
  expect(await resolveRunActingIdentity("desktop", root.id)).toBeUndefined()
  await getDb().executionRuns.update(root.id, {
    actingIdentity: { ...identity, rootRunId: "missing" },
  })
  expect(await resolveRunActingIdentity("desktop", root.id)).toBeUndefined()
  await finishToolExecutionRun(sibling.id)
})

it("retains creator-marker refusals and prevents plugin API borrowing of a local run", async () => {
  await getDb().sessions.put({ id: "desktop", programmaticCreator: "plugin" } as never)
  const root = await startToolExecutionRun("desktop", { localAuthorization: LOCAL_PERSON_RUN })
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "desktop", executionRunId: root.id })
  ).rejects.toMatchObject({ name: "LarkActingIdentityError" })
  await getDb().sessions.update("desktop", { programmaticCreator: undefined })
  await expect(
    assertLarkActingIdentity("a1", {
      sessionId: "desktop",
      outboundAuthorization: { kind: "plugin", pluginId: "office" },
    })
  ).rejects.toMatchObject({ name: "LarkActingIdentityError" })
})

it("counts projected jobs when refusing ambiguous session fallback and keeps their parent host binding", async () => {
  await getDb().sessions.put({ id: "job-parent" } as never)
  const root = await startToolExecutionRun("job-parent", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("job-parent", {
    runId: "execution:job:sibling",
    parentRunId: root.id,
  })
  expect(activeToolExecutionRunId("job-parent")).toBe(root.id)
  await expect(assertLarkActingIdentity("a", { sessionId: "job-parent" })).rejects.toMatchObject({
    name: "LarkActingIdentityError",
  })
  await expect(
    assertLarkActingIdentity("a", { sessionId: "job-parent", executionRunId: root.id })
  ).resolves.toBeUndefined()
  await finishToolExecutionRun(child.id)
  await finishToolExecutionRun(root.id)
})

it("refuses an account database switch during asynchronous run resolution", async () => {
  const db = getDb()
  await db.executionRuns.put(
    seed({
      actingIdentity: recordedRunMetadata("local", {
        runId: "run",
        authorizingPrincipal: { kind: "local-person" },
      }).actingIdentity,
    })
  )
  const replacement = Object.create(db) as typeof db
  let reads = 0
  jest.mocked(database.getDb).mockImplementation(() => (++reads <= 3 ? db : replacement))
  try {
    expect(await resolveRunActingIdentity("session", "run")).toBeUndefined()
  } finally {
    jest.mocked(database.getDb).mockImplementation(jest.requireActual("@/lib/db/schema").getDb)
  }
})

it("records legacy roots and preserves every fixed parent identity field", () => {
  expect(recordedRunMetadata("schedule")).toEqual({
    actingIdentity: {
      schemaVersion: 1,
      lane: "legacy",
      trigger: "schedule",
      requesters: [],
      authorityRevision: 0,
    },
  })
  const parent = seed({
    actingIdentity: {
      ...identity,
      actingPrincipal: principal,
      authorizingPrincipal: principal,
      bindingId: "binding",
      authorityRevision: 4,
    },
    authority: {
      schemaVersion: 1,
      permissionMode: "default",
      maxTurns: 4,
      pools: { rootRunId: "run", costUsd: 1 },
    },
  })
  const child = recordedRunMetadata("child", {
    parent,
    authority: {
      schemaVersion: 1,
      permissionMode: "bypassPermissions",
      maxTurns: 8,
      pools: { rootRunId: "child", costUsd: 8 },
    },
  })
  expect(child.actingIdentity).toBe(parent.actingIdentity)
  expect(child.authority).toEqual(parent.authority)
  expect(
    recordedRunMetadata("child", { parent: seed(), authority: { schemaVersion: 1, maxTurns: 2 } })
      .authority
  ).toBeUndefined()
})

it.each([
  ["schedule", "schedule"],
  ["im", "requester"],
  ["chat", "external-event"],
  ["ui", "external-event"],
  ["desktop", "external-event"],
  ["bot", "external-event"],
  ["api", "external-event"],
  ["unknown", "external-event"],
  [undefined, "external-event"],
] as const)("classifies origin %s without inferring a person", (source, expected) => {
  expect(runTriggerFromOrigin(source ? { source } : undefined)).toBe(expected)
})

it("uses bounded legacy parent traversal and tolerates missing or cyclic identity roots", async () => {
  await createExecutionRun(seed())
  await createExecutionRun(seed({ id: "old-child", parentRunId: "run" }))
  await recordAbsorbedRequester("old-child", { ...principal, remoteUserId: "bob" })
  expect(await snapshotActingAuthority("session", "old-child")).toEqual({
    runId: "old-child",
    revision: 1,
  })
  await getDb().executionRuns.update("run", { parentRunId: "old-child" })
  await expect(recordAbsorbedRequester("old-child", principal)).resolves.toBeUndefined()
  expect(await observeActingAuthority("old-child", 0, "child-launch")).toEqual({
    ok: false,
    reason: "missing",
  })
  await getDb().executionRuns.update("run", {
    actingIdentity: { ...identity, rootRunId: "absent" },
  })
  expect(await observeActingAuthority("run", 0, "child-launch")).toEqual({
    ok: false,
    reason: "missing",
  })
  // Older parent chains and damaged chains must not keep observe work alive indefinitely.
  await getDb().executionRuns.bulkAdd(
    Array.from({ length: 34 }, (_, index) =>
      seed({ id: `deep-${index}`, parentRunId: index < 33 ? `deep-${index + 1}` : undefined })
    )
  )
  expect(await observeActingAuthority("deep-0", 0, "child-launch")).toEqual({
    ok: false,
    reason: "missing",
  })
})

it("anchors a new child of an older identity even without a structural parent link", async () => {
  const parent = await createExecutionRun(seed())
  await createExecutionRun(
    seed({
      id: "unlinked-child",
      ...recordedRunMetadata("child", { runId: "unlinked-child", parent }),
    })
  )
  expect((await getExecutionRun("unlinked-child"))?.actingIdentity?.rootRunId).toBe("run")
  await recordAbsorbedRequester("run", { ...principal, remoteUserId: "bob" })
  expect(await observeActingAuthority("unlinked-child", 0, "child-launch")).toEqual({
    ok: false,
    reason: "revision_advanced",
  })
})

it("converts only resolved permission dimensions, retaining empty denials and allow sets", () => {
  expect(authorityFromPermissionCeiling(undefined)).toBeUndefined()
  expect(
    authorityFromPermissionCeiling({
      permissionMode: "plan",
      allowedTools: [],
      disallowedTools: ["Bash"],
      mcpServers: [{ name: "docs" }],
    })
  ).toEqual({
    schemaVersion: 1,
    permissionMode: "plan",
    tools: { allow: [], deny: ["Bash"] },
    mcpServers: { only: ["docs"] },
  })
})

it("uses the inbound sender's existing principal and union enrichment", () => {
  const event = {
    platform: "lark",
    adapterId: "adapter",
    sender: { remoteUserId: "alice" },
    channelData: {
      resolvedPrincipal: { principalId: "p", accountId: "account" },
      identityScope: { unionId: "union" },
    },
  } as unknown as NormalizedInboundEvent
  expect(connectorRequester(event)).toEqual({ ...principal, principalId: "p", unionId: "union" })
})

it("records only the verified IM sender already carried by workflow/team origin", () => {
  const origin = {
    source: "im" as const,
    adapterId: "adapter",
    initiator: { remoteUserId: "alice", principalId: "principal" },
    deliveryTarget: {
      address: {
        platform: "lark" as const,
        adapterId: "adapter",
        conversationKey: "chat",
        containerId: "chat",
      },
      conversationRef: { platform: "lark" as const, adapterId: "adapter" },
    },
  }
  // Only the fields the adapter reads; the rest of the origin is irrelevant here.
  const asOrigin = (value: object) => value as unknown as WorkflowTriggeredFrom
  expect(requestersFromRunOrigin(asOrigin(origin))).toEqual([
    { ...principal, principalId: "principal" },
  ])
  expect(requestersFromRunOrigin(undefined)).toEqual([])
  expect(requestersFromRunOrigin(asOrigin({ ...origin, source: "schedule" }))).toEqual([])
  expect(requestersFromRunOrigin(asOrigin({ ...origin, deliveryTarget: undefined }))).toEqual([])
  expect(requestersFromRunOrigin(asOrigin({ ...origin, initiator: undefined }))).toEqual([])
})

it("serializes concurrent requester absorption and does not bump same-sender revisions", async () => {
  await createExecutionRun(seed())
  await recordAbsorbedRequester("run", principal)
  expect((await getExecutionRun("run"))?.actingIdentity).toEqual(identity)
  await Promise.all(
    ["bob", "carol", "bob"].map((remoteUserId) =>
      recordAbsorbedRequester("run", { ...principal, remoteUserId })
    )
  )
  const run = await getExecutionRun("run")
  expect(run?.actingIdentity?.authorityRevision).toBe(2)
  expect(
    run?.actingIdentity?.requesters.map((p) => p.kind === "platform" && p.remoteUserId).sort()
  ).toEqual(["alice", "bob", "carol"])
  expect(run?.status).toBe("running")
})

it("records metadata without moving updatedAt and skips unchanged authority and requesters", async () => {
  await createExecutionRun(seed())
  const update = jest.spyOn(getDb().executionRuns, "update")
  try {
    const authority = { schemaVersion: 1 as const, maxTurns: 3, permissionMode: "plan" as const }
    await recordRunAuthority("session", authority, "run")
    expect((await getExecutionRun("run"))?.updatedAt).toBe(1)
    expect(update).toHaveBeenCalledTimes(1)
    // A differently ordered object still records the same value.
    await recordRunAuthority(
      "session",
      { permissionMode: "plan", maxTurns: 3, schemaVersion: 1 },
      "run"
    )
    expect((await getExecutionRun("run"))?.updatedAt).toBe(1)
    expect(update).toHaveBeenCalledTimes(1)
    await recordAbsorbedRequester("run", { ...principal, remoteUserId: "bob" })
    expect((await getExecutionRun("run"))?.updatedAt).toBe(1)
    expect(update).toHaveBeenCalledTimes(2)
    await recordAbsorbedRequester("run", { ...principal, remoteUserId: "bob" })
    expect(update).toHaveBeenCalledTimes(2)
  } finally {
    update.mockRestore()
  }
})

it("observes the live identity root while a child retains its creation snapshot", async () => {
  const parent = seed({
    ...recordedRunMetadata("requester", { runId: "run", requesters: [principal] }),
  })
  await createExecutionRun(parent)
  await createExecutionRun(
    seed({
      id: "child",
      parentRunId: "run",
      ...recordedRunMetadata("child", { runId: "child", parent }),
    })
  )
  const child = await getExecutionRun("child")
  const creationRevision = child!.actingIdentity!.authorityRevision
  expect(child?.actingIdentity).toMatchObject({ rootRunId: "run", requesters: [principal] })
  await recordAbsorbedRequester("run", { ...principal, remoteUserId: "bob" })
  expect(await snapshotActingAuthority("session", "child")).toEqual({ runId: "child", revision: 1 })
  expect(await observeActingAuthority("child", creationRevision, "child-launch")).toEqual({
    ok: false,
    reason: "revision_advanced",
  })
  expect(await listExecutionRunEvents("child")).toEqual([
    expect.objectContaining({
      type: "authority.observed",
      visibility: "private",
      payload: expect.objectContaining({ currentRevision: 1 }),
    }),
  ])
  expect(await getExecutionRun("child")).toEqual(child)
  await recordAbsorbedRequester("child", { ...principal, remoteUserId: "carol" })
  expect((await getExecutionRun("run"))?.actingIdentity?.authorityRevision).toBe(2)
  expect(await getExecutionRun("child")).toEqual(child)
  const grandchild = await createExecutionRun(
    seed({
      id: "grandchild",
      parentRunId: "child",
      ...recordedRunMetadata("child", { runId: "grandchild", parent: child }),
    })
  )
  expect(grandchild.actingIdentity).toEqual(child?.actingIdentity)
  expect(await snapshotActingAuthority("session", "grandchild")).toEqual({
    runId: "grandchild",
    revision: 2,
  })
})

it("observes advancement with a private event while keeping the run executable", async () => {
  await createExecutionRun(seed())
  const seen = await snapshotActingAuthority("session")
  expect(seen).toEqual({ runId: "run", revision: 0 })
  await recordAbsorbedRequester("run", { ...principal, remoteUserId: "bob" })
  const beforeObservation = await getExecutionRun("run")
  const notificationWork = await getDb().notificationProjectionWork.toArray()
  expect(await observeActingAuthority("run", seen!.revision, "child-launch")).toEqual({
    ok: false,
    reason: "revision_advanced",
  })
  expect(await listVisibleExecutionRunEvents("run")).toEqual([])
  expect(await getExecutionRun("run")).toEqual(beforeObservation)
  expect(await getDb().notificationProjectionWork.toArray()).toEqual(notificationWork)
  expect(await listExecutionRunEvents("run")).toEqual([
    expect.objectContaining({
      type: "authority.observed",
      visibility: "private",
      payload: {
        mode: "observe",
        operation: "child-launch",
        reason: "revision_advanced",
        expectedRevision: 0,
        currentRevision: 1,
      },
    }),
  ])
  expect((await getExecutionRun("run"))?.status).toBe("running")
  expect(await observeActingAuthority("run", 1, "lark-personal-token")).toEqual({ ok: true })
  expect(await listExecutionRunEvents("run")).toHaveLength(1)
  await observeActingAuthority("run", 0, "unattended-resume")
  await runEventJournal.append("run", {
    type: "run.started",
    ts: 2,
    visibility: "summary",
    payload: {},
  })
  expect((await listExecutionRunEvents("run")).map((event) => event.seq)).toEqual([0, 0, 1])
  expect((await getExecutionRun("run"))?.latestSnapshot?.revision).toBe(1)
})

it("observes legacy missing identities and tolerates absent and terminal runs", async () => {
  await createExecutionRun(seed({ actingIdentity: undefined }))
  expect(await observeActingAuthority("run", 0, "unattended-resume")).toEqual({
    ok: false,
    reason: "missing",
  })
  expect(await listExecutionRunEvents("run")).toHaveLength(1)
  expect(await observeActingAuthority("absent", 0, "child-launch")).toEqual({
    ok: false,
    reason: "missing",
  })
  expect(await getExecutionRun("absent")).toBeUndefined()
  expect(await listExecutionRunEvents("absent")).toEqual([
    expect.objectContaining({
      seq: 0,
      type: "authority.observed",
      visibility: "private",
      payload: expect.objectContaining({ reason: "missing" }),
    }),
  ])
  await getDb().executionRuns.update("run", { status: "completed" })
  await expect(observeActingAuthority("run", 0, "child-launch")).resolves.toEqual({
    ok: false,
    reason: "missing",
  })
})

it("persists the resolved ceiling monotonically and leaves old executions operational", async () => {
  await createExecutionRun(
    seed({
      authority: {
        schemaVersion: 1,
        permissionMode: "plan",
        tools: { deny: ["Bash"] },
        pools: { rootRunId: "run", costUsd: 2 },
      },
    })
  )
  await recordRunAuthority(
    "session",
    {
      schemaVersion: 1,
      permissionMode: "bypassPermissions",
      tools: { allow: ["Read"] },
      maxTurns: 3,
    },
    "run"
  )
  expect((await getExecutionRun("run"))?.authority).toEqual({
    schemaVersion: 1,
    permissionMode: "plan",
    tools: { allow: ["Read"], deny: ["Bash"] },
    maxTurns: 3,
    pools: { rootRunId: "run", costUsd: 2 },
  })
  await expect(recordRunAuthority("missing", { schemaVersion: 1 })).resolves.toBeUndefined()
  await recordRunAuthority(
    "session",
    { schemaVersion: 1, pools: { rootRunId: "run", costUsd: 1 } },
    "run"
  )
  await recordRunAuthority(
    "session",
    { schemaVersion: 1, pools: { rootRunId: "run", costUsd: 9 } },
    "run"
  )
  expect((await getExecutionRun("run"))?.authority?.pools?.costUsd).toBe(1)
})

it("detaches tenant data observations onto the current IM run and excludes projected siblings", async () => {
  const db = getDb()
  await db.sessions.put({
    id: "session",
    platformBinding: { platform: "lark", adapterId: "adapter", conversationKey: "chat" },
  } as never)
  await createExecutionRun(seed({ id: "older-run", updatedAt: 1 }))
  await createExecutionRun(seed({ id: "current-run", updatedAt: 2 }))
  await createExecutionRun(seed({ id: "projected-job", kind: "job", updatedAt: 3 }))
  await createExecutionRun(seed({ id: "completed-run", status: "completed", updatedAt: 4 }))
  expect(observeTenantServiceData("session", "adapter", "/im/v1/chats")).toBeUndefined()
  observeTenantServiceData("session", "adapter", "/im/v1/chats")
  observeTenantServiceData("session", "adapter", "/contact/v3/users")
  await waitFor(async () => expect(await listExecutionRunEvents("current-run")).toHaveLength(2))
  expect((await listExecutionRunEvents("current-run")).map((event) => event.payload)).toEqual(
    expect.arrayContaining([
      {
        mode: "observe",
        operation: "tenant-service-data",
        adapterId: "adapter",
        path: "/im/v1/chats",
      },
      {
        mode: "observe",
        operation: "tenant-service-data",
        adapterId: "adapter",
        path: "/contact/v3/users",
      },
    ])
  )
  expect(await listExecutionRunEvents("older-run")).toEqual([])
  expect(await listExecutionRunEvents("projected-job")).toEqual([])
  expect(await listExecutionRunEvents("completed-run")).toEqual([])
  expect((await getExecutionRun("current-run"))?.updatedAt).toBe(2)
  expect((await getExecutionRun("current-run"))?.currentRevision).toBe(0)
})

it("skips desktop/missing sessions and swallows an unavailable observation database", async () => {
  const db = getDb()
  await db.sessions.put({ id: "desktop" } as never)
  await createExecutionRun(seed({ sessionId: "desktop" }))
  const read = jest.spyOn(db.sessions, "get")
  observeTenantServiceData(undefined, "adapter", "/no-session")
  expect(read).not.toHaveBeenCalled()
  observeTenantServiceData("desktop", "adapter", "/desktop")
  observeTenantServiceData("missing", "adapter", "/missing")
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(await listExecutionRunEvents("run")).toEqual([])
  read.mockRejectedValueOnce(new Error("storage unavailable"))
  expect(observeTenantServiceData("broken", "adapter", "/data")).toBeUndefined()
  await waitFor(() => expect(read).toHaveBeenCalledWith("broken"))
  expect(await listExecutionRunEvents("run")).toEqual([])
  read.mockRestore()
})

it("returns before a stalled observation read and swallows journal write failures", async () => {
  const db = getDb()
  let release!: (value: undefined) => void
  const stalled = new Promise<undefined>((resolve) => {
    release = resolve
  })
  const read = jest.spyOn(db.sessions, "get").mockReturnValueOnce(stalled as never)
  try {
    expect(observeTenantServiceData("stalled", "adapter", "/data")).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(read).toHaveBeenCalledWith("stalled")
  } finally {
    release(undefined)
    read.mockRestore()
  }
  await db.sessions.put({ id: "session", platformBinding: { platform: "lark" } } as never)
  await createExecutionRun(seed())
  const write = jest
    .spyOn(db.executionRunEvents, "add")
    .mockRejectedValueOnce(new Error("journal unavailable"))
  try {
    expect(observeTenantServiceData("session", "adapter", "/data")).toBeUndefined()
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(await listExecutionRunEvents("run")).toEqual([])
    expect((await getExecutionRun("run"))?.currentRevision).toBe(0)
  } finally {
    write.mockRestore()
  }
})
