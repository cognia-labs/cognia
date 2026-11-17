import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AUTO_COMPACT_FRACTION,
  estimateTokens,
  getContextWindow,
  shouldCompact,
  planCompaction,
  isSummaryMessage,
  summaryVersion,
  makeSummaryMessage,
  makeOpticalMessage,
  IMAGE_TOKENS,
  collectImages,
  selectRetainedImages,
  makeRetainedMediaMessage,
  TOOL_IMAGES_LEAD_TEXT,
  type ConversationMessage,
} from "./compaction.ts"
import { encodeRgbPng } from "./optical/png.ts"

test("token-tail selection retains short recent exchanges and keeps tool pairs whole", () => {
  const conversation: ConversationMessage[] = [
    { role: "user", content: "original task" },
    { role: "assistant", content: "old material ".repeat(1000) },
    ...Array.from({ length: 12 }, (_, i) => ({
      role: "assistant" as const,
      content: `recent ${i}`,
    })),
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "r", toolName: "read", input: {} }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "r", output: { type: "text", value: "last finding" } },
      ],
    },
  ]
  const plan = planCompaction({ conversation, keepRecentTokens: 100 })!
  assert.ok(plan.middle.length > 0)
  assert.ok(plan.tail.length > 6)
  assert.match(JSON.stringify(plan.tail), /recent 0/)
  assert.match(JSON.stringify(plan.tail), /tool-call/)
  assert.match(JSON.stringify(plan.tail), /last finding/)
})

test("AUTO_COMPACT_FRACTION mirrors the renderer constant", () => {
  assert.equal(AUTO_COMPACT_FRACTION, 0.835)
})

test("getContextWindow matches families, falls back to a safe default", () => {
  assert.equal(getContextWindow("claude-sonnet-4-6"), 1_000_000)
  assert.equal(getContextWindow("gpt-4o"), 128_000)
  assert.equal(getContextWindow("deepseek-chat"), 128_000)
  assert.equal(getContextWindow(undefined), 128_000)
  assert.equal(getContextWindow("some-unknown-local-model"), 128_000)
})

test("estimateTokens counts string and block content via the char heuristic", () => {
  const msgs = [
    { role: "system", content: "a".repeat(40) }, // 10 tokens
    { role: "user", content: [{ type: "text", text: "b".repeat(40) }] }, // 10 tokens
  ]
  assert.equal(estimateTokens(msgs), 20)
})

test("estimateTokens counts tool-call arguments and every typed tool output", () => {
  const args = "w".repeat(400_000)
  const call = {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "write",
        input: { path: "a", content: args },
      },
    ],
  }
  // The argument body dominates: 400k chars ≈ 100k tokens, not the 0 it was.
  assert.ok(estimateTokens([call]) >= 100_000)

  const result = (output: unknown) => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "c1", toolName: "t", output }],
  })
  assert.equal(estimateTokens([result({ type: "text", value: "x".repeat(400) })]), 100)
  assert.equal(estimateTokens([result({ type: "error-text", value: "x".repeat(400) })]), 100)
  assert.ok(estimateTokens([result({ type: "json", value: { body: "x".repeat(400) } })]) >= 100)
  assert.equal(estimateTokens([result({ type: "execution-denied", reason: "x".repeat(40) })]), 10)
  assert.equal(
    estimateTokens([result({ type: "content", value: [{ type: "text", text: "x".repeat(400) }] })]),
    100
  )
})

test("estimateTokens prices an image as one image, not as its base64 text", () => {
  const base64 = "A".repeat(1_000_000)
  const user = {
    role: "user",
    content: [{ type: "file", mediaType: "image/png", data: `data:image/png;base64,${base64}` }],
  }
  assert.equal(estimateTokens([user]), IMAGE_TOKENS)
  const legacyImage = { role: "user", content: [{ type: "image", image: base64 }] }
  assert.equal(estimateTokens([legacyImage]), IMAGE_TOKENS)
  const toolImage = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c",
        toolName: "",
        output: {
          type: "content",
          value: [{ type: "file", mediaType: "image/png", data: { type: "data", data: base64 } }],
        },
      },
    ],
  }
  assert.equal(estimateTokens([toolImage]), IMAGE_TOKENS)
  // An image whose header states its size costs w·h/750 (the cap is for unknown sizes).
  const png = encodeRgbPng(new Uint8Array(300 * 200 * 3), 300, 200).toString("base64")
  assert.equal(
    estimateTokens([
      { role: "user", content: [{ type: "file", mediaType: "image/png", data: png }] },
    ]),
    80
  )
  // Another file counts by page-equivalent bytes: 750 KB at 32 bytes a token.
  const pdf = {
    role: "user",
    content: [{ type: "file", mediaType: "application/pdf", data: base64 }],
  }
  assert.equal(estimateTokens([pdf]), 23_438)
  // A one-page document is still at least one image.
  assert.equal(
    estimateTokens([
      { role: "user", content: [{ type: "file", mediaType: "application/pdf", data: "JVBE" }] },
    ]),
    IMAGE_TOKENS
  )
})

