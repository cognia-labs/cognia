/** @jest-environment jsdom */
import * as personalSinkHost from "@/lib/execution/personal-sink"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { LOCAL_PERSON_RUN, startToolExecutionRun, finishToolExecutionRun } from "./acting-authority"
import {
  assertPersonalSink,
  checkPersonalSink,
  explicitHostPersonalSinkContext,
  readRunPersonalTaint,
  PersonalSinkWithheldError,
  personalSinkWithholdMessage,
} from "./personal-sink"
import { sha256String } from "@/lib/utils/hash"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
const mark = { person: { kind: "local-person" as const }, source: "google-docs", markedAt: 10 }

it("reads every structural ancestor, so a pre-existing child cannot launder a later parent read", async () => {
  const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
  const parent = await startToolExecutionRun("parent", { parentRunId: root.id })
  const child = await startToolExecutionRun("child", { parentRunId: parent.id })
  await getDb().executionRuns.update(parent.id, { personalMarks: [mark] })
  expect(await readRunPersonalTaint({ executionRunId: child.id })).toEqual({
    verified: true,
    marks: [mark],
  })
  await finishToolExecutionRun(child.id)
  expect(await readRunPersonalTaint({ executionRunId: child.id })).toEqual({
    verified: true,
    marks: [mark],
  })
})

it("retains live source taint across a confirmation's new identity root", async () => {
  const source = await startToolExecutionRun("confirm", { localAuthorization: LOCAL_PERSON_RUN })
  const replay = await startToolExecutionRun("confirm", {
    confirmedSkill: {
      originRunId: source.id,
      rootSessionId: "confirm",
      requester: { kind: "local-person" },
    },
  })
  expect(replay.actingIdentity?.rootRunId).toBe(replay.id)
  await getDb().executionRuns.update(source.id, { personalMarks: [mark] })
  expect(await readRunPersonalTaint({ executionRunId: replay.id })).toEqual({
    verified: true,
    marks: [mark],
  })
})

it("fails closed for unknown, cyclic, missing and unreadable ancestry", async () => {
  expect(await readRunPersonalTaint({ executionRunId: "missing" })).toMatchObject({
    verified: false,
  })
  expect(
    await readRunPersonalTaint(
      personalSinkHost.personalSinkContextForRun({}, "lib/execution/personal-sink.test.ts")
    )
  ).toMatchObject({ verified: false })
  expect(await readRunPersonalTaint(explicitHostPersonalSinkContext("typed-send"))).toEqual({
    verified: true,
    marks: [],
  })
  // An explicit Host origin never erases a claimed run's failure.
  expect(
    await readRunPersonalTaint(
      personalSinkHost.personalSinkContextForRun(
        {
          ...explicitHostPersonalSinkContext("fixed-notice"),
          executionRunId: "missing",
        },
        "lib/execution/personal-sink.test.ts"
      )
    )
  ).toMatchObject({ verified: false })
  const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("child", { parentRunId: root.id })
  await getDb().executionRuns.update(child.id, { parentRunId: child.id })
  expect(await readRunPersonalTaint({ executionRunId: child.id })).toMatchObject({
    verified: false,
  })
  const read = jest.spyOn(getDb().executionRuns, "get").mockRejectedValueOnce(new Error("offline"))
  expect(await readRunPersonalTaint({ executionRunId: root.id })).toMatchObject({ verified: false })
  read.mockRestore()
})

it("withholds document writes with exact content hash and original target in an unindexed receipt", async () => {
  const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(root.id, { personalMarks: [mark] })
  const payload = "private summary\n"
  await expect(
    assertPersonalSink(
      { executionRunId: root.id },
      { kind: "unknown", label: "lark document" },
      payload,
      "doc:123"
    )
  ).rejects.toBeInstanceOf(PersonalSinkWithheldError)
  const rows = await getDb().actionReviewReceipts.toArray()
  expect(rows).toHaveLength(1)
  expect(rows[0].personal).toEqual({
    persons: [mark.person],
    outcome: "withheld",
    contentHash: await sha256String(payload),
    originalTarget: "doc:123",
  })
  expect(JSON.stringify(rows[0])).not.toContain("private summary")
})

it("allows a matching person, narrows only a reply, and commits each narrow receipt", async () => {
  const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(root.id, { personalMarks: [mark] })
  const context = { executionRunId: root.id }
  expect(await checkPersonalSink(context, { kind: "host-local" }, "private", "host")).toEqual({
    outcome: "allow",
  })
  expect(
    await checkPersonalSink(context, { kind: "group" }, "private", "chat", { canNarrow: true })
  ).toMatchObject({ outcome: "narrow", person: mark.person })
  expect(await checkPersonalSink(context, { kind: "group" }, "private", "chat")).toMatchObject({
    outcome: "withhold",
  })
  const rows = await getDb().actionReviewReceipts.toArray()
  expect(rows.map((r) => r.personal?.outcome).sort()).toEqual(["withheld", "withheld"])
})

