import type { Memory } from "../types/memory"
import {
  applyMemoryContext,
  MEMORY_RECALL_PREAMBLE,
  PROCEDURAL_PRECEDENCE_NOTE,
  RECALL_HEADING,
  type ApplyMemoryContextDeps,
} from "./apply-memory-context"
import * as framing from "./recall-framing"
import { createContextManager } from "@cognia/rag/context-manager"
import { __resetMemoryBm25Cache } from "../retrieve/retriever"

// Keep cache state independent between retrieval scenarios.
beforeEach(() => __resetMemoryBm25Cache())

let seq = 0
function mem(text: string, over: Partial<Memory> = {}): Memory {
  seq += 1
  const now = 1_700_000_000_000
  return {
    id: over.id ?? `m${seq}`,
    scope: "global",
    type: "semantic",
    text,
    tags: [],
    importance: 5,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...(over.type === "procedural" ? { reviewStatus: "verified" as const } : {}),
    ...over,
  }
}

function deps(over: Partial<ApplyMemoryContextDeps> = {}): ApplyMemoryContextDeps {
  return {
    loadCandidates: async () => [],
    loadProcedural: async () => [],
    ...over,
  }
}

const base = { topK: 5, relevanceFloor: 0 }

describe("applyMemoryContext", () => {
  it("returns null section when nothing is recalled or procedural", async () => {
    const res = await applyMemoryContext({ userMessage: "hi", ...base, deps: deps() })
    expect(res.systemPromptSection).toBeNull()
    expect(res.retrievedMemories).toEqual([])
    expect(res.proceduralCount).toBe(0)
    expect(res.degraded).toBe(false)
  })

  it("injects a recall section for semantic/episodic hits", async () => {
    const res = await applyMemoryContext({
      userMessage: "pnpm",
      ...base,
      deps: deps({ loadCandidates: async () => [mem("The user prefers pnpm", { id: "hit" })] }),
    })
    expect(res.systemPromptSection).toContain("## What you remember about the user")
    expect(res.systemPromptSection).toContain("- The user prefers pnpm")
    expect(res.retrievedMemories.map((m) => m.id)).toEqual(["hit"])
  })

  it("returns a prepared snapshot binding the delivered rows at their versions", async () => {
    const res = await applyMemoryContext({
      userMessage: "pnpm",
      ...base,
      now: 42_000,
      deps: deps({
        loadCandidates: async () => [mem("The user prefers pnpm", { id: "hit", version: 7 })],
      }),
    })
    expect(res.snapshot.delivery).toBe("prepared")
    expect(res.snapshot.createdAt).toBe(42_000)
    expect(res.snapshot.expiresAt).toBeGreaterThan(42_000)
    expect(res.snapshot.memoryRefs).toEqual([{ id: "hit", version: 7 }])
    expect(res.snapshot.degraded).toBe(false)
    // The receipt binds the exact bytes the model was shown.
    expect(res.snapshot.contentHash).toMatch(/^[0-9a-z_]+$/)
    // An empty pass still issues a receipt — "nothing was injected" is a fact.
    const resEmpty = await applyMemoryContext({ userMessage: "zzz", ...base, deps: deps() })
    expect(resEmpty.snapshot.delivery).toBe("prepared")
    expect(resEmpty.snapshot.memoryRefs).toEqual([])
    expect(resEmpty.snapshot.id).toMatch(/^memctx:/)
  })

  it("marks the snapshot degraded when retrieval throws", async () => {
    const res = await applyMemoryContext({
      userMessage: "x",
      ...base,
      deps: deps({
        loadCandidates: async () => {
          throw new Error("db down")
        },
      }),
    })
    expect(res.degraded).toBe(true)
    expect(res.snapshot.degraded).toBe(true)
    expect(res.snapshot.delivery).toBe("prepared")
  })

  it("only recalls semantic/episodic (procedural goes to its own block)", async () => {
    const res = await applyMemoryContext({
      userMessage: "pnpm",
      ...base,
      deps: deps({
        loadCandidates: async () => [
          mem("pnpm semantic", { id: "s", type: "semantic" }),
          mem("pnpm procedural", { id: "p", type: "procedural" }),
        ],
        loadProcedural: async () => [mem("Always use pnpm", { id: "p", type: "procedural" })],
      }),
    })
    expect(res.retrievedMemories.map((m) => m.id)).not.toContain("p")
    expect(res.systemPromptSection).toContain("Working preferences you've learned")
    expect(res.proceduralCount).toBe(1)
  })

  it("appends the procedural block alongside recall", async () => {
    const res = await applyMemoryContext({
      userMessage: "pnpm",
      ...base,
      deps: deps({
        loadCandidates: async () => [mem("pnpm fact", { id: "s" })],
        loadProcedural: async () => [mem("Reply in Chinese", { type: "procedural" })],
      }),
    })
    expect(res.systemPromptSection).toContain("## What you remember about the user")
    expect(res.systemPromptSection).toContain("## Working preferences you've learned")
    expect(res.systemPromptSection).toContain("- Reply in Chinese")
  })

  it("withholds PII-bearing recalled and procedural rows from the provider prompt", async () => {
    const res = await applyMemoryContext({
      userMessage: "email",
      ...base,
      deps: deps({
        loadCandidates: async () => [mem("Email alice@example.com", { id: "unsafe" })],
        loadProcedural: async () => [
          mem("Email admin@example.com before release", {
            id: "unsafe-procedure",
            type: "procedural",
          }),
        ],
      }),
    })
    expect(res.systemPromptSection).toBeNull()
    expect(res.retrievedMemories).toEqual([])
    expect(res.withheldCount).toBe(2)
  })

  it("enforces one shared recall token budget and reports truncation", async () => {
    const res = await applyMemoryContext({
      userMessage: "memory",
      ...base,
      maxTokens: 24,
      deps: deps({
        loadCandidates: async () => [
          mem(`memory ${"first ".repeat(20)}`, { id: "first" }),
          mem(`memory ${"second ".repeat(20)}`, { id: "second" }),
        ],
      }),
    })
    expect(res.retrievedMemories.length).toBeLessThan(2)
    expect(res.budget).toMatchObject({ limit: 24, truncated: true })
    expect(res.withheldCount).toBeGreaterThan(0)
  })

  it("dedupes recalled memories that overlap a Twin chunk", async () => {
    const res = await applyMemoryContext({
      userMessage: "shanghai",
      ...base,
      twinChunkTexts: ["The user lives in Shanghai and works in tech"],
      deps: deps({
        loadCandidates: async () => [mem("lives in Shanghai", { id: "dup" })],
      }),
    })
    expect(res.retrievedMemories).toEqual([])
    expect(res.systemPromptSection).toBeNull()
  })

  it("skips retrieval when the message is blank but still emits procedural", async () => {
    const res = await applyMemoryContext({
      userMessage: "   ",
      ...base,
      deps: deps({
        loadCandidates: async () => [mem("should not be retrieved")],
        loadProcedural: async () => [mem("Reply in Chinese", { type: "procedural" })],
      }),
    })
    expect(res.retrievedMemories).toEqual([])
    expect(res.systemPromptSection).toContain("## Working preferences you've learned")
  })

  it("degrades (degraded=true, empty) when a dep throws", async () => {
    const res = await applyMemoryContext({
      userMessage: "pnpm",
      ...base,
      deps: deps({
        loadProcedural: async () => {
          throw new Error("db down")
        },
      }),
    })
    expect(res.degraded).toBe(true)
    expect(res.systemPromptSection).toBeNull()
  })
})