test("estimateTokens prices native video and audio by duration, not as text", () => {
  // The composer's native-video path: a document block becomes a user `file`
  // part. 6 MB of mp4 is about a minute; Gemini bills ≈263 tokens a second.
  const video = {
    role: "user",
    content: [
      { type: "text", text: "clip" },
      { type: "file", mediaType: "video/mp4", data: "A".repeat(8_000_000) },
    ],
  }
  const tokens = estimateTokens([video])
  assert.equal(tokens, 1 + 12_000)
  // Far below a 1M window: the pre-send check let the turn through.
  assert.ok(tokens < 1_000_000 * 0.05)
  const audio = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "a",
        toolName: "speak",
        output: {
          type: "content",
          value: [
            {
              type: "file",
              mediaType: "audio/mpeg",
              data: { type: "data", data: "A".repeat(4000) },
            },
          ],
        },
      },
    ],
  }
  // 3,000 decoded bytes at 500 a token, plus the tool name's characters.
  assert.equal(estimateTokens([audio]), Math.round("speak".length / 4) + 6)
})

test("collectImages finds user, re-projected and tool-result images, skipping optical frames", () => {
  const optical = makeOpticalMessage(
    [{ type: "image", image: "data:image/png;base64,FRAME", mediaType: "image/png" }],
    { messageCount: 2, frameCount: 1 },
    1
  )
  const messages = [
    optical,
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "file",
          mediaType: "image/png",
          data: "data:image/png;base64,U1",
          filename: "a.png",
        },
        { type: "file", mediaType: "application/pdf", data: "PDF" },
      ],
    },
    { role: "user", content: [{ type: "image", image: "data:image/jpeg;base64,P1" }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c",
          toolName: "read",
          output: {
            type: "content",
            value: [
              { type: "text", text: "png" },
              { type: "file", mediaType: "image/png", data: { type: "data", data: "T1" } },
            ],
          },
        },
      ],
    },
    // A non-Anthropic rail re-shows tool images in a user message: still a tool's.
    {
      role: "user",
      content: [
        { type: "text", text: TOOL_IMAGES_LEAD_TEXT },
        { type: "file", mediaType: "image/png", data: { type: "data", data: "R1" } },
      ],
    },
  ]
  const images = collectImages(messages)
  assert.deepEqual(
    images.map((image) => [image.origin, image.part.data]),
    [
      ["image from a user message (a.png)", "data:image/png;base64,U1"],
      ["image from a user message", "data:image/jpeg;base64,P1"],
      ["image returned by read", { type: "data", data: "T1" }],
      ["image returned by a tool call", { type: "data", data: "R1" }],
    ]
  )
})

test("a retained-media message is frozen and gives its images back on regeneration", () => {
  const images = collectImages([
    { role: "user", content: [{ type: "file", mediaType: "image/png", data: "A" }] },
    { role: "user", content: [{ type: "file", mediaType: "image/png", data: "B" }] },
    { role: "user", content: [{ type: "file", mediaType: "image/png", data: "C" }] },
  ])
  const kept = selectRetainedImages(images, { maxImages: 2, maxTokens: Infinity })
  assert.deepEqual(
    kept.map((image) => image.part.data),
    ["B", "C"],
    "the newest images survive"
  )
  assert.deepEqual(selectRetainedImages(images, { maxImages: 4, maxTokens: IMAGE_TOKENS + 10 }), [
    images[2],
  ])
  assert.deepEqual(selectRetainedImages(images, { maxImages: 4, maxTokens: 10 }), [])

  const message = makeRetainedMediaMessage(kept, 3, 1)
  assert.ok(isSummaryMessage(message))
  assert.equal(summaryVersion(message), 3)
  assert.match(
    String((message.content as { text: string }[])[0]!.text),
    /1 older image was not kept/
  )
  assert.deepEqual(
    collectImages([message]).map((image) => [image.origin, image.part.data]),
    [
      ["image from a user message", "B"],
      ["image from a user message", "C"],
    ]
  )
  // It is protected like any frozen summary.
  const plan = planCompaction({
    conversation: [
      { role: "system", content: "sys" },
      makeSummaryMessage("S", 2),
      message,
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
      { role: "user", content: "u2" },
    ],
    keepRecentMessages: 1,
  })
  assert.ok(plan)
  assert.equal(plan.frozen.length, 2)
})

