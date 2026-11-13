/** @jest-environment jsdom */
import type { UIMessage } from "ai"
import {
  publishEntry,
  readDependencyResults,
  clearTeamMemory,
} from "@/lib/squads/memory/shared-memory-orchestrator"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  commitMessageDelta,
  listMessages,
  persistMessages,
  persistStreamingMessages,
} from "@/lib/db/messages"
import { LOCAL_PERSON_RUN, startToolExecutionRun, finishToolExecutionRun } from "./acting-authority"
import { admitPersonalCredential } from "./personal-credential"
import {
  bindPersonalMessageChanges,
  bindPersonalMessageRun,
  effectivePersonalMarks,
  personalMessageMetadata,
  personalMessageForCopy,
  addPersonalMarksToRun,
} from "./personal-marks"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
const mark = { person: { kind: "local-person" as const }, source: "google-docs", markedAt: 10 }
const message = (id: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: "private" }],
})

it("commits a confirmed run's read to its consuming structural source", async () => {
  const source = await startToolExecutionRun("confirm-upstream", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const confirmed = await startToolExecutionRun("confirmed-read", {
    confirmedSkill: {
      originRunId: source.id,
      rootSessionId: "confirmed-read",
      requester: { kind: "local-person" },
    },
  })
  await addPersonalMarksToRun({ executionRunId: confirmed.id }, [mark])
  expect((await getDb().executionRuns.get(source.id))?.personalMarks).toEqual([mark])
  expect((await getDb().executionRuns.get(confirmed.id))?.personalMarks).toEqual([mark])
})

it("widens source marks on every ancestor, preserves existing marks, and leaves empty reads unmarked", async () => {
  const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
  const parent = await startToolExecutionRun("parent", { parentRunId: root.id })
  const child = await startToolExecutionRun("child", { parentRunId: parent.id })
  const existing = { ...mark, source: "existing-source" }
  await getDb().executionRuns.update(root.id, { personalMarks: [existing] })
  await addPersonalMarksToRun({ executionRunId: child.id }, [mark])
  await addPersonalMarksToRun({ executionRunId: child.id }, [mark])
  expect((await getDb().executionRuns.get(root.id))?.personalMarks).toEqual([existing, mark])
  for (const id of [parent.id, child.id])
    expect((await getDb().executionRuns.get(id))?.personalMarks).toEqual([mark])
  const clean = await startToolExecutionRun("clean", { localAuthorization: LOCAL_PERSON_RUN })
  await addPersonalMarksToRun({ executionRunId: clean.id }, [])
  expect((await getDb().executionRuns.get(clean.id))?.personalMarks).toBeUndefined()
})

it("rolls back recalled marks on all ancestors when their journal cannot commit", async () => {
  const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("child", { parentRunId: root.id })
  const fail = () => {
    throw new Error("journal unavailable")
  }
  const db = getDb()
  db.executionRunEvents.hook("creating", fail)
  try {
    await expect(addPersonalMarksToRun({ executionRunId: child.id }, [mark])).rejects.toThrow(
      "journal unavailable"
    )
    expect((await db.executionRuns.get(root.id))?.personalMarks).toBeUndefined()
    expect((await db.executionRuns.get(child.id))?.personalMarks).toBeUndefined()
  } finally {
    db.executionRunEvents.hook("creating").unsubscribe(fail)
  }
})

it("marks a child's read on every team/plan/delegation ancestor before releasing its credential", async () => {
  const root = await startToolExecutionRun("root-session", { localAuthorization: LOCAL_PERSON_RUN })
  const team = await startToolExecutionRun("team", { parentRunId: root.id })
  const child = await startToolExecutionRun("child", { parentRunId: team.id })
  expect(
    await admitPersonalCredential({ executionRunId: child.id }, { source: "google-docs" })
  ).toMatchObject({ ok: true })
  for (const id of [root.id, team.id, child.id]) {
    expect((await getDb().executionRuns.get(id))?.personalMarks).toEqual([
      expect.objectContaining({ person: { kind: "local-person" }, source: "google-docs" }),
    ])
    const events = await getDb().executionRunEvents.where("runId").equals(id).toArray()
    expect(events.filter((event) => event.type === "personal.marked")).toHaveLength(1)
  }
  await admitPersonalCredential({ executionRunId: child.id }, { source: "google-docs" })
  expect(
    (await getDb().executionRunEvents.where("runId").equals(root.id).toArray()).filter(
      (event) => event.type === "personal.marked"
    )
  ).toHaveLength(1)
  // A blackboard result does not need a separate settlement hook to taint the root.
  publishEntry({
    teamId: team.id,
    key: "task:read",
    value: "private team finding",
    writer: { id: child.id, name: "reader" },
  })
  const [dependency] = readDependencyResults(team.id, ["read"])
  expect(dependency.value).toBe("private team finding")
  const blackboardReply = {
    ...message("blackboard-summary"),
    parts: [{ type: "text" as const, text: dependency.value }],
  }
  clearTeamMemory(team.id)
  bindPersonalMessageRun(blackboardReply.id, root.id)
  await commitMessageDelta("root-session", { upserts: [blackboardReply] })
  expect((await listMessages("root-session"))[0].metadata).toMatchObject({
    personalMarks: [expect.objectContaining({ source: "google-docs" })],
  })
})

it("fails closed and rolls back all ancestors when journal persistence fails", async () => {
  const root = await startToolExecutionRun("s", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("child", { parentRunId: root.id })
  const original = getDb().executionRunEvents.add.bind(getDb().executionRunEvents)
  const write = jest
    .spyOn(getDb().executionRunEvents, "add")
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error("storage failed"))
  try {
    expect(
      await admitPersonalCredential({ executionRunId: child.id }, { source: "github-user" })
    ).toMatchObject({ ok: false, reason: "mark-unavailable" })
    expect((await getDb().executionRuns.get(child.id))?.personalMarks).toBeUndefined()
    expect((await getDb().executionRuns.get(root.id))?.personalMarks).toBeUndefined()
  } finally {
    write.mockRestore()
  }
})

it("can mark a completed parent while preserving terminal state", async () => {
  const root = await startToolExecutionRun("s", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("child", { parentRunId: root.id })
  await finishToolExecutionRun(root.id)
  const before = await getDb().executionRuns.get(root.id)
  expect(
    await admitPersonalCredential({ executionRunId: child.id }, { source: "mcp-oauth" })
  ).toMatchObject({ ok: true })
  expect(await getDb().executionRuns.get(root.id)).toMatchObject({
    currentRevision: before!.currentRevision,
    updatedAt: before!.updatedAt,
    latestSnapshot: before!.latestSnapshot,
    status: "completed",
    personalMarks: [expect.objectContaining({ source: "mcp-oauth" })],
  })
})

it("reads Host marks at delta/full/stream persistence, ignores output marks, and keeps later turns independent", async () => {
  const first = await startToolExecutionRun("s", { localAuthorization: LOCAL_PERSON_RUN })
  const reply = message("first-reply")
  bindPersonalMessageChanges([], [reply], first.id)
  await commitMessageDelta("s", { upserts: [reply] })
  await getDb().executionRuns.update(first.id, { personalMarks: [mark] })
  const forged = { ...reply, metadata: { personalMarks: [{ ...mark, source: "forged" }] } }
  await persistStreamingMessages("s", [forged])
  expect((await listMessages("s"))[0].metadata).toMatchObject({ personalMarks: [mark] })
  await finishToolExecutionRun(first.id)
  const second = await startToolExecutionRun("s", { localAuthorization: LOCAL_PERSON_RUN })
  const later = message("later-reply")
  bindPersonalMessageRun(later.id, second.id)
  await persistMessages("s", [reply, later])
  const rows = await listMessages("s")
  expect(rows[0].metadata).toMatchObject({ personalMarks: [mark] })
  expect(rows[1].metadata).not.toHaveProperty("personalMarks")
})

it("merges the exact child marks onto framed user results", async () => {
  const child = await startToolExecutionRun("child", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(child.id, { personalMarks: [mark] })
  const framed = { ...message("framed"), role: "user" as const }
  bindPersonalMessageRun(framed.id, [child.id])
  await commitMessageDelta("parent", { upserts: [framed] })
  expect((await listMessages("parent"))[0].metadata).toMatchObject({ personalMarks: [mark] })
})

it("retains late structural source marks on confirmed output before a later turn consumes it", async () => {
  const source = await startToolExecutionRun("confirm-source", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const confirmed = await startToolExecutionRun("confirmed", {
    confirmedSkill: {
      originRunId: source.id,
      rootSessionId: "confirmed",
      requester: { kind: "local-person" },
    },
  })
  await getDb().executionRuns.update(source.id, { personalMarks: [mark] })
  const reply = message("confirmed-reply")
  bindPersonalMessageRun(reply.id, confirmed.id)
  await commitMessageDelta("confirmed", { upserts: [reply] })
  const [stored] = await listMessages("confirmed")
  expect(stored.metadata).toMatchObject({ personalMarks: [mark] })

  const later = await startToolExecutionRun("later-consumer", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const { preparePersonalHistory } = await import("./personal-visibility")
  await preparePersonalHistory("later-consumer", [stored], { executionRunId: later.id })
  expect((await getDb().executionRuns.get(later.id))?.personalMarks).toEqual([mark])
})

it("refuses a missing bound run instead of persisting an unmarked output", async () => {
  bindPersonalMessageRun("missing", "missing-run")
  await expect(
    personalMessageMetadata("missing", {}, undefined, { rowExists: false })
  ).rejects.toThrow("execution unavailable")
})

it("resolves legacy connector history without mutation and keeps post-marking service history unmarked", () => {
  const boundPerson = {
    kind: "platform" as const,
    platform: "lark",
    adapterId: "a",
    remoteUserId: "owner",
  }
  const legacy = { createdAt: 123 }
  const session = { platformBinding: { adapterId: "a" } }
  const context = { boundPerson, source: "lark-user" }
  expect(effectivePersonalMarks(legacy, session, context)).toEqual([
    { person: boundPerson, source: "lark-user", markedAt: 123 },
  ])
  expect(legacy).toEqual({ createdAt: 123 })
  expect(
    effectivePersonalMarks({ ...legacy, metadata: { personalMarkVersion: 1 } }, session, context)
  ).toEqual([])
  expect(
    effectivePersonalMarks({ ...legacy, metadata: { personalMarks: [mark] } }, session, context)
  ).toEqual([mark])
  expect(effectivePersonalMarks(legacy, {}, context)).toEqual([])
})

it.each(["missing", "cycle"])(
  "refuses and rolls back an invalid structural ancestor (%s)",
  async (kind) => {
    const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
    const child = await startToolExecutionRun("child", { parentRunId: root.id })
    await getDb().executionRuns.update(child.id, {
      parentRunId: kind === "missing" ? "missing-ancestor" : child.id,
    })
    expect(
      await admitPersonalCredential({ executionRunId: child.id }, { source: "google-docs" })
    ).toMatchObject({ ok: false, reason: "mark-unavailable" })
    expect((await getDb().executionRuns.get(child.id))?.personalMarks).toBeUndefined()
    expect((await getDb().executionRuns.get(root.id))?.personalMarks).toBeUndefined()
  }
)

it("makes legacy connector marks portable without changing source rows", async () => {
  const db = getDb()
  await db.sessions.put({
    id: "legacy-copy",
    title: "Legacy",
    createdAt: 1,
    updatedAt: 1,
    platformBinding: {
      platform: "lark",
      adapterId: "adapter",
      conversationKey: "chat",
      conversationRef: { platform: "lark", adapterId: "adapter" },
    },
  })
  await db.adapterInstances.put({
    id: "adapter",
    type: "lark",
    settings: { connectedUser: { openId: "owner" } },
  } as never)
  const row = {
    id: "legacy-copy-row",
    sessionId: "legacy-copy",
    role: "assistant" as const,
    parts: [],
    createdAt: 10,
  }
  await db.messages.put(row)
  const copy = await personalMessageForCopy(db, row)
  expect(copy.metadata).toMatchObject({
    personalMarks: [
      {
        person: { kind: "platform", platform: "lark", adapterId: "adapter", remoteUserId: "owner" },
        source: "lark-user",
        markedAt: 10,
      },
    ],
  })
  expect((await db.messages.get(row.id))?.metadata).toBeUndefined()
})

it.each([true, false])(
  "uses the connected Slack person or Host local owner for portable legacy history (%s)",
  async (connected) => {
    const db = getDb()
    const platformBinding = {
      platform: "slack" as const,
      adapterId: "slack-legacy",
      conversationKey: "chat",
      conversationRef: { platform: "slack" as const, adapterId: "slack-legacy" },
    }
    await db.adapterInstances.put({
      id: "slack-legacy",
      type: "slack",
      settings: {
        connectedTeam: connected
          ? { authedUserId: "U_OWNER", botUserId: "U_BOT" }
          : { botUserId: "U_BOT" },
      },
    } as never)
    const copy = await personalMessageForCopy(
      db,
      { sessionId: "slack-history", createdAt: 10 },
      { platformBinding }
    )
    expect(copy.metadata?.personalMarks).toEqual([
      {
        person: connected
          ? {
              kind: "platform",
              platform: "slack",
              adapterId: "slack-legacy",
              remoteUserId: "U_OWNER",
            }
          : { kind: "local-person" },
        source: "slack-user",
        markedAt: 10,
      },
    ])
  }
)

it.each([undefined, { note: "legacy" }])(
  "ignores output-supplied versions on existing legacy metadata (%j)",
  async (previous) => {
    const metadata = await personalMessageMetadata(
      "legacy-version",
      { personalMarkVersion: 1, note: "updated" },
      previous,
      { rowExists: true }
    )
    expect(metadata).toEqual({ note: "updated" })
  }
)
it("does not accept a version from a new output and retains a stored Host version", async () => {
  expect(
    await personalMessageMetadata("new-version", { personalMarkVersion: 1 }, undefined, {
      rowExists: false,
    })
  ).toBeUndefined()
  expect(
    await personalMessageMetadata(
      "stored-version",
      { personalMarkVersion: undefined },
      { personalMarkVersion: 1 },
      { rowExists: true }
    )
  ).toEqual({ personalMarkVersion: 1 })
})

it("retains committed marks while withholding a failed engine fence", async () => {
  const { bindPersonalEgressSession } = await import("./personal-egress")
  const run = await startToolExecutionRun("fence-failure", { localAuthorization: LOCAL_PERSON_RUN })
  const release = bindPersonalEgressSession({ executionRunId: run.id }, async () => {
    throw new Error("ACK unavailable")
  })
  try {
    await expect(addPersonalMarksToRun({ executionRunId: run.id }, [mark])).rejects.toThrow(
      "ACK unavailable"
    )
    expect((await getDb().executionRuns.get(run.id))?.personalMarks).toEqual([mark])
  } finally {
    release()
  }
})

it("H3: an account change during fence ACK withholds the old admission", async () => {
  const { bindPersonalEgressSession } = await import("./personal-egress")
  const schema = await import("@/lib/db/schema")
  const run = await startToolExecutionRun("account-fence", { localAuthorization: LOCAL_PERSON_RUN })
  const release = bindPersonalEgressSession({ executionRunId: run.id }, async () => {
    schema.activateAccountDatabase("h3-account-ack")
  })
  try {
    await expect(addPersonalMarksToRun({ executionRunId: run.id }, [mark])).rejects.toThrow(
      /database changed/
    )
  } finally {
    release()
    schema.clearAccountDatabaseSelection()
  }
})

it("S2 retains exact message producers without borrowing another active run", async () => {
  const { bindPersonalMessageEgressSource, personalMessageEgressSource } =
    await import("./personal-marks")
  const { assertPersonalEgress } = await import("./personal-egress")
  const run = await startToolExecutionRun("preview-producer", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  bindPersonalMessageEgressSource("preview-message", { executionRunId: run.id })
  await expect(
    assertPersonalEgress(await personalMessageEgressSource("preview-message"))
  ).resolves.toBeUndefined()
  await addPersonalMarksToRun({ executionRunId: run.id }, [
    { person: { kind: "local-person" }, source: "test", markedAt: 1 },
  ])
  await expect(
    assertPersonalEgress(await personalMessageEgressSource("preview-message"))
  ).rejects.toMatchObject({ code: "personal-egress-denied" })
})