describe("personal/project corpus isolation", () => {
  it("never renders a mined project claim under the personal heading", async () => {
    // This is the highest-consequence silent failure in the whole feature. With
    // the corpus filter missing, the claim below still retrieves and still packs,
    // producing a first-person "what you remember about the user" line asserting
    // a fact about the user's repository that the user never said. Nothing else
    // in the suite catches it: no error, no type failure, no changed shape.
    const claim = mem("The repo pins Rust to 1.77.2", {
      id: "claim-1",
      projectId: "p1",
      projectMemoryKind: "constraint",
    })
    const personal = mem("The user works in UTC+8", { id: "personal-1" })

    const result = await applyMemoryContext({
      ...base,
      userMessage: "repo rust user timezone",
      reader: { projectId: "p1" },
      deps: deps({ loadCandidates: async () => [claim, personal] }),
    })

    expect(result.systemPromptSection).toContain("What you remember about the user")
    expect(result.systemPromptSection).toContain("The user works in UTC+8")
    expect(result.systemPromptSection).not.toContain("The repo pins Rust")
    expect(result.retrievedMemories.map((m) => m.id)).toEqual(["personal-1"])
  })

  it("still recalls a legacy row that carries a projectId but no kind", async () => {
    // Absent kind means personal. Rows written before mining existed must keep
    // being recalled exactly as they are today.
    const legacy = mem("The user works in UTC+8", { id: "legacy-1", projectId: "p1" })
    const result = await applyMemoryContext({
      ...base,
      userMessage: "user timezone",
      reader: { projectId: "p1" },
      deps: deps({ loadCandidates: async () => [legacy] }),
    })
    expect(result.retrievedMemories.map((m) => m.id)).toEqual(["legacy-1"])
  })
})