test("shouldCompact fires only at/above the threshold", () => {
  // 128k window → threshold ≈ 106_880 tokens.
  assert.equal(shouldCompact({ lastInputTokens: 50_000, modelId: "gpt-4o" }), false)
  assert.equal(shouldCompact({ lastInputTokens: 110_000, modelId: "gpt-4o" }), true)
  // No signal yet (0 / null) never compacts.
  assert.equal(shouldCompact({ lastInputTokens: 0, modelId: "gpt-4o" }), false)
  assert.equal(shouldCompact({ lastInputTokens: null, modelId: "gpt-4o" }), false)
})

test("shouldCompact prefers an authoritative contextWindow over the regex table", () => {
  // deepseek-v4 is really 1M, but the regex table floors `deepseek*` at 128k.
  // Without the override it would compact at ~107k; with the real 1M window the
  // same prompt is only ~11% full and must NOT trigger.
  assert.equal(
    shouldCompact({ lastInputTokens: 110_000, modelId: "deepseek-v4-pro" }),
    true,
    "regex-table fallback floors deepseek at 128k → fires early"
  )
  assert.equal(
    shouldCompact({
      lastInputTokens: 110_000,
      modelId: "deepseek-v4-pro",
      contextWindow: 1_000_000,
    }),
    false,
    "authoritative 1M window → 110k is far below threshold"
  )
  // It still fires once the prompt crosses the 1M threshold (≈835k).
  assert.equal(
    shouldCompact({
      lastInputTokens: 900_000,
      modelId: "deepseek-v4-pro",
      contextWindow: 1_000_000,
    }),
    true
  )
  // A non-positive / non-numeric override is ignored (falls back to the table).
  assert.equal(
    shouldCompact({ lastInputTokens: 110_000, modelId: "gpt-4o", contextWindow: 0 }),
    true
  )
})

test("shouldCompact honours a custom fraction (settings override)", () => {
  // 128k window, fraction 0.5 → threshold 64_000.
  assert.equal(shouldCompact({ lastInputTokens: 50_000, modelId: "gpt-4o", fraction: 0.5 }), false)
  assert.equal(shouldCompact({ lastInputTokens: 70_000, modelId: "gpt-4o", fraction: 0.5 }), true)
})

test("shouldCompact supports the message-count trigger", () => {
  assert.equal(
    shouldCompact({ trigger: "message-count", messageCount: 30, messageCountThreshold: 50 }),
    false
  )
  assert.equal(
    shouldCompact({ trigger: "message-count", messageCount: 50, messageCountThreshold: 50 }),
    true
  )
  // Token signal is ignored under the message-count trigger.
  assert.equal(
    shouldCompact({
      trigger: "message-count",
      lastInputTokens: 9_000_000,
      messageCount: 1,
      messageCountThreshold: 50,
    }),
    false
  )
})

test("shouldCompact never auto-fires under the manual trigger", () => {
  assert.equal(
    shouldCompact({ trigger: "manual", lastInputTokens: 9_000_000, modelId: "gpt-4o" }),
    false
  )
})

test("frozen-summary markers round-trip", () => {
  const msg = makeSummaryMessage("KEY FACTS", 3)
  assert.equal(msg.role, "user")
  assert.ok(isSummaryMessage(msg))
  assert.equal(summaryVersion(msg), 3)
  assert.match(String(msg.content), /KEY FACTS/)
  // Non-summary messages
  assert.equal(isSummaryMessage({ role: "user", content: "hello" }), false)
  assert.equal(
    isSummaryMessage({ role: "assistant", content: '<conversation-summary v="1">x' }),
    false
  )
  assert.equal(summaryVersion({ role: "user", content: "plain" }), 0)
  // version defaults to 1 when not positive
  assert.equal(summaryVersion(makeSummaryMessage("x", 0)), 1)
})

