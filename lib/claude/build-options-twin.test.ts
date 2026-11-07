/**
 * Targeted coverage for the twin-injection branch of `resolveSendOptions`.
 * The full resolver has its own tests covering precedence rules; here we
 * just check that the new opt-in path triggers correctly and degrades
 * cleanly.
 */

// Mock the embedding module used by applyTwinContext so the test never
// makes a real network call.
jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbedding: jest.fn(async () => ({ embedding: [0.1, 0.2, 0.3], usage: undefined })),
  generateEmbeddings: jest.fn(async () => ({ embeddings: [], usage: undefined })),
}))

const mockHasNoLeakingPiiDeep = jest.fn((..._args: unknown[]) => true)
jest.mock("@cognia/redact", () => ({
  ...jest.requireActual("@cognia/redact"),
  hasNoLeakingPiiDeep: (value: unknown) => mockHasNoLeakingPiiDeep(value),
}))

// A pass-through spy on the twin runtime, so a test can see what it was given.
const mockApplyTwinContext = jest.fn()
jest.mock("@/lib/twin/runtime/apply-twin-context", () => {
  const actual = jest.requireActual("@/lib/twin/runtime/apply-twin-context")
  return {
    ...actual,
    applyTwinContext: (input: unknown) => {
      mockApplyTwinContext(input)
      return actual.applyTwinContext(input)
    },
  }
})

import { resolveSendOptions } from "./build-options"
import { contextSourcesOf } from "./context-sources"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { readTwinInjectLog, __resetTwinInjectLog } from "@/lib/twin/runtime/inject-log"
import type { Character } from "@cognia/agent-config-types"
import type { TwinRuntimeDepsForBuild } from "./build-options"
import type { IVectorStore } from "@cognia/vector/store"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetTwinInjectLog()
  mockApplyTwinContext.mockClear()
  mockHasNoLeakingPiiDeep.mockReset()
  mockHasNoLeakingPiiDeep.mockReturnValue(true)
})

const baseCharacter: Character = {
  id: "char_1",
  name: "Twin Alice",
  avatarColor: "oklch(0.7 0.15 240)",
  systemPrompt: "BASE_SYSTEM_PROMPT",
  twinId: "twin_alice",
  createdAt: 1,
  updatedAt: 1,
}

function makeVectorStore(
  searchByEmbedding: NonNullable<IVectorStore["searchByEmbedding"]> = async () => []
): IVectorStore {
  return {
    provider: "native",
    addDocuments: async () => undefined,
    updateDocuments: async () => undefined,
    deleteDocuments: async () => undefined,
    searchDocuments: async () => [],
    searchByEmbedding,
    getDocuments: async () => [],
    createCollection: async () => undefined,
    deleteCollection: async () => undefined,
    listCollections: async () => [],
    getCollectionInfo: async () => ({ name: "test", documentCount: 0 }),
  }
}

const fakeDeps: TwinRuntimeDepsForBuild = {
  store: makeVectorStore(),
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKey: "sk-test",
  },
}

afterAll(dbFixture.dispose)

const twinSources = (opts: Awaited<ReturnType<typeof resolveSendOptions>>) =>
  contextSourcesOf(opts.contextSources, "twin.identity")

describe("resolveSendOptions twin injection", () => {
  it("does not invoke the twin runtime when ctx.twinDeps is absent", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinUserMessage: "hi",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
  })

  it("does not record an inject-log entry when the twin runtime is not invoked", async () => {
    await resolveSendOptions({ character: baseCharacter, twinUserMessage: "hi" })
    expect(readTwinInjectLog()).toHaveLength(0)
  })

  it("records an inject-log entry when the twin runtime applies", async () => {
    await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "what would Alice do?",
    })
    const log = readTwinInjectLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      twinId: "twin_alice",
      source: "chat",
      applied: true,
    })
    expect(log[0].tokensApprox).toBeGreaterThan(0)
  })

  it("labels the inject-log entry with the caller-provided source", async () => {
    await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "hi",
      twinInjectSource: "team",
    })
    expect(readTwinInjectLog()[0]?.source).toBe("team")
  })

  it("records a degraded inject-log entry when the vector store throws", async () => {
    const explodingDeps: TwinRuntimeDepsForBuild = {
      ...fakeDeps,
      store: makeVectorStore(async () => {
        throw new Error("boom")
      }),
    }
    await resolveSendOptions({
      character: baseCharacter,
      twinDeps: explodingDeps,
      twinUserMessage: "hi",
    })
    const log = readTwinInjectLog()
    expect(log).toHaveLength(1)
    expect(log[0].degraded).toBe(true)
    expect(log[0].chunkCount).toBe(0)
  })

  it("does not invoke the twin runtime when twinUserMessage is blank", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "  ",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
  })

  it("does not invoke the twin runtime when character has no twinId", async () => {
    const opts = await resolveSendOptions({
      character: { ...baseCharacter, twinId: undefined },
      twinDeps: fakeDeps,
      twinUserMessage: "hi",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
  })

  it("replaces baseSystem with the four-segment twin prompt when all opt-in conditions are met", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "what would Alice do?",
    })
    expect(opts.systemPrompt).toContain("BASE_SYSTEM_PROMPT")
    expect(opts.systemPrompt).toContain("You are Twin Alice.")
  })

  it("suppresses Twin context when the assembled Twin prompt fails the PII gate", async () => {
    mockHasNoLeakingPiiDeep.mockReturnValueOnce(false)
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "what would Alice do?",
    })

    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
    expect(twinSources(opts)).toBeUndefined()
    expect(readTwinInjectLog()[0]).toMatchObject({
      applied: false,
      degraded: true,
      degradedReason: "prompt-pii-blocked",
    })
  })

  it("falls back to baseSystem if the twin runtime throws", async () => {
    const explodingDeps: TwinRuntimeDepsForBuild = {
      ...fakeDeps,
      store: makeVectorStore(async () => {
        throw new Error("boom")
      }),
    }
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: explodingDeps,
      twinUserMessage: "hi",
    })
    // Even when retrieval throws, applyTwinContext should still produce an
    // identity-only prompt (it wraps internal errors), so we still see the
    // twin identity block on top of the original.
    expect(opts.systemPrompt).toContain("BASE_SYSTEM_PROMPT")
  })

  it("reports no twin sources when retrieval returns nothing and runtime did not degrade", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "hi",
    })
    // Empty retrieval + no degradation → no twin sources to surface.
    expect(twinSources(opts)).toBeUndefined()
  })

  it("reports the twin sources with degraded=true when the vector store throws", async () => {
    const explodingDeps: TwinRuntimeDepsForBuild = {
      ...fakeDeps,
      store: makeVectorStore(async () => {
        throw new Error("boom")
      }),
    }
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: explodingDeps,
      twinUserMessage: "hi",
    })
    // Vector retrieval failure degrades the runtime; chat hook surfaces this
    // to the user via the SourcesPart "degraded" indicator.
    expect(twinSources(opts)?.degraded).toBe(true)
    expect(twinSources(opts)?.twinId).toBe("twin_alice")
    expect(twinSources(opts)?.retrievedChunks).toEqual([])
  })

  it("forwards precomputedQueryEmbedding to applyTwinContext", async () => {
    await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "what would Alice do?",
      precomputedQueryEmbedding: [0.5, 0.5, 0.1],
    })
    expect(mockApplyTwinContext).toHaveBeenCalledWith(
      expect.objectContaining({ precomputedQueryEmbedding: [0.5, 0.5, 0.1] })
    )
  })
})
