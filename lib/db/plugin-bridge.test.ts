import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { messageRepository } from "./plugin-bridge"
import { effectivePersonalMarks } from "@/lib/execution/personal-marks"
import {
  invalidateTranscriptRuntime,
  withTranscriptRuntimeLock,
} from "@/lib/chat/transcript/revision-events"

jest.mock("@/lib/chat/transcript/revision-events", () => ({
  ...jest.requireActual("@/lib/chat/transcript/revision-events"),
  invalidateTranscriptRuntime: jest.fn(async () => {}),
}))
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => false }))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
beforeEach(async () => {
  await fixture.restore()
  jest.mocked(invalidateTranscriptRuntime).mockReset().mockResolvedValue(undefined)
  await getDb().sessions.put({ id: "s1", title: "Test", createdAt: 1, updatedAt: 1 } as never)
  await getDb().messages.put({
    id: "m1",
    sessionId: "s1",
    role: "user",
    parts: [{ type: "text", text: "original" }],
    createdAt: 1,
  })
})

it("invalidates the provider context for remote/plugin edits and deletions", async () => {
  await messageRepository.update("m1", { content: "corrected" })
  expect(invalidateTranscriptRuntime).toHaveBeenCalledWith("s1")
  expect((await getDb().messages.get("m1"))?.parts).toEqual([{ type: "text", text: "corrected" }])
  await messageRepository.delete("m1")
  expect(invalidateTranscriptRuntime).toHaveBeenCalledTimes(2)
})

it("leaves rows unchanged if runtime close fails", async () => {
  jest.mocked(invalidateTranscriptRuntime).mockRejectedValue(new Error("host unavailable"))
  await expect(messageRepository.update("m1", { content: "corrected" })).rejects.toThrow(
    "host unavailable"
  )
  await expect(messageRepository.delete("m1")).rejects.toThrow("host unavailable")
  await expect(messageRepository.deleteBySessionId("s1")).rejects.toThrow("host unavailable")
  expect((await getDb().messages.get("m1"))?.parts).toEqual([{ type: "text", text: "original" }])
})

it("does not interrupt a live turn for append or display metadata updates", async () => {
  await messageRepository.update("m1", { tokens: 12 } as never)
  await messageRepository.create("s1", { id: "m2", role: "user", content: "next" } as never)
  expect(invalidateTranscriptRuntime).not.toHaveBeenCalled()
})

it("does not forward plugin key paths into message metadata or parts", async () => {
  const metadata = { automatedTurn: { producer: "plugin" } }
  await getDb().messages.update("m1", { metadata })

  await messageRepository.update("m1", {
    content: "edited",
    "metadata.automatedTurn": undefined,
    "metadata.permissions.0": "allow",
    "parts.0.text": "injected",
  } as Parameters<typeof messageRepository.update>[1])

  const stored = await getDb().messages.get("m1")
  expect(stored?.metadata).toEqual(metadata)
  expect(stored?.parts).toEqual([{ type: "text", text: "edited" }])
  expect(Object.keys(stored ?? {}).some((key) => key.includes("."))).toBe(false)
})

it("keeps reconstruction behind the entire remote deletion, including its database commit", async () => {
  let releaseClose!: () => void
  let enteredClose!: () => void
  const entered = new Promise<void>((resolve) => {
    enteredClose = resolve
  })
  jest.mocked(invalidateTranscriptRuntime).mockImplementationOnce(async () => {
    enteredClose()
    await new Promise<void>((resolve) => {
      releaseClose = resolve
    })
  })
  const deletion = messageRepository.delete("m1")
  await entered
  const hydrate = jest.fn(async () => getDb().messages.where("sessionId").equals("s1").toArray())
  const send = withTranscriptRuntimeLock("s1", hydrate)
  await Promise.resolve()
  await Promise.resolve()
  expect(hydrate).not.toHaveBeenCalled()
  releaseClose()
  await deletion
  await expect(send).resolves.toEqual([])
})

