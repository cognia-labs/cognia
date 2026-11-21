import type { LlmClient } from "@/lib/twin/distill/llm"
import { SELECTION_SUMMARY_PROMPT, packSegments, summarizeMaterial } from "./summarize-material"
import { CONVERSATION_SUMMARY_PROMPT } from "./summarizer"
import {
  __overridePromptsForTests,
  __setPromptOverrideSnapshotForTests,
} from "@/lib/prompts/snapshot"
import { validatePromptBody } from "@/lib/prompts/template"
import type { PromptDefinitionV1 } from "@/lib/prompts/types"

jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: () => true }))

function client(replies: string[] | ((prompt: string) => string)): LlmClient & {
  complete: jest.Mock
} {
  let call = 0
  return {
    complete: jest.fn(async (prompt: string) =>
      typeof replies === "function" ? replies(prompt) : (replies[call++] ?? "")
    ),
  }
}

describe("packSegments", () => {
  it("packs whole segments until the next one would overflow", () => {
    expect(packSegments(["aaaa", "bbbb", "cccc"], 10)).toEqual(["aaaa\n\nbbbb", "cccc"])
  })

  it("splits only a segment that is larger than a chunk by itself", () => {
    const big = `${"x".repeat(8)}\n\n${"y".repeat(8)}`
    expect(packSegments([big], 10)).toEqual(["xxxxxxxx", "yyyyyyyy"])
  })

  it("skips blank segments and returns nothing for no material", () => {
    expect(packSegments(["  ", ""], 10)).toEqual([])
  })
})