describe("independent recall sources and delivery governance", () => {
  it("preserves recall when procedural loading fails", async () => {
    const result = await applyMemoryContext({
      ...base,
      userMessage: "pnpm",
      deps: deps({
        loadCandidates: async () => [mem("pnpm preference")],
        loadProcedural: async () => {
          throw new Error("procedural unavailable")
        },
      }),
    })
    expect(result.systemPromptSection).toContain("pnpm preference")
    expect(result.degraded).toBe(true)
    expect(result.snapshot.degraded).toBe(true)
  })

  it("preserves verified procedures when recall fails", async () => {
    const result = await applyMemoryContext({
      ...base,
      userMessage: "pnpm",
      deps: deps({
        loadCandidates: async () => {
          throw new Error("recall unavailable")
        },
        loadProcedural: async () => [
          mem("Use pnpm", { type: "procedural", reviewStatus: "verified" }),
        ],
      }),
    })
    expect(result.systemPromptSection).toContain("Use pnpm")
    expect(result.degraded).toBe(true)
  })

  it("withholds unsafe procedural states at the injection boundary", async () => {
    const result = await applyMemoryContext({
      ...base,
      userMessage: "",
      now: 100,
      deps: deps({
        loadProcedural: async () => [
          mem("pending", { type: "procedural", reviewStatus: "pending_instruction" }),
          mem("legacy", { type: "procedural", reviewStatus: undefined }),
          mem("expired", { type: "procedural", reviewStatus: "verified", expiresAt: 100 }),
          mem("quarantined", {
            type: "procedural",
            reviewStatus: "verified",
            trustState: "quarantined",
          }),
          mem("verified", { type: "procedural", reviewStatus: "verified" }),
        ],
      }),
    })
    expect(result.systemPromptSection).toContain("- verified")
    expect(result.systemPromptSection).not.toMatch(/pending|legacy|expired|quarantined/)
    expect(result.proceduralCount).toBe(1)
    expect(result.withheldCount).toBe(4)
  })

  it("lets a verified broader instruction stand when its narrower override is unverified", async () => {
    const result = await applyMemoryContext({
      ...base,
      userMessage: "",
      now: 100,
      deps: deps({
        loadProcedural: async () => [
          mem("Use npm", {
            type: "procedural",
            scope: "workspace",
            projectId: "p1",
            key: "package-manager",
            reviewStatus: "pending_instruction",
          }),
          mem("Use pnpm", { type: "procedural", key: "package-manager" }),
        ],
      }),
    })
    expect(result.systemPromptSection).toContain("- Use pnpm")
    expect(result.systemPromptSection).not.toContain("Use npm")
    expect(result.proceduralCount).toBe(1)
  })

  it("still lets an eligible narrower instruction override the broader one", async () => {
    const result = await applyMemoryContext({
      ...base,
      userMessage: "",
      now: 100,
      deps: deps({
        loadProcedural: async () => [
          mem("Use pnpm", { type: "procedural", key: "package-manager" }),
          mem("Use bun", {
            type: "procedural",
            scope: "workspace",
            projectId: "p1",
            key: "Package-Manager ",
          }),
        ],
      }),
    })
    expect(result.systemPromptSection).toContain("- Use bun")
    expect(result.systemPromptSection).not.toContain("Use pnpm")
    expect(result.proceduralCount).toBe(1)
  })

  it("injects only the override layer of a key split across fact and instruction", async () => {
    const rule = mem("Use npm in this repo", {
      id: "workspace-rule",
      type: "procedural",
      scope: "workspace",
      projectId: "p1",
      key: "package-manager",
    })
    const fact = mem("The user prefers pnpm for package installs", {
      id: "global-fact",
      key: "package-manager",
    })
    const result = await applyMemoryContext({
      ...base,
      userMessage: "which package manager installs",
      reader: { projectId: "p1" },
      deps: deps({
        loadCandidates: async () => [fact, rule],
        loadProcedural: async () => [rule],
      }),
    })
    expect(result.systemPromptSection).toContain("Use npm in this repo")
    expect(result.systemPromptSection).not.toContain("pnpm")
    expect(result.snapshot.memoryRefs.map((ref) => ref.id)).toEqual(["workspace-rule"])
  })

  it("lets a narrower same-key fact override a broader instruction", async () => {
    const rule = mem("Always use pnpm", { id: "global-rule", type: "procedural", key: "pm" })
    const fact = mem("This repo installs packages with npm", {
      id: "workspace-fact",
      scope: "workspace",
      projectId: "p1",
      key: "pm",
    })
    const result = await applyMemoryContext({
      ...base,
      userMessage: "installs packages",
      reader: { projectId: "p1" },
      deps: deps({
        loadCandidates: async () => [rule, fact],
        loadProcedural: async () => [rule],
      }),
    })
    expect(result.systemPromptSection).toContain("npm")
    expect(result.systemPromptSection).not.toContain("Always use pnpm")
    expect(result.proceduralCount).toBe(0)
    expect(result.snapshot.memoryRefs.map((ref) => ref.id)).toEqual(["workspace-fact"])
  })

  it("counts multiline procedural rows once and records their delivered versions", async () => {
    const result = await applyMemoryContext({
      ...base,
      userMessage: "",
      deps: deps({
        loadProcedural: async () => [
          mem("Use pnpm\nRun tests", {
            id: "p",
            type: "procedural",
            reviewStatus: "verified",
            version: 3,
          }),
        ],
      }),
    })
    expect(result.proceduralCount).toBe(1)
    expect(result.withheldCount).toBe(0)
    expect(result.snapshot.memoryRefs).toEqual([{ id: "p", version: 3 }])
  })

  it.each([0, 1, 9, 18, 23, 24, 32, 64, 90])(
    "fits complete rendered sections within %i tokens",
    async (maxTokens) => {
      const result = await applyMemoryContext({
        ...base,
        userMessage: "pnpm",
        maxTokens,
        deps: deps({
          loadCandidates: async () => [mem("pnpm a"), mem("pnpm b"), mem("pnpm c")],
          loadProcedural: async () => [
            mem("Use pnpm", { type: "procedural", reviewStatus: "verified" }),
          ],
        }),
      })
      const actual = createContextManager().estimateTokens(result.systemPromptSection ?? "")
      expect(actual).toBeLessThanOrEqual(maxTokens)
      expect(result.budget.used).toBe(actual)
    }
  )
})

