/** @jest-environment jsdom */
/**
 * Real-Dexie interleaving for the live-voice archive (audit C01).
 *
 * The voice writer used to read the whole history, merge its turns in, and
 * replace the transcript. The read happened before the per-session write
 * queue, so an ordinary message committed between the read and the replace was
 * missing from the snapshot and got deleted as an "omission". The writer now
 * upserts through `commitMessageDelta`, which never deletes what it was not
 * told to delete.
 */
import type { UIMessage } from "ai"

import { commitMessageDelta, listMessages, persistMessages } from "@/lib/db/messages"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import { createLiveVoiceTurnPersister, liveVoiceMessageId } from "./persist-turns"

jest.mock("@/lib/memory/lifecycle/claim-deletion-closure", () => ({
  revokeClaimsForDeletedMessages: jest.fn(),
  revokeClaimsForDeletedSession: jest.fn(),
}))

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().messages.clear()
})
afterAll(dbFixture.dispose)

async function putSession(id: string): Promise<void> {
  await getDb().sessions.put({
    id,
    projectId: "proj-A",
    title: id,
    updatedAt: 1,
    createdAt: 1,
  } as never)
}

function typed(id: string, text: string, createdAt: number): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { createdAt },
  } as UIMessage
}

const PROVENANCE = { provider: "openai", modelOrResource: "gpt-realtime-2.1", region: "global" }

it("never deletes an ordinary message another writer commits while a voice turn is saved", async () => {
  await putSession("chat")
  await persistMessages("chat", [typed("typed-before", "typed before the call", 10)])
  const persister = createLiveVoiceTurnPersister({
    sessionId: "chat",
    callId: "call-1",
    provenance: PROVENANCE as never,
    startedAt: 1_000,
  })

  // Start the voice write and, before it can land, commit a typed message the
  // voice writer has never seen.
  const voiceWrite = persister.append([{ id: "1:item_1", role: "user", text: "spoken" }])
  const typedWrite = commitMessageDelta("chat", {
    upserts: [typed("typed-during", "typed during the call", 500)],
  })
  await Promise.all([voiceWrite, typedWrite])
  await persister.flush([
    { id: "1:item_1", role: "user", text: "spoken" },
    { id: "1:item_2", role: "assistant", text: "answered" },
  ])

  expect((await listMessages("chat")).map((message) => message.id)).toEqual([
    "typed-before",
    "typed-during",
    liveVoiceMessageId("chat", "call-1", "1:item_1"),
    liveVoiceMessageId("chat", "call-1", "1:item_2"),
  ])
})

it("updates a revised turn in place and refreshes the session preview", async () => {
  await putSession("chat")
  const persister = createLiveVoiceTurnPersister({
    sessionId: "chat",
    callId: "call-1",
    provenance: PROVENANCE as never,
    startedAt: 2_000,
  })

  await persister.append([{ id: "1:google-input-0", role: "user", text: "hello" }])
  await persister.append([{ id: "1:google-input-0", role: "user", text: "hello world" }])

  const messages = await listMessages("chat")
  expect(messages).toHaveLength(1)
  expect(messages[0].parts).toEqual([{ type: "text", text: "hello world" }])
  const session = await getDb().sessions.get("chat")
  expect(session?.lastMessagePreview).toBe("hello world")
  expect(session?.lastMessageAt).toBe(2_000)
})

it("previews the newest spoken turn, not the tool lifecycle row written after it", async () => {
  await putSession("chat")
  const persister = createLiveVoiceTurnPersister({
    sessionId: "chat",
    callId: "call-1",
    provenance: PROVENANCE as never,
    startedAt: 3_000,
  })

  await persister.flush(
    [{ id: "1:item_1", role: "assistant", text: "found two notes" }],
    [{ callId: "t1", name: "search_notes", status: "completed", durationMs: 4 }]
  )

  expect((await getDb().sessions.get("chat"))?.lastMessagePreview).toBe("found two notes")
})

it("keeps two calls in one chat as separate rows", async () => {
  await putSession("chat")
  for (const [callId, text, startedAt] of [
    ["call-1", "first call", 1_000],
    ["call-2", "second call", 5_000],
  ] as const) {
    const persister = createLiveVoiceTurnPersister({
      sessionId: "chat",
      callId,
      provenance: PROVENANCE as never,
      startedAt,
    })
    // Same provider item id in both calls (Gemini restarts its counter).
    await persister.flush([{ id: "1:google-input-0", role: "user", text }])
  }

  expect((await listMessages("chat")).map((message) => message.parts[0])).toEqual([
    { type: "text", text: "first call" },
    { type: "text", text: "second call" },
  ])
})