test("planCompaction protects leading system + frozen summaries from re-summarization", () => {
  const conversation = [
    { role: "system", content: "sys" },
    makeSummaryMessage("PRIOR SUMMARY", 1),
    { role: "user", content: "u-new-1" },
    { role: "assistant", content: "a-new-1" },
    { role: "user", content: "u-recent" },
    { role: "assistant", content: "a-recent" },
  ]
  const plan = planCompaction({ conversation, keepRecentMessages: 2 })
  assert.ok(plan)
  assert.deepEqual(
    plan.systemHead.map((m) => m.content),
    ["sys"]
  )
  assert.equal(plan.frozen.length, 1)
  assert.ok(isSummaryMessage(plan.frozen[0]))
  // The prior summary is NOT in middle (this is the anti-recursion guarantee).
  assert.deepEqual(
    plan.middle.map((m) => m.content),
    ["u-new-1", "a-new-1"]
  )
  assert.deepEqual(
    plan.tail.map((m) => m.content),
    ["u-recent", "a-recent"]
  )
})

test("optical archives are recognized and protected as frozen artifacts", () => {
  const imageParts = [
    { type: "image" as const, image: "data:image/png;base64,AAAA", mediaType: "image/png" },
  ]
  const archive = makeOpticalMessage(imageParts, { messageCount: 4, frameCount: 1 }, 2)
  assert.ok(isSummaryMessage(archive), "array-content optical archive is a frozen artifact")
  assert.equal(summaryVersion(archive), 2)

  // A prior optical archive right after the system head is carried forward in
  // `frozen`, never fed back into `middle` (where its image would yield no text).
  const conversation = [
    { role: "system", content: "sys" },
    archive,
    { role: "user", content: "u-new" },
    { role: "assistant", content: "a-new" },
    { role: "user", content: "u-recent" },
    { role: "assistant", content: "a-recent" },
  ]
  const plan = planCompaction({ conversation, keepRecentMessages: 2 })
  assert.ok(plan)
  assert.equal(plan.frozen.length, 1)
  assert.equal(plan.frozen[0], archive)
  assert.deepEqual(
    plan.middle.map((m) => m.content),
    ["u-new", "a-new"]
  )
})

const convo = () => [
  { role: "system", content: "sys" },
  { role: "user", content: "u1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "u2" },
  { role: "assistant", content: "a2" },
  { role: "user", content: "u3" },
  { role: "assistant", content: "a3" },
]

test("planCompaction splits system head / middle / tail keeping system + recent turns", () => {
  const plan = planCompaction({ conversation: convo(), keepRecentMessages: 2 })
  assert.ok(plan)
  assert.deepEqual(
    plan.systemHead.map((m) => m.content),
    ["sys"]
  )
  // middle = everything between system and the last 2 messages
  assert.deepEqual(
    plan.middle.map((m) => m.content),
    ["u1", "a1", "u2", "a2"]
  )
  assert.deepEqual(
    plan.tail.map((m) => m.content),
    ["u3", "a3"]
  )
})

test("planCompaction returns null when there is nothing old enough to summarize", () => {
  const short = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
  ]
  assert.equal(planCompaction({ conversation: short, keepRecentMessages: 2 }), null)
})

test("planCompaction never starts the verbatim tail inside a tool call/result pair", () => {
  // The LR-P03 shape: the count-based cut (keep 6) lands on a tool result whose
  // call would be summarized, leaving an orphan the resume check rejects.
  const call = (id: string) => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "working_set", input: {} }],
  })
  const result = (id: string) => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "working_set",
        output: { type: "json", value: {} },
      },
    ],
  })
  const conversation = [
    { role: "user", content: "start" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "get the working set" },
    call("ws-1"),
    result("ws-1"),
    { role: "assistant", content: "it has 3 entries" },
    { role: "user", content: "codename?" },
    { role: "assistant", content: "COPPER-HERON-8046" },
    { role: "user", content: "thanks" },
  ]
  const plan = planCompaction({ conversation, keepRecentMessages: 5 })
  assert.ok(plan)
  assert.equal(plan.tail[0], conversation[3], "the tail starts at the call, keeping its result")
  assert.equal(plan.tail.length, 6)
  assert.equal(plan.middle.length, 3)
})

test("planCompaction reports nothing to compact when the pair reaches the start", () => {
  const conversation = [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "x", toolName: "bash", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "x",
          toolName: "bash",
          output: { type: "text", value: "" },
        },
      ],
    },
    { role: "user", content: "next" },
  ]
  assert.equal(planCompaction({ conversation, keepRecentMessages: 2 }), null)
})