describe("summarizeMaterial", () => {
  it("summarizes handoff evidence and constraints without inheriting permissions", async () => {
    const llm = client(["Task summary"])
    await summarizeMaterial({
      segments: ["USER [goal]: Analyze only", "TOOL [evidence]: tests failed"],
      purpose: "handoff",
      client: llm,
    })
    const [prompt, options] = llm.complete.mock.calls[0]
    expect(prompt).toContain("USER [goal]: Analyze only")
    expect(prompt).toContain("TOOL [evidence]: tests failed")
    expect(options.system).toContain("all user constraints")
    expect(options.system).toContain("evidence and message IDs")
    expect(options.system).toContain("Historical permissions are not authorization")
  })
  it("summarizes material that fits in one pass with the purpose's prompt", async () => {
    const llm = client(["the gist"])
    const out = await summarizeMaterial({ segments: ["a", "b"], purpose: "selection", client: llm })
    expect(out).toEqual({ kind: "summary", text: "the gist", chunks: 1 })
    expect(llm.complete.mock.calls[0][1].system).toBe(SELECTION_SUMMARY_PROMPT.defaultBody)

    await summarizeMaterial({ segments: ["a"], purpose: "branch-seed", client: llm })
    expect(llm.complete.mock.calls[1][1].system).toBe(CONVERSATION_SUMMARY_PROMPT.defaultBody)
  })

  // The old summarizer sliced at 24k and dropped the rest without a word.
  it("summarizes every chunk and combines them instead of dropping the tail", async () => {
    const llm = client((prompt) =>
      prompt.includes("Combine these partial summaries") ? "whole" : `part of ${prompt.slice(-4)}`
    )
    const progress: string[] = []
    const out = await summarizeMaterial({
      segments: ["seg1", "seg2", "seg3"],
      purpose: "selection",
      client: llm,
      chunkChars: 5,
      onProgress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`),
    })
    expect(out).toEqual({ kind: "summary", text: "whole", chunks: 3 })
    expect(llm.complete).toHaveBeenCalledTimes(4)
    const combinePrompt = llm.complete.mock.calls[3][0] as string
    expect(combinePrompt).toContain("Part 1:")
    expect(combinePrompt).toContain("Part 3:")
    expect(progress).toEqual([
      "summarizing:0/4",
      "summarizing:1/4",
      "summarizing:2/4",
      "combining:3/4",
      "combining:4/4",
    ])
  })

  it("sends nothing when any chunk fails the PII gate", async () => {
    const llm = client(["never"])
    const out = await summarizeMaterial({
      segments: ["fine", "SECRET"],
      purpose: "selection",
      client: llm,
      chunkChars: 8,
      isPiiSafe: (text) => !text.includes("SECRET"),
    })
    expect(out).toEqual({ kind: "unavailable", reason: "pii" })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it("reports why it could not summarize instead of inventing a digest", async () => {
    expect(
      await summarizeMaterial({ segments: ["  "], purpose: "selection", client: null })
    ).toEqual({
      kind: "unavailable",
      reason: "empty",
    })
    expect(
      await summarizeMaterial({ segments: ["a"], purpose: "selection", client: null })
    ).toEqual({
      kind: "unavailable",
      reason: "no-client",
    })
    expect(
      await summarizeMaterial({ segments: ["a"], purpose: "selection", client: client(["  "]) })
    ).toEqual({ kind: "unavailable", reason: "no-output" })
  })

  it("streams the final pass when the client can", async () => {
    const llm: LlmClient = {
      complete: jest.fn(),
      async *stream() {
        yield "one "
        yield "two"
      },
    }
    const partials: string[] = []
    const out = await summarizeMaterial({
      segments: ["a"],
      purpose: "selection",
      client: llm,
      onPartial: (text) => partials.push(text),
    })
    expect(out).toEqual({ kind: "summary", text: "one two", chunks: 1 })
    expect(partials).toEqual(["one ", "one two"])
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it("stops between chunks once aborted and surfaces the abort", async () => {
    const controller = new AbortController()
    const llm = client(() => {
      controller.abort()
      return "partial"
    })
    await expect(
      summarizeMaterial({
        segments: ["seg1", "seg2"],
        purpose: "selection",
        client: llm,
        chunkChars: 5,
        signal: controller.signal,
      })
    ).rejects.toBeTruthy()
    expect(llm.complete).toHaveBeenCalledTimes(1)
  })

  it("surfaces a provider error to the caller", async () => {
    const llm: LlmClient = { complete: jest.fn().mockRejectedValue(new Error("quota")) }
    await expect(
      summarizeMaterial({ segments: ["a"], purpose: "selection", client: llm })
    ).rejects.toThrow("quota")
  })
})

/** A body that meets `def`'s contract and cannot be mistaken for the shipped text. */
function sentinelBody(def: PromptDefinitionV1): string {
  const placeholders = def.variables.filter((v) => v.required).map((v) => `{{${v.name}}}`)
  return [`SENTINEL-${def.id}`, ...placeholders, ...def.requiredFragments].join(" ")
}

/** The longest placeholder-free run of the shipped body: seeing it means the default was sent. */
function shippedMarker(def: PromptDefinitionV1): string {
  const runs = def.defaultBody.split(/\{\{[^}]*\}\}/).map((run) => run.trim())
  return runs.reduce((a, b) => (b.length > a.length ? b : a), "").slice(0, 60)
}

describe("a published summary prompt reaches the model (ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  // Every purpose, so each prompt the summarizer can pick is covered.
  it.each([
    ["branch-seed", CONVERSATION_SUMMARY_PROMPT.id, CONVERSATION_SUMMARY_PROMPT],
    ["selection", SELECTION_SUMMARY_PROMPT.id, SELECTION_SUMMARY_PROMPT],
    ["handoff", SELECTION_SUMMARY_PROMPT.id, SELECTION_SUMMARY_PROMPT],
  ] as const)("the %s purpose sends the %s override on every pass", async (purpose, _id, def) => {
    const body = sentinelBody(def)
    expect(validatePromptBody(def, body)).toEqual([])
    __overridePromptsForTests([[def, body]])
    const llm = client((prompt) =>
      prompt.includes("Combine these partial summaries") ? "whole" : "part"
    )

    // Two chunks plus the combining pass: three calls, one system prompt.
    const out = await summarizeMaterial({
      segments: ["seg1", "seg2"],
      purpose,
      client: llm,
      chunkChars: 5,
    })

    expect(out).toEqual({ kind: "summary", text: "whole", chunks: 2 })
    expect(llm.complete).toHaveBeenCalledTimes(3)
    for (const [, options] of llm.complete.mock.calls) {
      expect(options.system).toContain(`SENTINEL-${def.id}`)
      expect(options.system).not.toContain(shippedMarker(def))
    }
  })
})