it("withholds opaque submissions without a hash, so they cannot be disclosed", async () => {
  const root = await startToolExecutionRun("opaque", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(root.id, { personalMarks: [mark] })
  const result = await checkPersonalSink(
    { executionRunId: root.id },
    { kind: "unknown", label: "browser submission" },
    undefined,
    "https://example.test"
  )
  expect(result.outcome).toBe("withhold")
  const [receipt] = await getDb().actionReviewReceipts.toArray()
  expect(receipt.personal).toEqual({
    persons: [mark.person],
    outcome: "withheld",
    originalTarget: "https://example.test",
  })
})

it("allows an unhashable payload when its audience is the marked person", async () => {
  const root = await startToolExecutionRun("opaque-owner", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(root.id, { personalMarks: [mark] })
  expect(
    await checkPersonalSink(
      { executionRunId: root.id },
      { kind: "host-local" },
      undefined,
      "opaque-owner"
    )
  ).toEqual({ outcome: "allow" })
  expect(await getDb().actionReviewReceipts.count()).toBe(0)
})

it("does not put platform identifiers in model-facing withholding labels", () => {
  const message = personalSinkWithholdMessage([
    { kind: "platform", platform: "lark", adapterId: "private-adapter", remoteUserId: "ou_secret" },
  ])
  expect(message).toContain("Lark person")
  expect(message).not.toMatch(/ou_secret|private-adapter/)
})

it("does not release a narrowed payload if its receipt cannot commit", async () => {
  const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(root.id, { personalMarks: [mark] })
  const fail = () => {
    throw new Error("receipt unavailable")
  }
  getDb().actionReviewReceipts.hook("creating", fail)
  try {
    await expect(
      checkPersonalSink({ executionRunId: root.id }, { kind: "group" }, "private", "chat", {
        canNarrow: true,
      })
    ).rejects.toThrow("receipt unavailable")
  } finally {
    getDb().actionReviewReceipts.hook("creating").unsubscribe(fail)
  }
})

it("deduplicates decisions within one attempt, retaining the original and actual narrowed hashes", async () => {
  const run = await startToolExecutionRun("receipts", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(run.id, { personalMarks: [mark] })
  const context = personalSinkHost.withPersonalSinkAttempt({ executionRunId: run.id })
  await checkPersonalSink(context, { kind: "group" }, "original", "group", { canNarrow: true })
  await checkPersonalSink(context, { kind: "group" }, "original", "group", { canNarrow: true })
  await personalSinkHost.recordPersonalSinkReceipt(
    context,
    [mark.person],
    "narrow",
    "actual DM bytes",
    "group"
  )
  await checkPersonalSink(context, { kind: "group" }, "original", "group")
  const rows = await getDb().actionReviewReceipts.toArray()
  expect(rows).toHaveLength(2)
  expect(rows.find((row) => row.personal?.outcome === "narrow")?.personal).toMatchObject({
    contentHash: await sha256String("actual DM bytes"),
    originalTarget: "group",
  })
  await checkPersonalSink(
    personalSinkHost.withPersonalSinkAttempt({ executionRunId: run.id }),
    { kind: "group" },
    "original",
    "group"
  )
  expect(await getDb().actionReviewReceipts.count()).toBe(3)
})

it("aggregates only explicit session message/run/ancestor marks without selecting an active run", async () => {
  await getDb().sessions.put({
    id: "aggregate-session",
    title: "Title",
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
  })
  const source = await startToolExecutionRun("source-session", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await startToolExecutionRun("aggregate-session", { parentRunId: source.id })
  await getDb().executionRuns.update(source.id, { personalMarks: [mark] })
  const foreign = {
    person: {
      kind: "platform" as const,
      platform: "lark",
      adapterId: "bot",
      remoteUserId: "ou_foreign",
    },
    source: "explicit-message",
    markedAt: 2,
  }
  await getDb().messages.put({
    id: "explicit-session-message",
    sessionId: "aggregate-session",
    role: "assistant",
    parts: [],
    metadata: { personalMarks: [foreign] },
    createdAt: 1,
  } as never)
  expect(await personalSinkHost.readSessionPersonalTaint("aggregate-session")).toEqual({
    verified: true,
    marks: expect.arrayContaining([mark, foreign]),
  })
  await getDb().messages.delete("explicit-session-message")
  expect((await personalSinkHost.readSessionPersonalTaint("aggregate-session")).marks).toEqual([
    mark,
  ])
  expect((await getDb().executionRuns.get(child.id))?.personalMarks ?? []).toEqual([])
})

it("keeps an unmarked legacy session clean without inferred attribution", async () => {
  await getDb().sessions.put({
    id: "legacy-source",
    title: "Clean",
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
  })
  await getDb().executionRuns.put({
    id: "legacy-run",
    sessionId: "legacy-source",
    kind: "agent-turn",
    status: "completed",
  } as never)
  expect(await personalSinkHost.readSessionPersonalTaint("legacy-source")).toEqual({
    verified: true,
    marks: [],
  })
})

it("unions verified sources and retains known marks alongside an unverifiable producer", async () => {
  const a = await startToolExecutionRun("union-a", { localAuthorization: LOCAL_PERSON_RUN })
  const b = await startToolExecutionRun("union-b", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(a.id, { personalMarks: [mark] })
  const combined = personalSinkHost.mergePersonalSinkContexts(
    { executionRunId: a.id },
    { executionRunId: b.id }
  )
  expect(await readRunPersonalTaint(combined)).toEqual({ verified: true, marks: [mark] })
  expect(
    await readRunPersonalTaint(
      personalSinkHost.mergePersonalSinkContexts(
        combined,
        personalSinkHost.unverifiedPersonalSinkContext("lost producer")
      )
    )
  ).toEqual({ verified: false, marks: [mark], reason: "lost producer" })
})

it("allows unverified owner-local provenance but does not release a known foreign mark", async () => {
  expect(
    await checkPersonalSink(
      personalSinkHost.unverifiedPersonalSinkContext("remote frame"),
      { kind: "host-local" },
      "Notice",
      "local"
    )
  ).toEqual({ outcome: "allow" })
  const run = await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(run.id, {
    actingIdentity: undefined,
    personalMarks: [
      {
        person: {
          kind: "platform",
          platform: "lark",
          adapterId: "bot",
          remoteUserId: "ou_foreign",
        },
        source: "foreign",
        markedAt: 1,
      },
    ],
  })
  expect(
    await checkPersonalSink({ executionRunId: run.id }, { kind: "host-local" }, "Foreign", "local")
  ).toMatchObject({ outcome: "withhold" })
})

it("rejects a session run whose declared identity root conflicts with its parent", async () => {
  await getDb().sessions.put({
    id: "root-mismatch",
    title: "Title",
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
  })
  const a = await startToolExecutionRun("a", { localAuthorization: LOCAL_PERSON_RUN })
  const b = await startToolExecutionRun("b", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("root-mismatch", { parentRunId: a.id })
  await getDb().executionRuns.update(child.id, { parentRunId: b.id, personalMarks: [mark] })
  expect(await personalSinkHost.readSessionPersonalTaint("root-mismatch")).toMatchObject({
    verified: false,
    marks: [mark],
  })
})

it.each(["attached", "branch"])(
  "retains explicit canonical parent marks for a %s derived session",
  async (kind) => {
    await getDb().sessions.put({
      id: "source-parent",
      title: "Parent",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
    })
    await getDb().sessions.put({
      id: "derived-child",
      title: "Copied title",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
      ...(kind === "attached"
        ? { attachedChild: { parentSessionId: "source-parent" } }
        : { branchSeed: { text: "Copied summary" }, parentSessionId: "source-parent" }),
    } as never)
    const source = await startToolExecutionRun("source-parent", {
      localAuthorization: LOCAL_PERSON_RUN,
    })
    await getDb().executionRuns.update(source.id, { personalMarks: [mark] })
    expect(await personalSinkHost.readSessionPersonalTaint("derived-child")).toEqual({
      verified: true,
      marks: [mark],
    })
    await getDb().sessions.update("source-parent", {
      attachedChild: { parentSessionId: "derived-child" },
    } as never)
    expect(await personalSinkHost.readSessionPersonalTaint("derived-child")).toMatchObject({
      verified: false,
      marks: [mark],
    })
  }
)

it("H4: exposes only the ancestry verified by the canonical read to cache invalidation", async () => {
  const root = await startToolExecutionRun("dependency-root", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await startToolExecutionRun("dependency-child", { parentRunId: root.id })
  const taint = await readRunPersonalTaint({ executionRunId: child.id })
  expect(personalSinkHost.personalTaintDependencies(taint)).toEqual(new Set([child.id, root.id]))
  expect(
    personalSinkHost.personalTaintDependencies(JSON.parse(JSON.stringify(taint)))
  ).toBeUndefined()
})

it("F8 composite producer snapshots invalidate on a real ancestor mark", async () => {
  const { personalEgressFenced, personalEgressCachedFenced } = await import("./personal-egress")
  const { bindPersonalOperationSources } = await import("./personal-operation")
  const parent = await startToolExecutionRun("f8-composite-parent", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await startToolExecutionRun("f8-composite-child", { parentRunId: parent.id })
  const source = bindPersonalOperationSources({}, [{ executionRunId: child.id }])
  expect(await personalEgressFenced(source)).toBe(false)
  expect(personalEgressCachedFenced(source)).toBe(false)
  await getDb().executionRuns.update(parent.id, { personalMarks: [mark] })
  expect(personalEgressCachedFenced(source)).toBe(true)
})