describe("recall framing", () => {
  it("re-exports the shared framing constants", () => {
    expect(RECALL_HEADING).toBe(framing.RECALL_HEADING)
    expect(MEMORY_RECALL_PREAMBLE).toBe(framing.MEMORY_RECALL_PREAMBLE)
    expect(PROCEDURAL_PRECEDENCE_NOTE).toBe(framing.PROCEDURAL_PRECEDENCE_NOTE)
  })

  it("places the data-only preamble right after the recall heading", async () => {
    const res = await applyMemoryContext({
      ...base,
      userMessage: "pnpm",
      deps: deps({ loadCandidates: async () => [mem("The user prefers pnpm")] }),
    })
    expect(res.systemPromptSection).toContain(
      `${RECALL_HEADING}\n${MEMORY_RECALL_PREAMBLE}\n- The user prefers pnpm`
    )
  })

  it("adds the precedence note under the procedural heading", async () => {
    const res = await applyMemoryContext({
      ...base,
      userMessage: "",
      deps: deps({
        loadProcedural: async () => [mem("Use pnpm", { type: "procedural" })],
      }),
    })
    expect(res.systemPromptSection).toContain(
      `## Working preferences you've learned\n${PROCEDURAL_PRECEDENCE_NOTE}\n- Use pnpm`
    )
    // No recall happened, so the recall preamble is absent.
    expect(res.systemPromptSection).not.toContain(MEMORY_RECALL_PREAMBLE)
  })
})

