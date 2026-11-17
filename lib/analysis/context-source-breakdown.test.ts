import type { UIMessage } from "ai"

import { buildContextSourceBreakdown } from "@/lib/analysis/context-source-breakdown"

function user(text: string): UIMessage {
  return { id: "u", role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage
}

function assistant(parts: Record<string, unknown>[]): UIMessage {
  return { id: "a", role: "assistant", parts } as unknown as UIMessage
}

describe("buildContextSourceBreakdown", () => {
  it("returns an empty breakdown for no messages", () => {
    expect(buildContextSourceBreakdown([])).toEqual({ rows: [], totalTokens: 0 })
  })

  it("buckets transcript content by source and hides empty categories", () => {
    const messages = [
      user("please look at @src/index.ts and fix it"),
      assistant([
        { type: "reasoning", text: "I will plan the change carefully here." },
        { type: "tool-Read", input: { file_path: "/a.ts" }, output: "file contents here" },
        { type: "tool-SendMessage", input: { to: "bob", text: "take this task" } },
      ]),
    ]
    const { rows, totalTokens } = buildContextSourceBreakdown(messages)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain("userMessages")
    expect(ids).toContain("mentionedFiles")
    expect(ids).toContain("thinking")
    expect(ids).toContain("toolOutputs")
    expect(ids).toContain("taskCoordination")
    // No system-prompt / claude-md row on the estimate path.
    expect(totalTokens).toBeGreaterThan(0)
  })

  it("separates coordination tools from real tool output", () => {
    const messages = [
      assistant([
        { type: "tool-TaskUpdate", input: { taskId: "t1", status: "done" } },
        { type: "tool-Bash", input: { command: "ls" }, output: "a b c" },
      ]),
    ]
    const { rows } = buildContextSourceBreakdown(messages)
    expect(rows.find((r) => r.id === "taskCoordination")?.tokens).toBeGreaterThan(0)
    expect(rows.find((r) => r.id === "toolOutputs")?.tokens).toBeGreaterThan(0)
  })

  it("attributes the assistant's own replies", () => {
    const { rows } = buildContextSourceBreakdown([
      assistant([{ type: "text", text: "x".repeat(400_000) }]),
    ])
    expect(rows).toEqual([{ id: "assistantMessages", tokens: 100_000 }])
  })

  it("sizes a structured tool output by its serialized form, static and dynamic tools alike", () => {
    const body = { rows: "y".repeat(400_000) }
    const big = buildContextSourceBreakdown([
      assistant([{ type: "tool-Read", input: { file_path: "/a" }, output: body }]),
    ])
    const empty = buildContextSourceBreakdown([
      assistant([{ type: "tool-Read", input: { file_path: "/a" }, output: {} }]),
    ])
    const big1 = big.rows.find((r) => r.id === "toolOutputs")!.tokens
    expect(big1).toBeGreaterThan(100_000)
    expect(empty.rows.find((r) => r.id === "toolOutputs")!.tokens).toBeLessThan(20)
    const dynamic = buildContextSourceBreakdown([
      assistant([
        { type: "dynamic-tool", toolName: "mcp__docs__fetch", input: { q: "a" }, output: body },
        { type: "dynamic-tool", toolName: "TaskCreate", input: { title: "t" } },
      ]),
    ])
    expect(dynamic.rows.find((r) => r.id === "toolOutputs")!.tokens).toBeGreaterThan(100_000)
    expect(dynamic.rows.find((r) => r.id === "taskCoordination")!.tokens).toBeGreaterThan(0)
  })

  it("prices a tool's media block as one image, not as its base64", () => {
    const screenshot = "A".repeat(400_000)
    const tokensOf = (output: unknown) =>
      buildContextSourceBreakdown([
        assistant([{ type: "tool-Screenshot", input: {}, output }]),
      ]).rows.find((r) => r.id === "toolOutputs")!.tokens
    // An MCP result and an AI SDK content output, each with one image.
    const mcp = tokensOf({ content: [{ type: "image", data: screenshot, mimeType: "image/png" }] })
    const sdk = tokensOf({
      type: "content",
      value: [{ type: "file", mediaType: "image/png", data: { type: "data", data: screenshot } }],
    })
    for (const tokens of [mcp, sdk]) {
      expect(tokens).toBeGreaterThanOrEqual(1_600)
      expect(tokens).toBeLessThan(1_700)
    }
    // Base64 in a plain JSON field is sent as text, and counts as text.
    expect(tokensOf({ png: screenshot })).toBeGreaterThan(100_000)
  })

  it("sorts rows by descending token weight", () => {
    const messages = [
      user("a".repeat(400)),
      assistant([{ type: "reasoning", text: "b".repeat(40) }]),
    ]
    const { rows } = buildContextSourceBreakdown(messages)
    expect(rows[0].id).toBe("userMessages")
    expect(rows[0].tokens).toBeGreaterThanOrEqual(rows[1].tokens)
  })
})
