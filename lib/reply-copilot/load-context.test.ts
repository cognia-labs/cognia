const mockMemoryVisibility = jest.fn((deps: unknown, ..._args: unknown[]) => deps)
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: jest.fn(async () => ({ loadCandidates: jest.fn() })),
  withPersonalMemoryVisibility: (...args: unknown[]) =>
    mockMemoryVisibility(...(args as [unknown])),
}))
jest.mock("@/lib/execution/acting-authority", () => ({
  LOCAL_PERSON_RUN: Symbol("owner"),
  startToolExecutionRun: jest.fn(async () => ({ id: "owner-copilot-recall" })),
  finishToolExecutionRun: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/adapter-instances", () => ({ getAdapterInstance: jest.fn() }))
jest.mock("@/lib/db/messages", () => ({ listRecentMessages: jest.fn() }))
jest.mock("@/lib/db/platform-identities", () => ({
  getByPlatformUser: jest.fn(),
  contactProfileOf: (row: { relationship?: string; note?: string }) => ({
    ...(row.relationship ? { relationship: row.relationship } : {}),
    ...(row.note ? { note: row.note } : {}),
  }),
}))
jest.mock("@/lib/memory/retrieve/retriever", () => ({ retrieveMemories: jest.fn() }))
jest.mock("@/lib/execution/personal-visibility", () => {
  const { withholdForReaders } = jest.requireActual<
    typeof import("@cognia/plugin-contract/types/execution/personal-visibility")
  >("@cognia/plugin-contract/types/execution/personal-visibility")
  return {
    prepareOwnerHistory: async <T extends { id: string; metadata?: unknown }>(
      messages: readonly T[]
    ) => ({ ...withholdForReaders(messages, [{ kind: "local-person" }]), readers: [] }),
  }
})

import type { AppSettings } from "@cognia/agent-config-types"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import type { TranscriptRow } from "./build-state"
import {
  copilotMemoryAllowed,
  loadCopilotContext,
  recallCopilotMemory,
  type LoadContextDeps,
} from "./load-context"
import { listRecentMessages } from "@/lib/db/messages"
import { retrieveMemories } from "@/lib/memory/retrieve/retriever"
import {
  LOCAL_PERSON_RUN,
  startToolExecutionRun,
  finishToolExecutionRun,
} from "@/lib/execution/acting-authority"

const inbound: TranscriptRow = {
  role: "user",
  parts: [{ type: "text", text: "你到了吗" }],
  metadata: {
    platformMessage: {
      messageId: "m1",
      platform: "telegram",
      sender: { id: "pid_x", platform: "telegram", remoteUserId: "u1", displayName: "Ann" },
    },
  },
}

const echo: TranscriptRow = {
  role: "user",
  parts: [{ type: "text", text: "马上到" }],
  metadata: {
    platformMessage: {
      messageId: "m2",
      platform: "telegram",
      sender: { id: "pid_bot", platform: "telegram", remoteUserId: "bot-1", displayName: "Me" },
    },
  },
}

const optedIn = {
  composerAssistance: { replyCopilot: { memory: true } },
  memory: { enabled: true, useMemory: true },
} as unknown as AppSettings

function deps(overrides: Partial<LoadContextDeps> = {}): LoadContextDeps {
  return {
    listRows: async () => [inbound, echo],
    selfPlatformIds: async () => new Set(["bot-1"]),
    resolveContact: async () =>
      ({ id: "pid_x", displayName: "Ann", relationship: "sister" }) as PlatformIdentityRow,
    recall: async () => ["likes hotpot"],
    ...overrides,
  }
}

const session = {
  id: "s1",
  platformBinding: { adapterId: "tg1", conversationKey: "telegram:tg1:42" },
} as never

describe("copilotMemoryAllowed", () => {
  it("needs both the copilot opt-in and a recall-allowing policy", () => {
    expect(copilotMemoryAllowed({}, optedIn)).toBe(true)
    expect(copilotMemoryAllowed({ memoryUse: false }, optedIn)).toBe(false)
    expect(copilotMemoryAllowed({}, { ...optedIn, composerAssistance: {} } as AppSettings)).toBe(
      false
    )
    expect(
      copilotMemoryAllowed({}, { ...optedIn, memory: { enabled: false } } as unknown as AppSettings)
    ).toBe(false)
    expect(copilotMemoryAllowed({}, null)).toBe(false)
  })
})

describe("loadCopilotContext", () => {
  it("filters the production history reader before the copilot sees personal content", async () => {
    jest.mocked(listRecentMessages).mockResolvedValueOnce([
      {
        id: "private",
        role: "assistant",
        parts: [{ type: "text", text: "private source" }],
        metadata: {
          personalMarks: [
            {
              person: {
                kind: "platform",
                platform: "lark",
                adapterId: "foreign-adapter",
                remoteUserId: "foreign-person",
              },
              source: "test",
              markedAt: 1,
            },
          ],
        },
      },
    ])
    const ctx = await loadCopilotContext({ id: "s1" }, null)
    expect(ctx.transcript.turns).toEqual([
      { from: "me", text: expect.stringContaining("[Withheld: personal content of person ") },
    ])
  })

  it("retains the owner's personal transcript in drafts shown only to the owner", async () => {
    jest.mocked(listRecentMessages).mockResolvedValueOnce([
      {
        id: "owner-copilot",
        role: "assistant",
        parts: [{ type: "text", text: "OWNER COPILOT CONTEXT" }],
        metadata: {
          personalMarks: [{ person: { kind: "local-person" }, source: "read", markedAt: 1 }],
        },
      },
    ])
    const ctx = await loadCopilotContext({ id: "s1" }, null)
    expect(ctx.transcript.turns).toEqual([{ from: "me", text: "OWNER COPILOT CONTEXT" }])
  })

  it("classifies the bot's own echo as me and reads the contact + memory", async () => {
    const resolveContact = jest.fn(deps().resolveContact)
    const recall = jest.fn(async () => ["likes hotpot"])
    const ctx = await loadCopilotContext(session, optedIn, deps({ resolveContact, recall }))
    expect(ctx.transcript.turns).toEqual([
      { from: "other", text: "你到了吗" },
      { from: "me", text: "马上到" },
    ])
    expect(resolveContact).toHaveBeenCalledWith({
      sender: expect.objectContaining({ remoteUserId: "u1" }),
      conversationKey: "telegram:tg1:42",
      isGroup: false,
    })
    expect(ctx.knowledge).toMatchObject({ relationship: "sister", memoryLines: 1 })
    expect(recall).toHaveBeenCalledWith(optedIn, expect.any(String))
  })

  it("does not recall without the opt-in", async () => {
    const recall = jest.fn(async () => ["x"])
    const ctx = await loadCopilotContext(session, {} as AppSettings, deps({ recall }))
    expect(recall).not.toHaveBeenCalled()
    expect(ctx.knowledge.memorySkipped).toBe("disabled")
  })
})

it("uses an admitted owner reader through personal copilot memory recall and releases it", async () => {
  jest
    .mocked(retrieveMemories)
    .mockResolvedValueOnce([{ memory: { text: "Owner memory" } }] as never)
  expect(await recallCopilotMemory(optedIn, "owner draft")).toEqual(["Owner memory"])
  expect(startToolExecutionRun).toHaveBeenCalledWith(undefined, {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  expect(mockMemoryVisibility).toHaveBeenCalledWith(
    expect.anything(),
    undefined,
    "owner-copilot-recall"
  )
  expect(finishToolExecutionRun).toHaveBeenCalledWith("owner-copilot-recall", false)
})
