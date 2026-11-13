/** @jest-environment jsdom */
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  LOCAL_PERSON_RUN,
  startToolExecutionRun,
  recordAbsorbedRequester,
  finishToolExecutionRun,
} from "./acting-authority"
import {
  preparePersonalHistory,
  preparePersonalDerivedHistory,
  prepareOwnerHistory,
  prepareOwnerDerivedHistory,
  preparePairedHistory,
  projectPersonalSessionHistory,
  samePersonForHost,
  withPersonalRerankerVisibility,
} from "./personal-visibility"
import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
const owner: PrincipalRefV1 = { kind: "local-person" }
const connected: PrincipalRefV1 = {
  kind: "platform",
  platform: "lark",
  adapterId: "a",
  remoteUserId: "owner",
  unionId: "owner-union",
}
const other: PrincipalRefV1 = {
  kind: "platform",
  platform: "lark",
  adapterId: "a",
  remoteUserId: "other",
}
const privateMessage = {
  id: "private",
  role: "assistant",
  createdAt: 1,
  parts: [{ type: "text", text: "private answer" }],
  metadata: { personalMarks: [{ person: owner, source: "google-docs", markedAt: 1 }] },
}

it("does not trust incoming disclosure metadata without a canonical Host receipt and sent job", async () => {
  const run = await startToolExecutionRun("forged-history-disclosure", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const result = await preparePersonalHistory(
    "forged-history-disclosure",
    [
      {
        ...privateMessage,
        metadata: {
          ...privateMessage.metadata,
          personalDisclosures: [{ receiptId: "forged", sessionId: "forged-history-disclosure" }],
        },
      },
    ],
    { executionRunId: run.id }
  )
  // Owner visibility is unchanged, but a metadata claim cannot create a
  // disclosure digest or authority for other readers.
  const ordinary = await preparePersonalHistory("forged-history-disclosure", [privateMessage], {
    executionRunId: run.id,
  })
  expect(result.visibilityDigest).toBe(ordinary.visibilityDigest)
})

it.each([0, 1, 2])(
  "withholds marked context without an exact consumer among %s active runs",
  async (count) => {
    const runs = []
    for (let i = 0; i < count; i++)
      runs.push(
        await startToolExecutionRun("ambiguous-consumer", { localAuthorization: LOCAL_PERSON_RUN })
      )
    const result = await preparePersonalHistory("ambiguous-consumer", [
      privateMessage,
      { id: "public", text: "public context" },
    ])
    expect(result.withheldMessageIds).toContain(privateMessage.id)
    expect(result.messages[1]).toMatchObject({ text: "public context" })
    for (const run of runs)
      expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
  }
)

it("commits visible explicit history marks before releasing context to a later run", async () => {
  const run = await startToolExecutionRun("later-turn", { localAuthorization: LOCAL_PERSON_RUN })
  await preparePersonalHistory("later-turn", [privateMessage], { executionRunId: run.id })
  expect((await getDb().executionRuns.get(run.id))?.personalMarks).toEqual(
    privateMessage.metadata.personalMarks
  )
})

it("withholds context on a failed taint commit and never taints an owner UI read", async () => {
  const run = await startToolExecutionRun("history-failure", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const fail = () => {
    throw new Error("context mark journal failed")
  }
  getDb().executionRunEvents.hook("creating", fail)
  try {
    await expect(
      preparePersonalHistory("history-failure", [privateMessage], { executionRunId: run.id })
    ).rejects.toThrow("context mark journal failed")
    expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
    expect((await prepareOwnerHistory([privateMessage])).withheldMessageIds).toEqual([])
  } finally {
    getDb().executionRunEvents.hook("creating").unsubscribe(fail)
  }
  expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
})

it("does not taint runs from inferred legacy attribution or withheld explicit messages", async () => {
  await getDb().sessions.put({
    id: "legacy-taint",
    title: "IM",
    createdAt: 1,
    updatedAt: 1,
    platformBinding: { platform: "lark", adapterId: "a", conversationId: "c" },
  } as never)
  const run = await startToolExecutionRun("legacy-taint", { localAuthorization: LOCAL_PERSON_RUN })
  const legacy = { id: "old", text: "legacy context" }
  await preparePersonalHistory("legacy-taint", [legacy], { executionRunId: run.id })
  expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
  await recordAbsorbedRequester(run.id, other)
  await preparePersonalHistory("legacy-taint", [privateMessage], { executionRunId: run.id })
  expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
})

it("re-preparing an owner's prepared legacy copy neither taints the run nor withholds it", async () => {
  await getDb().sessions.put({
    id: "legacy-reprepare",
    title: "IM",
    createdAt: 1,
    updatedAt: 1,
    platformBinding: { platform: "lark", adapterId: "a", conversationId: "c" },
  } as never)
  const run = await startToolExecutionRun("legacy-reprepare", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const legacy = { id: "old", createdAt: 5, text: "legacy owner context" }
  const first = await preparePersonalHistory("legacy-reprepare", [legacy])
  // The returned copy carries the materialized legacy attribution.
  expect(first.messages[0]).toMatchObject({ metadata: { personalMarks: [expect.anything()] } })
  const again = await preparePersonalHistory("legacy-reprepare", first.messages)
  expect(again.withheldMessageIds).toEqual([])
  expect(JSON.stringify(again.messages)).toContain("legacy owner context")
  await preparePersonalHistory("legacy-reprepare", first.messages, { executionRunId: run.id })
  expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
})

it("commits explicit source-run marks from a visible derived artifact", async () => {
  const source = await startToolExecutionRun("source", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(source.id, {
    personalMarks: privateMessage.metadata.personalMarks,
  })
  const consumer = await startToolExecutionRun("consumer", { localAuthorization: LOCAL_PERSON_RUN })
  await preparePersonalDerivedHistory("consumer", [{ id: "summary", text: "derived" }], {
    runIds: [source.id],
    executionRunId: consumer.id,
  })
  expect((await getDb().executionRuns.get(consumer.id))?.personalMarks).toEqual(
    privateMessage.metadata.personalMarks
  )
})

it("retains late structural source marks across a confirmed derived identity root", async () => {
  const source = await startToolExecutionRun("derived-confirm", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const confirmed = await startToolExecutionRun("derived-confirm", {
    confirmedSkill: {
      originRunId: source.id,
      rootSessionId: "derived-confirm",
      requester: owner,
    },
  })
  await getDb().executionRuns.update(source.id, {
    personalMarks: privateMessage.metadata.personalMarks,
  })
  const consumer = await startToolExecutionRun("derived-consumer", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await preparePersonalDerivedHistory("derived-consumer", [{ id: "summary", text: "derived" }], {
    runIds: [confirmed.id],
    executionRunId: consumer.id,
  })
  expect((await getDb().executionRuns.get(consumer.id))?.personalMarks).toEqual(
    privateMessage.metadata.personalMarks
  )
})

it("rechecks root readers before private candidates reach a model-backed reranker", async () => {
  const root = await startToolExecutionRun("rerank", { localAuthorization: LOCAL_PERSON_RUN })
  const scorer = jest.fn(
    async (_query: string, _candidate: { id: string; content: string; score: number }) => 1
  )
  const batchScorer = jest.fn(
    async (
      _query: string,
      _candidates: readonly { id: string; content: string; score: number }[]
    ) => [1]
  )
  const wrapped = withPersonalRerankerVisibility(
    { scorer, batchScorer },
    { executionRunId: root.id }
  )!
  const candidate = { id: "private", content: "private document", score: 1 }
  expect(await wrapped.scorer("q", candidate)).toBe(1)
  expect(await wrapped.batchScorer("q", [candidate])).toEqual([1])
  await recordAbsorbedRequester(root.id, other)
  expect(await wrapped.scorer("q", candidate)).toBe(0)
  expect(await wrapped.batchScorer("q", [candidate])).toEqual([0])
  expect(scorer).toHaveBeenCalledTimes(1)
  expect(batchScorer).toHaveBeenCalledTimes(1)
})

it("equates only the Host owner and verified platform owners, with strict remote identities", () => {
  const host = { connectedOwners: [connected] }
  expect(samePersonForHost(owner, connected, host)).toBe(true)
  expect(samePersonForHost(connected, owner, host)).toBe(true)
  expect(samePersonForHost(owner, other, host)).toBe(false)
  expect(samePersonForHost(owner, connected, { connectedOwners: [] })).toBe(false)
  expect(samePersonForHost(other, { ...other, principalId: "enriched" }, host)).toBe(true)
  expect(samePersonForHost(other, { ...other, adapterId: "another" }, host)).toBe(false)
  expect(
    samePersonForHost(
      { ...other, unionId: "u" },
      { ...other, remoteUserId: "alias", adapterId: "another", unionId: "u" },
      host
    )
  ).toBe(true)
  expect(
    samePersonForHost({ kind: "service", ref: "same" }, { kind: "service", ref: "same" }, host)
  ).toBe(false)
})

it("a second person's steer withholds the previous answer, including through a live child's root", async () => {
  const root = await startToolExecutionRun("s", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("child", { parentRunId: root.id })
  const before = await preparePersonalHistory("child", [privateMessage], {
    executionRunId: child.id,
  })
  expect(before.withheldMessageIds).toEqual([])
  await recordAbsorbedRequester(root.id, other)
  const after = await preparePersonalHistory("child", [privateMessage], {
    executionRunId: child.id,
  })
  expect(after.readers).toEqual([owner, other])
  expect(after.withheldMessageIds).toEqual(["private"])
  expect(after.visibilityDigest).not.toBe(before.visibilityDigest)
  expect(JSON.stringify(after.messages)).not.toContain("private answer")
})

it("normalizes the verified Slack connected owner to the desktop person in the visibility digest", async () => {
  await getDb().adapterInstances.put({
    id: "slack",
    type: "slack",
    displayName: "Slack",
    enabled: true,
    settings: { connectedTeam: { authedUserId: "owner-slack" } },
    createdAt: 1,
    updatedAt: 1,
  } as never)
  const person: PrincipalRefV1 = {
    kind: "platform",
    platform: "slack",
    adapterId: "slack",
    remoteUserId: "owner-slack",
  }
  const root = await startToolExecutionRun("slack-session", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const message = {
    ...privateMessage,
    metadata: { personalMarks: [{ person, source: "slack-user", markedAt: 1 }] },
  }
  const desktop = await preparePersonalHistory("slack-session", [message], {
    executionRunId: root.id,
  })
  expect(desktop.withheldMessageIds).toEqual([])
  const identity = (await getDb().executionRuns.get(root.id))!.actingIdentity!
  await getDb().executionRuns.update(root.id, {
    actingIdentity: { ...identity, requesters: [person] },
  })
  const im = await preparePersonalHistory("slack-session", [message], { executionRunId: root.id })
  expect(im.visibilityDigest).toBe(desktop.visibilityDigest)
  await recordAbsorbedRequester(root.id, { ...person, remoteUserId: "someone-else" })
  expect(
    (await preparePersonalHistory("slack-session", [message], { executionRunId: root.id }))
      .withheldMessageIds
  ).toEqual([message.id])
})

it("a later request cannot repeat the previous person's answer or launder a child's read", async () => {
  const old = await startToolExecutionRun("s", { localAuthorization: LOCAL_PERSON_RUN })
  await finishToolExecutionRun(old.id)
  const next = await startToolExecutionRun("s")
  await getDb().executionRuns.update(next.id, {
    actingIdentity: {
      schemaVersion: 1,
      rootRunId: next.id,
      lane: "delegated",
      trigger: "requester",
      requesters: [other],
      authorityRevision: 0,
    },
  })
  const filtered = await preparePersonalHistory("s", [privateMessage], { executionRunId: next.id })
  expect(filtered.withheldMessageIds).toEqual(["private"])
})

it("desktop owner sees migrated Lark history while a non-owner cannot see legacy attribution", async () => {
  const db = getDb()
  await db.adapterInstances.put({
    id: "a",
    type: "lark",
    displayName: "Lark",
    enabled: true,
    settings: { connectedUser: { openId: "owner", unionId: "owner-union" } },
    createdAt: 1,
    updatedAt: 1,
  } as never)
  await db.sessions.put({
    id: "s",
    title: "IM",
    createdAt: 1,
    updatedAt: 1,
    platformBinding: { platform: "lark", adapterId: "a", conversationId: "c" },
  } as never)
  const root = await startToolExecutionRun("s", { localAuthorization: LOCAL_PERSON_RUN })
  const legacy = {
    id: "legacy",
    createdAt: 1,
    role: "assistant",
    parts: [{ type: "text", text: "old private answer" }],
  }
  expect(
    (await preparePersonalHistory("s", [legacy], { executionRunId: root.id })).withheldMessageIds
  ).toEqual([])
  await recordAbsorbedRequester(root.id, other)
  const filtered = await preparePersonalHistory("s", [legacy], { executionRunId: root.id })
  expect(filtered.withheldMessageIds).toEqual(["legacy"])
  expect(JSON.stringify(filtered.messages)).not.toContain("old private answer")
  const crossSession = await startToolExecutionRun("desktop", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await recordAbsorbedRequester(crossSession.id, other)
  const converted = { ...legacy, metadata: { sessionId: "s" } }
  expect(
    (await preparePersonalHistory("desktop", [converted], { executionRunId: crossSession.id }))
      .withheldMessageIds
  ).toEqual(["legacy"])
})

it("service, event and unverifiable runs have no personal reader even when they record requesters", async () => {
  for (const automation of ["service", undefined] as const) {
    const run = await startToolExecutionRun("s", { automation })
    expect(
      (await preparePersonalHistory("s", [privateMessage], { executionRunId: run.id }))
        .withheldMessageIds
    ).toEqual(["private"])
  }
  expect((await preparePersonalHistory(undefined, [privateMessage])).readers).toEqual([])
})

it("checks source ancestors and the live consuming root before returning a derived child summary", async () => {
  const root = await startToolExecutionRun("parent", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("child", { parentRunId: root.id })
  await getDb().executionRuns.update(root.id, {
    personalMarks: privateMessage.metadata.personalMarks,
  })
  const source = [{ id: "summary", text: "private child summary" }]
  expect(
    (
      await preparePersonalDerivedHistory("parent", source, {
        runIds: [child.id],
        executionRunId: root.id,
      })
    ).messages[0].text
  ).toBe("private child summary")
  await recordAbsorbedRequester(root.id, other)
  const filtered = await preparePersonalDerivedHistory("parent", source, {
    runIds: [child.id],
    executionRunId: root.id,
  })
  expect(filtered.withheldMessageIds).toEqual(["summary"])
  expect(filtered.messages[0].text).toBe("[Withheld: personal content of Host owner]")
})

it("does not declassify retained titles or summaries after their marked source rows are deleted", async () => {
  const session = {
    id: "retained-source",
    title: "private retained title",
    createdAt: 1,
    updatedAt: 1,
    branchSeed: { kind: "summary" as const, content: "private retained summary" },
    scratchpad: "private retained notes",
  }
  await getDb().sessions.put(session)
  await getDb().messages.bulkPut([
    { ...privateMessage, sessionId: session.id },
    {
      id: "remaining-public",
      sessionId: session.id,
      role: "user",
      parts: [{ type: "text", text: "public follow-up" }],
      createdAt: 2,
      metadata: { personalMarkVersion: 1 },
    },
  ] as never[])
  await getDb().messages.delete(privateMessage.id)
  const receiver = await startToolExecutionRun("retained-receiver", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await recordAbsorbedRequester(receiver.id, other)
  const result = await preparePersonalDerivedHistory(
    "retained-receiver",
    [{ id: "retained-summary", text: session.branchSeed.content }],
    { sessionId: session.id, executionRunId: receiver.id }
  )
  expect(result.withheldMessageIds).toEqual(["retained-summary"])
  expect(result.messages[0].text).not.toContain("private retained summary")
  const projected = await projectPersonalSessionHistory(session, "owner")
  expect(projected).toEqual(session)
  expect((await getDb().sessions.get(session.id))?.title).toBe(session.title)
})

it("retains a source session's persisted foreign-person run marks after its messages are deleted", async () => {
  const source = await startToolExecutionRun("retained-foreign-source", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await getDb().executionRuns.update(source.id, {
    personalMarks: [{ person: other, source: "integration-user", markedAt: 1 }],
  })
  await getDb().messages.put({
    id: "remaining-public",
    sessionId: "retained-foreign-source",
    role: "user",
    parts: [{ type: "text", text: "public follow-up" }],
    createdAt: 2,
    metadata: { personalMarkVersion: 1 },
  })
  const receiver = await startToolExecutionRun("retained-owner-receiver", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const result = await preparePersonalDerivedHistory(
    "retained-owner-receiver",
    [{ id: "foreign-summary", text: "foreign private summary" }],
    { sessionId: "retained-foreign-source", executionRunId: receiver.id }
  )
  expect(result.withheldMessageIds).toEqual(["foreign-summary"])
  expect(result.messages[0].text).not.toContain("foreign private summary")
})

it("never grants the owner an old derived artifact whose foreign-person provenance is gone", async () => {
  await getDb().sessions.put({ id: "lost-source", title: "Old title", createdAt: 1, updatedAt: 1 })
  await getDb().messages.bulkPut([
    {
      ...privateMessage,
      sessionId: "lost-source",
      metadata: { personalMarks: [{ person: other, source: "portable-copy", markedAt: 1 }] },
    },
    {
      id: "remaining-public",
      sessionId: "lost-source",
      role: "user",
      parts: [{ type: "text", text: "public follow-up" }],
      createdAt: 2,
      metadata: { personalMarkVersion: 1 },
    },
  ] as never[])
  await getDb().messages.delete(privateMessage.id)
  const ownerRun = await startToolExecutionRun("owner-receiver", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const result = await preparePersonalDerivedHistory(
    "owner-receiver",
    [{ id: "lost-summary", text: "foreign private summary" }],
    { sessionId: "lost-source", executionRunId: ownerRun.id }
  )
  expect(result.withheldMessageIds).toEqual(["lost-summary"])
  expect(result.messages[0].text).not.toContain("foreign private summary")
  const unverifiable = { ...ownerRun, id: "old-unverified-source", actingIdentity: undefined }
  await getDb().executionRuns.put(unverifiable)
  expect(
    (
      await preparePersonalDerivedHistory(
        "owner-receiver",
        [{ id: "old-run-summary", text: "foreign private summary" }],
        { runIds: [unverifiable.id], executionRunId: ownerRun.id }
      )
    ).withheldMessageIds
  ).toEqual(["old-run-summary"])
})

it("keeps owner titles, previews, seeds and history through the explicit paired owner read", async () => {
  const session = {
    id: "paired",
    title: "private report title",
    createdAt: 1,
    updatedAt: 1,
    branchSeed: { kind: "summary" as const, content: "private summary" },
    scratchpad: "private notes",
    sdkSessionId: "opaque-private-memory",
  }
  await getDb().sessions.put(session)
  await getDb().messages.put({
    ...privateMessage,
    role: "assistant",
    sessionId: session.id,
  } as never)
  const projected = await projectPersonalSessionHistory(session, "owner")
  expect(projected).toEqual(session)
  expect((await preparePairedHistory([privateMessage], "owner")).messages[0]).toEqual(
    privateMessage
  )
  expect(await getDb().sessions.get(session.id)).toEqual(session)
  expect((await getDb().messages.get(privateMessage.id))?.parts).toEqual(privateMessage.parts)
})

it("explicit owner UI reads retain legacy owner content but still withhold a known foreign person", async () => {
  const foreign = {
    ...privateMessage,
    id: "foreign",
    metadata: { personalMarks: [{ person: other, source: "portable-copy", markedAt: 1 }] },
  }
  const projected = await prepareOwnerHistory([privateMessage, foreign])
  expect(projected.readers).toEqual([owner])
  expect(projected.withheldMessageIds).toEqual(["foreign"])
  expect(projected.messages[0]).toEqual(privateMessage)
  expect(JSON.stringify(projected.messages[1])).not.toContain("private answer")
  const old = [{ id: "legacy-seed", text: "owner's old seed" }]
  expect((await prepareOwnerDerivedHistory(old)).messages).toMatchObject(old)
  const run = await startToolExecutionRun("legacy-owner", { localAuthorization: LOCAL_PERSON_RUN })
  expect(
    (
      await preparePersonalDerivedHistory("legacy-owner", old, {
        legacyOwnerArtifact: true,
        executionRunId: run.id,
      })
    ).messages
  ).toMatchObject(old)
  await recordAbsorbedRequester(run.id, other)
  const joined = await preparePersonalDerivedHistory("legacy-owner", old, {
    legacyOwnerArtifact: true,
    executionRunId: run.id,
  })
  expect(joined.withheldMessageIds).toEqual(["legacy-seed"])
  expect(joined.messages[0].text).not.toContain("owner's old seed")
})

it("P1 plugin history cannot inherit a local person's reader authority", async () => {
  const { preparePluginHistory } = await import("./personal-visibility")
  const run = await startToolExecutionRun("plugin-history", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const result = await preparePluginHistory("plugin-history", [
    privateMessage,
    { id: "public", text: "public" },
  ])
  expect(result.readers).toEqual([])
  expect(result.withheldMessageIds).toEqual([privateMessage.id])
  expect(result.messages[1]).toEqual({ id: "public", text: "public" })
  expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
})

it.each(["member", undefined, "forged-owner"])(
  "paired %s has no personal reader",
  async (reader) => {
    const result = await preparePairedHistory([privateMessage], reader)
    expect(result.readers).toEqual([])
    expect(result.withheldMessageIds).toEqual(["private"])
    expect(JSON.stringify(result.messages)).not.toContain("private answer")
    expect((await preparePairedHistory([privateMessage], "owner")).withheldMessageIds).toEqual([])
  }
)
