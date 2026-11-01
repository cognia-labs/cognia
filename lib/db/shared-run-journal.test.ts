import "fake-indexeddb/auto"
import Dexie from "dexie"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  __resetAccountContentCipherForTesting,
} from "@/lib/accounts/content-cipher"
import { CogniaDB } from "./schema"
import {
  getSharedRunJournal,
  putSharedRunJournal,
  deleteSharedRunJournal,
  getSharedSendJournal,
  putSharedSendJournal,
  deleteSharedSendJournal,
  type SharedRunJournal,
  operationTranscriptDigest,
  tombstoneAgentTurnOperations,
} from "./shared-run-journal"

const name = "cognia-account-shared-journal-test"
const journal: SharedRunJournal = {
  runId: "run",
  leaseId: "lease",
  token: "never-plaintext-lease-token",
  deviceId: "device",
  baselineMessageIds: ["message"],
  terminalStatus: "completed",
}
let db: CogniaDB

beforeEach(async () => {
  await Dexie.delete(name)
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("shared-journal-test", name)
  )
  db = new CogniaDB(name)
  await db.open()
})
afterEach(async () => {
  db.close()
  await Dexie.delete(name)
  __resetAccountContentCipherForTesting()
})

it("recovers terminal proof across reopen without storing a plaintext token", async () => {
  await putSharedRunJournal("endpoint/org/session", journal, db)
  db.close()
  await db.open()
  expect(await getSharedRunJournal("endpoint/org/session", db)).toEqual(journal)
  const raw = new Dexie(name)
  await raw.open()
  try {
    const row = await raw.table("sharedRunJournals").get("endpoint/org/session")
    expect(row.__cogniaEncryptedContent).toBeDefined()
    expect(JSON.stringify(row)).not.toContain(journal.token)
  } finally {
    raw.close()
  }
  await deleteSharedRunJournal("endpoint/org/session", db)
  expect(await getSharedRunJournal("endpoint/org/session", db)).toBeUndefined()
})

it("refuses a legacy unencrypted database and a locked account", async () => {
  const legacy = new CogniaDB("unencrypted-journal-test")
  await expect(putSharedRunJournal("key", journal, legacy)).rejects.toThrow("encrypted account")
  legacy.close()
  __resetAccountContentCipherForTesting()
  await expect(putSharedRunJournal("key", journal, db)).rejects.toThrow("locked")
})

it("keeps unrelated execution journals when one run completes", async () => {
  await putSharedRunJournal("first", journal, db)
  await putSharedRunJournal("second", { ...journal, runId: "second" }, db)
  await deleteSharedRunJournal("first", db)
  expect((await getSharedRunJournal("second", db))?.runId).toBe("second")
})

it("preserves a failed send identity across restart without mixing it with run recovery", async () => {
  const send = {
    messageId: "stable-id",
    parts: [{ type: "text", text: "private draft" }],
    createdAt: 1,
  }
  await putSharedSendJournal("same", send, db)
  await putSharedRunJournal("same", journal, db)
  db.close()
  await db.open()
  expect(await getSharedSendJournal("same", db)).toEqual(send)
  await deleteSharedSendJournal("same", db)
  expect(await getSharedSendJournal("same", db)).toBeUndefined()
  expect(await getSharedRunJournal("same", db)).toEqual(journal)
})

it("recovers an operation completion after reopen without exposing its reply in plaintext", async () => {
  const agentTurnOperation = {
    version: 1 as const,
    operationId: "operation",
    sessionId: "session",
    requestFingerprint: "fingerprint",
    result: { sessionId: "session", text: "private reply", status: "completed" as const },
  }
  await db.sharedRunJournals.add({ id: "agent-turn:operation", agentTurnOperation })
  db.close()
  await db.open()
  expect((await db.sharedRunJournals.get("agent-turn:operation"))?.agentTurnOperation).toEqual(
    agentTurnOperation
  )
  const raw = new Dexie(name)
  await raw.open()
  try {
    expect(
      JSON.stringify(await raw.table("sharedRunJournals").get("agent-turn:operation"))
    ).not.toContain("private reply")
  } finally {
    raw.close()
  }
})

