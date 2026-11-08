/** @jest-environment jsdom */
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  LOCAL_PERSON_RUN,
  recordAbsorbedRequester,
  startToolExecutionRun,
} from "@/lib/execution/acting-authority"
import { closeSession } from "@/lib/claude/ipc"
import { preparePersonalSteer, prepareTranscriptRuntimeSend } from "./claude-chat-send-options"
import { asideContextForRegenerate, buildPersonalAsideContext } from "./use-claude-chat-controller"

jest.mock("@/lib/claude/ipc", () => ({
  closeSession: jest.fn(async () => undefined),
  mcpRuntimeConfigurationMatches: jest.fn(() => true),
  sessionControl: jest.fn(async () => ({ retained: false })),
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({
  ...jest.requireActual("@/lib/runtime/standalone-mode"),
  isStandaloneChatMode: () => false,
}))

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.mocked(closeSession).mockClear()
})
afterAll(fixture.dispose)

it("reprojects an Aside's cached owner context after a second requester joins its root", async () => {
  const root = await migratedOwnerConversation()
  const child = await startToolExecutionRun("aside", { parentRunId: root.id })
  const ownerContext = await buildPersonalAsideContext("aside", "im", child.id)
  const cached = { ...ownerContext.delivery, messageId: "aside-user" }
  expect(asideContextForRegenerate(cached, "aside-user")?.context).toContain("private salary 12345")
  await recordAbsorbedRequester(root.id, {
    kind: "platform",
    platform: "lark",
    adapterId: "lark-owner",
    remoteUserId: "other",
  })
  const current = await buildPersonalAsideContext("aside", "im", child.id, {
    cursor: {
      sdkSessionId: "old-owner-engine",
      parentMessageId: null,
      tailFingerprint: "old-cache",
    },
    resumeSdkSessionId: "old-owner-engine",
  })
  expect(current.visibilityDigest).not.toBe(ownerContext.visibilityDigest)
  expect(current.delivery.context).toContain("[Withheld: personal content of Host owner]")
  expect(current.delivery.context).not.toContain("private salary 12345")
  expect(current.withheldMessageIds).toEqual(["legacy-user", "legacy-answer"])
})

async function migratedOwnerConversation() {
  const db = getDb()
  await db.adapterInstances.put({
    id: "lark-owner",
    type: "lark",
    displayName: "Owner IM",
    enabled: true,
    settings: { connectedUser: { openId: "owner-open-id", unionId: "owner-union-id" } },
    createdAt: 1,
    updatedAt: 1,
  } as never)
  await db.sessions.put({
    id: "im",
    title: "Owner IM",
    createdAt: 1,
    updatedAt: 1,
    platformBinding: { platform: "lark", adapterId: "lark-owner", conversationId: "owner-dm" },
  } as never)
  // Deliberately bypass the modern writer: these are pre-marking migrated rows.
  await db.messages.bulkPut([
    {
      id: "legacy-user",
      sessionId: "im",
      role: "user",
      createdAt: 1,
      parts: [{ type: "text", text: "Read my private report" }],
    },
    {
      id: "legacy-answer",
      sessionId: "im",
      role: "assistant",
      createdAt: 2,
      parts: [{ type: "text", text: "private salary 12345" }],
    },
  ] as never)
  return startToolExecutionRun("im", { localAuthorization: LOCAL_PERSON_RUN })
}

it("keeps an existing native owner resume through a fully visible upgrade", async () => {
  await migratedOwnerConversation()
  await getDb().sessions.update("im", { sdkSessionId: "pre-upgrade-owner-memory" })
  const own = await prepareTranscriptRuntimeSend("im", {
    provider: "anthropic",
    resumeSessionId: "pre-upgrade-owner-memory",
  })
  expect(own.resumeSessionId).toBe("pre-upgrade-owner-memory")
  expect(own.personalVisibilityHasWithheld).toBe(false)
  expect(closeSession).not.toHaveBeenCalled()
  expect((await getDb().sessions.get("im"))?.runtimePersonalVisibilityDigest).toBe(
    own.personalVisibilityDigest
  )
})

it.each(["anthropic", "openai"])(
  "retains the desktop owner's legacy IM history then rebuilds %s when another requester joins",
  async (provider) => {
    const root = await migratedOwnerConversation()
    const own = await prepareTranscriptRuntimeSend("im", { provider })
    expect(JSON.stringify(own)).toContain("private salary 12345")
    expect(JSON.stringify(own)).not.toContain("[Withheld:")
    expect((await getDb().sessions.get("im"))?.runtimePersonalVisibilityDigest).toBe(
      own.personalVisibilityDigest
    )
    await getDb().sessions.update("im", { sdkSessionId: "owner-engine-memory" })
    await recordAbsorbedRequester(root.id, {
      kind: "platform",
      platform: "lark",
      adapterId: "lark-owner",
      remoteUserId: "second-requester",
    })
    const joined = await prepareTranscriptRuntimeSend("im", {
      provider,
      resumeSessionId: "owner-engine-memory",
    })
    expect(closeSession).toHaveBeenCalledWith("im")
    expect(joined.personalVisibilityDigest).not.toBe(own.personalVisibilityDigest)
    expect(joined.resumeSessionId).toBeUndefined()
    expect(joined.expectedRuntimeSessionId).toBeUndefined()
    expect(JSON.stringify(joined)).toContain("[Withheld: personal content of Host owner]")
    expect(JSON.stringify(joined)).not.toContain("private salary 12345")
    expect((await getDb().sessions.get("im"))?.runtimePersonalVisibilityDigest).toBe(
      joined.personalVisibilityDigest
    )
  }
)

it("ends the retained engine before a second requester's live steer can enter it", async () => {
  const root = await migratedOwnerConversation()
  await prepareTranscriptRuntimeSend("im", { provider: "anthropic" })
  expect(await preparePersonalSteer("im", LOCAL_PERSON_RUN)).toBe(true)
  await recordAbsorbedRequester(root.id, {
    kind: "platform",
    platform: "lark",
    adapterId: "lark-owner",
    remoteUserId: "second-requester",
  })
  expect(await preparePersonalSteer("im")).toBe(false)
  expect(closeSession).toHaveBeenCalledWith("im")
  expect((await getDb().sessions.get("im"))?.runtimeTranscriptInvalidated).toEqual(
    expect.any(String)
  )
})
