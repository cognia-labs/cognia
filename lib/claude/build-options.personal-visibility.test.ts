/** @jest-environment jsdom */
import { resolveSendOptions } from "./build-options"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  LOCAL_PERSON_RUN,
  startToolExecutionRun,
  recordAbsorbedRequester,
} from "@/lib/execution/acting-authority"
import type { ChatSession, AppSettings } from "@cognia/agent-config-types"
import type { Memory } from "@/types/memory/memory"
import { createRecording } from "@/lib/db/skill-recordings"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("records the live reader digest when only the memory contribution supplies personal context", async () => {
  const session: ChatSession = { id: "memory-only", title: "Chat", createdAt: 1, updatedAt: 1 }
  await getDb().sessions.put(session)
  const run = await startToolExecutionRun(session.id, { localAuthorization: LOCAL_PERSON_RUN })
  const memory = {
    id: "memory-only-fact",
    scope: "global",
    type: "semantic",
    text: "pnpm owner fact",
    tags: [],
    importance: 10,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: true,
    provenance: "user",
  } as Memory
  const options = await resolveSendOptions({
    session,
    executionIdentity: { runId: run.id },
    preloadedEnv: {},
    preloadedMcpServers: [],
    memoryUserMessage: "pnpm",
    memoryDeps: { loadCandidates: async () => [memory], loadProcedural: async () => [] },
    appSettings: { memory: {} } as AppSettings,
  })
  expect(JSON.stringify(options)).toContain("pnpm owner fact")
  expect(options.personalContextReadersDigest).toEqual(expect.any(String))
})

it("filters the branch seed and memory recall for the live root, retaining the owner's own context", async () => {
  const session: ChatSession = {
    id: "s",
    title: "Conversation",
    createdAt: 1,
    updatedAt: 1,
    branchSeed: { kind: "summary", content: "secret derived summary" },
    platformBinding: {
      platform: "lark",
      adapterId: "owner-adapter",
      conversationKey: "owner-chat",
      conversationRef: { platform: "lark", adapterId: "owner-adapter" },
    },
  }
  await getDb().sessions.put(session)
  await getDb().adapterInstances.put({
    id: "owner-adapter",
    type: "lark",
    settings: { connectedUser: { openId: "owner" } },
  } as never)
  await getDb().skills.put({
    id: "recorded-private",
    name: "secret recorded title",
    content: "secret recorded instructions",
    source: "generated",
    status: "enabled",
    createdAt: 1,
    updatedAt: 1,
  })
  const run = await startToolExecutionRun("s", { localAuthorization: LOCAL_PERSON_RUN })
  await getDb().executionRuns.update(run.id, {
    personalMarks: [{ person: { kind: "local-person" }, source: "lark-user", markedAt: 1 }],
  })
  await createRecording({
    id: "recording-private",
    skillId: "recorded-private",
    status: "saved",
    source: { kind: "run", runId: run.id, sessionId: session.id },
  })
  const memory = {
    id: "fact",
    scope: "global",
    type: "semantic",
    text: "pnpm secret private fact",
    tags: [],
    importance: 10,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: true,
    provenance: "user",
  } as Memory
  const common = {
    session,
    executionIdentity: { runId: run.id },
    preloadedEnv: {},
    preloadedMcpServers: [],
    ephemeralSkillIds: ["recorded-private"],
    memoryUserMessage: "pnpm",
    memoryDeps: { loadCandidates: async () => [memory], loadProcedural: async () => [] },
    appSettings: { memory: {}, cacheOptimizationEnabled: false } as AppSettings,
  }
  const own = await resolveSendOptions(common)
  expect(JSON.stringify(own)).toContain("secret derived summary")
  expect(JSON.stringify(own)).toContain("pnpm secret private fact")
  expect(JSON.stringify(own)).toContain("secret recorded instructions")
  expect(own.personalContextReadersDigest).toEqual(expect.any(String))
  await recordAbsorbedRequester(run.id, {
    kind: "platform",
    platform: "slack",
    adapterId: "a",
    remoteUserId: "other",
  })
  const joined = await resolveSendOptions(common)
  expect(JSON.stringify(joined)).not.toMatch(
    /secret derived summary|pnpm secret private fact|secret recorded/
  )
  expect(joined.appendSystemPrompt).toContain("[Withheld: personal content of Host owner]")
})

it("keeps old owner seeds and generated skills without recording provenance, then withholds them from another reader", async () => {
  const session: ChatSession = {
    id: "old-owner",
    title: "Old owner session",
    createdAt: 1,
    updatedAt: 1,
    branchSeed: { kind: "summary", content: "legacy owner summary" },
  }
  await getDb().sessions.put(session)
  await getDb().skills.put({
    id: "old-generated",
    name: "Old generated skill",
    content: "legacy owner instructions",
    source: "generated",
    status: "enabled",
    createdAt: 1,
    updatedAt: 1,
  })
  const run = await startToolExecutionRun(session.id, { localAuthorization: LOCAL_PERSON_RUN })
  const context = {
    session,
    executionIdentity: { runId: run.id },
    ephemeralSkillIds: ["old-generated"],
    preloadedEnv: {},
    preloadedMcpServers: [],
    appSettings: { cacheOptimizationEnabled: false } as AppSettings,
  }
  const own = await resolveSendOptions(context)
  expect(JSON.stringify(own)).toContain("legacy owner summary")
  expect(JSON.stringify(own)).toContain("legacy owner instructions")
  await recordAbsorbedRequester(run.id, {
    kind: "platform",
    platform: "slack",
    adapterId: "a",
    remoteUserId: "other",
  })
  expect(JSON.stringify(await resolveSendOptions(context))).not.toMatch(
    /legacy owner summary|legacy owner instructions/
  )
})

it("re-derives an owner-staged attached seed from its parent's marks for the consuming run", async () => {
  const parent: ChatSession = { id: "attached-parent", title: "Parent", createdAt: 1, updatedAt: 1 }
  const session: ChatSession = {
    id: "attached-child",
    title: "Child",
    createdAt: 1,
    updatedAt: 1,
    branchSeed: { kind: "transcript", content: "owner staged private history" },
    attachedChild: {
      parentSessionId: parent.id,
      lifecycleOwnerSessionId: parent.id,
      context: { mode: "full" },
      workspace: "shared",
      status: "staged",
      createdAt: 1,
      updatedAt: 1,
    },
  }
  await getDb().sessions.bulkPut([parent, session])
  await getDb().messages.put({
    id: "parent-private",
    sessionId: parent.id,
    role: "assistant",
    createdAt: 1,
    parts: [{ type: "text", text: "owner staged private history" }],
    metadata: {
      personalMarks: [{ person: { kind: "local-person" }, source: "personal", markedAt: 1 }],
    },
  })
  const run = await startToolExecutionRun(session.id, { localAuthorization: LOCAL_PERSON_RUN })
  const context = {
    session,
    executionIdentity: { runId: run.id },
    preloadedEnv: {},
    preloadedMcpServers: [],
    appSettings: { cacheOptimizationEnabled: false } as AppSettings,
  }
  expect(JSON.stringify(await resolveSendOptions(context))).toContain(
    "owner staged private history"
  )
  await recordAbsorbedRequester(run.id, {
    kind: "platform",
    platform: "slack",
    adapterId: "a",
    remoteUserId: "other",
  })
  expect(JSON.stringify(await resolveSendOptions(context))).not.toContain(
    "owner staged private history"
  )
})