it("tombstones completions without touching paired run credentials", async () => {
  await putSharedRunJournal("paired", journal, db)
  await db.sharedRunJournals.add({
    id: "completion",
    agentTurnOperation: {
      version: 1,
      operationId: "operation",
      requestFingerprint: "digest",
      sessionId: "session",
      executionRunId: "run",
      result: { sessionId: "session", text: "Removed reply", status: "completed" },
    },
  })
  await db.transaction("rw", db.sharedRunJournals, () =>
    tombstoneAgentTurnOperations(new Set(["session"]), db)
  )
  expect((await db.sharedRunJournals.get("completion"))?.agentTurnOperation).toEqual({
    version: 1,
    operationId: "operation",
    requestFingerprint: "digest",
    sessionId: "session",
    deleted: true,
  })
  expect(await getSharedRunJournal("paired", db)).toEqual(journal)
})

it("tombstones only pending operations whose logical prompt was removed", async () => {
  const pending = (id: string) => ({
    version: 1 as const,
    operationId: id,
    sessionId: "session",
    requestFingerprint: "digest",
    userMessageId: id,
  })
  await db.sharedRunJournals.bulkPut([
    { id: "removed", agentTurnOperation: pending("removed") },
    { id: "kept", agentTurnOperation: pending("kept") },
  ])
  await tombstoneAgentTurnOperations(new Set(["session"]), db, new Set(["removed"]))
  expect((await db.sharedRunJournals.get("removed"))?.agentTurnOperation).toMatchObject({
    deleted: true,
  })
  expect((await db.sharedRunJournals.get("kept"))?.agentTurnOperation).toEqual(pending("kept"))
})

it("keeps a completed operation when an unrelated message is removed", async () => {
  const completed = (id: string) => ({
    version: 1 as const,
    operationId: id,
    sessionId: "session",
    requestFingerprint: "digest",
    userMessageId: `${id}-prompt`,
    replyMessageIds: [`${id}-reply`],
    result: { sessionId: "session", text: `${id} reply`, status: "completed" as const },
  })
  await db.sharedRunJournals.bulkPut([
    { id: "unrelated", agentTurnOperation: completed("unrelated") },
    { id: "prompt", agentTurnOperation: completed("prompt") },
    { id: "reply", agentTurnOperation: completed("reply") },
  ])
  await tombstoneAgentTurnOperations(
    new Set(["session"]),
    db,
    new Set(["older-message", "prompt-prompt", "reply-reply"])
  )
  expect((await db.sharedRunJournals.get("unrelated"))?.agentTurnOperation).toEqual(
    completed("unrelated")
  )
  for (const id of ["prompt", "reply"])
    expect((await db.sharedRunJournals.get(id))?.agentTurnOperation).toMatchObject({
      deleted: true,
    })
})

it("digests prompt and reply rows only while every row is live and unchanged", () => {
  const row = (id: string, text: string, extra: Record<string, unknown> = {}) =>
    ({
      id,
      sessionId: "session",
      role: "assistant",
      parts: [{ type: "text", text }],
      ...extra,
    }) as never
  const digest = operationTranscriptDigest([row("a", "one"), row("b", "two")], "session")
  expect(digest).toEqual(expect.any(String))
  expect(operationTranscriptDigest([row("a", "one"), row("b", "two")], "session")).toBe(digest)
  expect(operationTranscriptDigest([row("a", "one"), row("b", "changed")], "session")).not.toBe(
    digest
  )
  expect(operationTranscriptDigest([row("a", "one"), undefined], "session")).toBeUndefined()
  expect(
    operationTranscriptDigest([row("a", "one", { metadata: { deletedAt: 1 } })], "session")
  ).toBeUndefined()
  expect(operationTranscriptDigest([row("a", "one")], "other")).toBeUndefined()
  const foreign = Object.assign(Object.create({}), { type: "text", text: "one" })
  expect(operationTranscriptDigest([row("a", "x", { parts: [foreign] })], "session")).not.toBe(
    operationTranscriptDigest([row("a", "x", { parts: [{ ...foreign, text: "two" }] })], "session")
  )
  expect(operationTranscriptDigest([], "session")).toBeUndefined()
})