it("preserves Host personal provenance when plugin create upserts an existing id", async () => {
  const personalMarks = [{ person: { kind: "local-person" }, source: "mcp-oauth", markedAt: 10 }]
  await getDb().messages.update("m1", { metadata: { personalMarks, personalMarkVersion: 1 } })
  await messageRepository.create("s1", { id: "m1", role: "user", content: "replacement" } as never)
  expect((await getDb().messages.get("m1"))?.metadata).toMatchObject({
    personalMarks,
    personalMarkVersion: 1,
  })
})

it("versions a new plugin-created connector row without relabeling a legacy update", async () => {
  await getDb().sessions.update("s1", {
    platformBinding: {
      platform: "lark",
      adapterId: "a",
      conversationKey: "c",
      conversationRef: { platform: "lark", adapterId: "a" },
    },
  })
  await messageRepository.create("s1", {
    id: "new-connector",
    role: "user",
    content: "new",
  } as never)
  await messageRepository.create("s1", { id: "m1", role: "user", content: "legacy edit" } as never)
  expect((await getDb().messages.get("new-connector"))?.metadata?.personalMarkVersion).toBe(1)
  expect((await getDb().messages.get("m1"))?.metadata?.personalMarkVersion).toBeUndefined()
})

it.each([undefined, { note: "legacy" }])(
  "keeps an existing plugin-written legacy connector row legacy (%j)",
  async (metadata) => {
    const platformBinding = {
      platform: "lark" as const,
      adapterId: "a",
      conversationKey: "c",
      conversationRef: { platform: "lark" as const, adapterId: "a" },
    }
    await getDb().sessions.update("s1", { platformBinding })
    await getDb().messages.put({
      id: "legacy-plugin",
      sessionId: "s1",
      role: "assistant",
      parts: [],
      createdAt: 10,
      ...(metadata ? { metadata } : {}),
    })
    await messageRepository.create("s1", {
      id: "legacy-plugin",
      role: "assistant",
      content: "edited",
      metadata: { personalMarkVersion: 1 },
    } as never)
    const row = (await getDb().messages.get("legacy-plugin"))!
    expect(row.metadata ?? {}).not.toHaveProperty("personalMarkVersion")
    const boundPerson = {
      kind: "platform" as const,
      platform: "lark",
      adapterId: "a",
      remoteUserId: "owner",
    }
    expect(
      effectivePersonalMarks(row, { platformBinding }, { boundPerson, source: "lark-user" })
    ).toEqual([{ person: boundPerson, source: "lark-user", markedAt: row.createdAt }])
  }
)
it("does not accept a plugin's version on a new unbound message", async () => {
  await messageRepository.create("s1", {
    id: "unbound-forgery",
    role: "assistant",
    content: "new",
    metadata: { personalMarkVersion: 1 },
  } as never)
  expect((await getDb().messages.get("unbound-forgery"))?.metadata ?? {}).not.toHaveProperty(
    "personalMarkVersion"
  )
})
it("keeps a post-marking version when a plugin explicitly tries to remove it", async () => {
  await getDb().messages.update("m1", { metadata: { personalMarkVersion: 1 } })
  await messageRepository.create("s1", {
    id: "m1",
    role: "assistant",
    content: "edited",
    metadata: { personalMarkVersion: undefined },
  } as never)
  await messageRepository.update("m1", { metadata: { personalMarkVersion: undefined } })
  expect((await getDb().messages.get("m1"))?.metadata?.personalMarkVersion).toBe(1)
})

it("keeps marks added while a plugin edit awaits transcript invalidation", async () => {
  const db = getDb()
  await db.messages.update("m1", { metadata: { tokens: 1, personalMarkVersion: 1 } })
  let entered!: () => void
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  jest.mocked(invalidateTranscriptRuntime).mockImplementationOnce(async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  const edit = messageRepository.update("m1", { content: "edited", tokens: 2 } as never)
  await waiting
  const personalMarks = [{ person: { kind: "local-person" }, source: "google-docs", markedAt: 10 }]
  try {
    const current = (await db.messages.get("m1"))!
    await db.messages.update("m1", { metadata: { ...current.metadata, personalMarks } })
  } finally {
    release()
  }
  await edit
  expect((await db.messages.get("m1"))?.metadata).toEqual({
    tokens: 2,
    personalMarkVersion: 1,
    personalMarks,
  })
})