describe("recall preference pass-through", () => {
  const NOW = 1_700_000_000_000
  const corpus = () => [
    mem("we cache with redis", { id: "sem", type: "semantic", importance: 6 }),
    mem("we cache with memcached", { id: "epi", type: "episodic", importance: 5 }),
    mem("we cache with disk", { id: "low", type: "semantic", importance: 1 }),
  ]

  it("forwards sessionRecallRouting", async () => {
    const off = await applyMemoryContext({
      ...base,
      userMessage: "last time cache",
      now: NOW,
      deps: deps({ loadCandidates: async () => corpus() }),
    })
    expect(off.retrievedMemories.map((m) => m.id)).toEqual(["sem", "epi", "low"])
    const on = await applyMemoryContext({
      ...base,
      userMessage: "last time cache",
      now: NOW,
      sessionRecallRouting: true,
      deps: deps({ loadCandidates: async () => corpus() }),
    })
    expect(on.retrievedMemories.map((m) => m.id)).toEqual(["epi", "sem", "low"])
  })

  it("forwards beliefRankingWeight", async () => {
    const res = await applyMemoryContext({
      ...base,
      userMessage: "cache",
      now: NOW,
      beliefRankingWeight: 1,
      deps: deps({
        loadCandidates: async () =>
          corpus().map((m) =>
            m.id === "epi" ? { ...m, beliefInputs: { evidenceCount: 20, distinctSessions: 20 } } : m
          ),
      }),
    })
    expect(res.retrievedMemories.map((m) => m.id)).toEqual(["epi", "sem", "low"])
  })

  it("forwards rerank to the retriever's reranker", async () => {
    const rerank = jest.fn(
      async () =>
        new Map([
          ["sem", 0],
          ["epi", 0],
          ["low", 1],
        ])
    )
    const off = await applyMemoryContext({
      ...base,
      userMessage: "cache",
      now: NOW,
      deps: deps({ loadCandidates: async () => corpus(), rerank }),
    })
    expect(rerank).not.toHaveBeenCalled()
    expect(off.retrievedMemories[0].id).toBe("sem")

    const on = await applyMemoryContext({
      ...base,
      userMessage: "cache",
      now: NOW,
      rerank: true,
      deps: deps({ loadCandidates: async () => corpus(), rerank }),
    })
    expect(rerank).toHaveBeenCalledTimes(1)
    expect(on.retrievedMemories.map((m) => m.id)).toEqual(["low", "sem", "epi"])
  })
})
