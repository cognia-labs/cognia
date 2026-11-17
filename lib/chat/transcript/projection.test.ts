import type { StoredMessage } from "@cognia/agent-config-types"
import {
  TRANSCRIPT_ACTIVITY_BYTE_LIMIT,
  TRANSCRIPT_ACTIVITY_TOOL_LIMIT,
  TRANSCRIPT_ACTIVITY_TOOL_NAME_MAX,
  TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT,
  TRANSCRIPT_DETAIL_PAGE_DEFAULT,
  TRANSCRIPT_DETAIL_PAGE_MAX,
  TRANSCRIPT_SUMMARY_BYTE_LIMIT,
  TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
  TRANSCRIPT_TIMELINE_PAGE_DEFAULT,
  TRANSCRIPT_TIMELINE_PAGE_MAX,
} from "@cognia/agent-config-types"

import { composeTurnText } from "@/lib/chat/prompt-preamble"
import {
  encodeTimelineCursor,
  encodeTurnDetailCursor,
  projectTranscriptTimeline,
  transcriptTurnVersion,
  validateTimelineCursor,
  validateTurnDetailCursor,
} from "./projection"

function message(
  id: string,
  role: StoredMessage["role"],
  parts: StoredMessage["parts"],
  options: {
    turnKey?: string
    createdAt?: number
    metadata?: StoredMessage["metadata"]
  } = {}
): StoredMessage {
  return {
    id,
    sessionId: "session-1",
    role,
    parts,
    createdAt: options.createdAt ?? (Number(id.replace(/\D/g, "")) || 1),
    turnKey: options.turnKey,
    metadata: options.metadata,
  }
}

function text(value: string): StoredMessage["parts"][number] {
  return { type: "text", text: value, state: "done" } as StoredMessage["parts"][number]
}

describe("transcript projection", () => {
  it.each(["tool-Read", "dynamic-tool"] as const)(
    "keeps a two-message turn with a %s result expandable without adding the result to the preview",
    (type) => {
      const [turn] = projectTranscriptTimeline({
        sessionId: "session-1",
        revision: 1,
        messages: [
          message("u1", "user", [text("Read the file")]),
          message("a2", "assistant", [
            {
              type,
              toolName: "Read",
              toolCallId: "read-1",
              state: "output-available",
              input: { file_path: "result.txt" },
              output: "Contents of result.txt",
            },
            text("I read the file."),
          ]),
        ],
      })

      expect(turn).toMatchObject({
        kind: "completed-turn",
        finalResponse: { text: "I read the file." },
        collapsed: { exists: true, messageCount: 2 },
      })
      expect(JSON.stringify(turn)).not.toContain("Contents of result.txt")
    }
  )

  it("keeps the detail button unavailable when a short turn has only text and a step marker", () => {
    const [turn] = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 1,
      messages: [
        message("u1", "user", [text("Hello")]),
        message("a2", "assistant", [{ type: "step-start" }, text("Hi")]),
      ],
    })

    expect(turn).toMatchObject({ kind: "completed-turn", collapsed: { exists: false } })
  })

  it("keeps clipped previews expandable and preserves Unicode boundaries", () => {
    const content = "a".repeat(24 * 1024 - 3) + "😀tail"
    const messages = [
      message("u1", "user", [text("question")]),
      message("a2", "assistant", [text(content)]),
    ]
    const [turn] = projectTranscriptTimeline({ sessionId: "session-1", revision: 1, messages })
    expect(turn.kind).toBe("completed-turn")
    if (turn.kind !== "completed-turn") throw new Error("Expected completed turn")
    expect(turn.finalResponse?.text).toBe("a".repeat(24 * 1024 - 3))
    expect(turn.finalResponse?.truncated).toBe(true)
    expect(turn.collapsed.exists).toBe(true)
    expect(messages[1].parts).toEqual([text(content)])
  })
  it("publishes the negotiated paging and preview budgets", () => {
    expect({
      timelineDefault: TRANSCRIPT_TIMELINE_PAGE_DEFAULT,
      timelineMax: TRANSCRIPT_TIMELINE_PAGE_MAX,
      detailDefault: TRANSCRIPT_DETAIL_PAGE_DEFAULT,
      detailMax: TRANSCRIPT_DETAIL_PAGE_MAX,
      detailBytes: TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT,
      summaryBytes: TRANSCRIPT_SUMMARY_BYTE_LIMIT,
      summaryMedia: TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
    }).toEqual({
      timelineDefault: 30,
      timelineMax: 100,
      detailDefault: 100,
      detailMax: 200,
      detailBytes: 2 * 1024 * 1024,
      summaryBytes: 64 * 1024,
      summaryMedia: 12,
    })
  })

  it("groups a user message and following assistant/system output into stable turns", () => {
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 7,
      messages: [
        message("s0", "system", [text("connected")], { createdAt: 1 }),
        message("u1", "user", [text("first question")], { createdAt: 2 }),
        message("a1", "assistant", [text("working")], { createdAt: 3 }),
        message("s1", "system", [text("approval recorded")], { createdAt: 4 }),
        message("u2", "user", [text("second question")], { createdAt: 5 }),
        message("a2", "assistant", [text("final answer")], { createdAt: 6 }),
      ],
    })

    expect(items.map((item) => [item.kind, item.itemKey])).toEqual([
      ["system", "system:s0"],
      ["completed-turn", "turn:u1"],
      ["completed-turn", "turn:u2"],
    ])
    expect(items[1]).toMatchObject({
      kind: "completed-turn",
      turnKey: "turn:u1",
      revision: 7,
      userMessages: [{ id: "u1", text: "first question" }],
      finalResponse: { id: "a1", text: "working" },
      collapsed: { messageCount: 3, trailingCount: 1 },
    })
  })

  it("stamps which agent answered on assistant previews only (ADR-0218)", () => {
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 1,
      messages: [
        message("u1", "user", [text("q1")], { createdAt: 1 }),
        message("a1", "assistant", [text("a1")], {
          createdAt: 2,
          metadata: { run: { agent: { presetId: "build" } } },
        }),
        message("u2", "user", [text("q2")], { createdAt: 3 }),
        message("a2", "assistant", [text("a2")], {
          createdAt: 4,
          metadata: { run: { route: { handle: "codex", label: "Codex" } } },
        }),
        message("u3", "user", [text("q3")], { createdAt: 5 }),
        message("a3", "assistant", [text("a3")], { createdAt: 6 }),
      ],
    })
    const turns = items.filter((item) => item.kind === "completed-turn")
    expect(turns.map((turn) => turn.finalResponse?.agentKey)).toEqual([
      "preset:build",
      "route:codex",
      undefined,
    ])
    expect(turns[0]?.userMessages[0]).not.toHaveProperty("agentKey")
    // Unstamped turns omit the field rather than carrying `undefined`.
    expect(turns[2]?.finalResponse).not.toHaveProperty("agentKey")
  })

  it("previews a user message by its typed text, not the context envelope", () => {
    // A companion renders this preview as the user's question. The envelope
    // would also eat the summary byte budget before the typed words appear.
    const envelope = composeTurnText(
      "typed words",
      [{ kind: "references", text: "SECRET SNAPSHOT" }],
      { nonce: "abcdef0123" }
    )
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 3,
      messages: [
        message("u1", "user", [text(envelope.text)], { createdAt: 1 }),
        message("a1", "assistant", [text("answer")], { createdAt: 2 }),
      ],
    })
    const turn = items[0]
    if (turn.kind !== "completed-turn") throw new Error("expected a completed turn")

    expect(turn.userMessages[0].text).toBe("typed words")
    const serialized = JSON.stringify(turn)
    expect(serialized).not.toContain("SECRET SNAPSHOT")
    expect(serialized).not.toContain("cognia_context_")
  })

  it("respects persisted turn keys, exposes active turns in full, and projects assistant-only rows", () => {
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 9,
      activeTurnKey: "provider-turn",
      messages: [
        message("a0", "assistant", [text("orphan answer")], { createdAt: 1 }),
        message("u1", "user", [text("one")], { turnKey: "provider-turn", createdAt: 2 }),
        message("u2", "user", [text("two")], { turnKey: "provider-turn", createdAt: 3 }),
        message("a1", "assistant", [text("streaming")], {
          turnKey: "provider-turn",
          createdAt: 4,
        }),
      ],
    })

    expect(items[0]).toMatchObject({
      kind: "completed-turn",
      turnKey: "turn:a0",
      userMessages: [],
      finalResponse: { id: "a0", text: "orphan answer" },
    })
    expect(items[1]).toMatchObject({
      kind: "active-turn",
      turnKey: "provider-turn",
      messages: [{ id: "u1" }, { id: "u2" }, { id: "a1" }],
    })
  })

  it("keeps the author and sender of an active turn's messages", () => {
    const author = { kind: "human" as const, id: "person-b", displayName: "Bea" }
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 1,
      activeTurnKey: "t",
      messages: [
        {
          ...message("u1", "user", [text("q")], { turnKey: "t" }),
          collaboration: { author, sourceEventId: "e1", eventSequence: 1, version: 1 },
        },
        {
          ...message("a1", "assistant", [text("a")], { turnKey: "t" }),
          senderId: "char-1",
          senderKind: "assistant",
        },
      ],
    })
    expect(items[0]).toMatchObject({
      kind: "active-turn",
      messages: [
        { id: "u1", collaboration: { author } },
        { id: "a1", senderId: "char-1", senderKind: "assistant" },
      ],
    })
  })

  it("caps summary bytes and media references while retaining detail counts", () => {
    const imageParts = Array.from({ length: 20 }, (_, index) => ({
      type: "file",
      mediaType: "image/png",
      filename: `${index}.png`,
      url: `cognia-media:hash-${index}`,
    })) as StoredMessage["parts"]
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 1,
      messages: [
        message("u1", "user", [text("x".repeat(100_000))], { createdAt: 1 }),
        message("a1", "assistant", [text("界".repeat(100_000)), ...imageParts], {
          createdAt: 2,
        }),
      ],
    })
    const turn = items[0]
    expect(turn.kind).toBe("completed-turn")
    if (turn.kind !== "completed-turn") throw new Error("expected a completed turn")

    expect(new TextEncoder().encode(JSON.stringify(turn)).byteLength).toBeLessThanOrEqual(
      TRANSCRIPT_SUMMARY_BYTE_LIMIT
    )
    expect(turn.userMessages[0].truncated).toBe(true)
    expect(turn.finalResponse?.truncated).toBe(true)
    expect(turn.finalResponse?.media).toHaveLength(TRANSCRIPT_SUMMARY_MEDIA_LIMIT)
    expect(turn.collapsed.mediaCount).toBe(20)
  })

  it("summarizes branch groups using explicit selection or the highest branch index", () => {
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 2,
      activeBranchByGroup: { answer: "a0" },
      messages: [
        message("u1", "user", [text("question")], { createdAt: 1 }),
        message("a0", "assistant", [text("old")], {
          createdAt: 2,
          metadata: { branchGroupId: "answer", branchIndex: 0 },
        }),
        message("a1", "assistant", [text("new")], {
          createdAt: 3,
          metadata: { branchGroupId: "answer", branchIndex: 1 },
        }),
        message("a2", "assistant", [text("latest")], {
          createdAt: 4,
          metadata: { branchGroupId: "other", branchIndex: 3 },
        }),
      ],
    })
    const turn = items[0]
    if (turn.kind !== "completed-turn") throw new Error("expected a completed turn")

    expect(turn.branchSummary?.groups).toEqual([
      {
        groupId: "answer",
        selectedMessageId: "a0",
        messageIds: ["a0", "a1"],
      },
      { groupId: "other", selectedMessageId: "a2", messageIds: ["a2"] },
    ])
  })

  function regenerated(activeBranchByGroup?: Record<string, string>) {
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 2,
      ...(activeBranchByGroup ? { activeBranchByGroup } : {}),
      messages: [
        message("u1", "user", [text("question")], { createdAt: 1 }),
        message("a0", "assistant", [text("first answer")], {
          createdAt: 2,
          metadata: { branchGroupId: "answer", branchIndex: 0 },
        }),
        message("a1", "assistant", [text("regenerated answer")], {
          createdAt: 3,
          metadata: { branchGroupId: "answer", branchIndex: 1 },
        }),
      ],
    })
    const turn = items[0]
    if (turn.kind !== "completed-turn") throw new Error("expected a completed turn")
    return turn
  }

  it("folds a regenerated turn to the reply the user selected", () => {
    // The earlier sibling is the selection; the last row is not the answer shown.
    const turn = regenerated({ answer: "a0" })
    expect(turn.finalResponse).toMatchObject({ id: "a0", text: "first answer" })
    // The hidden sibling is still reachable by expanding the turn.
    expect(turn.collapsed.exists).toBe(true)
  })

  it("folds to the newest sibling without a selection, or with a stale one", () => {
    expect(regenerated().finalResponse?.id).toBe("a1")
    expect(regenerated({ answer: "deleted-variant" }).finalResponse?.id).toBe("a1")
  })

  it("previews the edited question that is selected, not both", () => {
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 2,
      activeBranchByGroup: { ask: "u1" },
      messages: [
        message("u1", "user", [text("original question")], {
          createdAt: 1,
          turnKey: "t1",
          metadata: { branchGroupId: "ask", branchIndex: 0 },
        }),
        message("a1", "assistant", [text("original answer")], {
          createdAt: 2,
          turnKey: "t1",
          metadata: { branchOwnerId: "u1" },
        }),
        message("u2", "user", [text("edited question")], {
          createdAt: 3,
          turnKey: "t1",
          metadata: { branchGroupId: "ask", branchIndex: 1 },
        }),
        message("a2", "assistant", [text("edited answer")], {
          createdAt: 4,
          turnKey: "t1",
          metadata: { branchOwnerId: "u2" },
        }),
      ],
    })
    const turn = items[0]
    if (turn.kind !== "completed-turn") throw new Error("expected a completed turn")
    expect(turn.userMessages.map((preview) => preview.id)).toEqual(["u1"])
    // The answer hanging off the hidden edit goes with it.
    expect(turn.finalResponse?.id).toBe("a1")
  })
})

describe("transcript cursors", () => {
  it("round-trips an opaque keyset timeline cursor that survives revision bumps", () => {
    const cursor = encodeTimelineCursor({
      sessionId: "session-1",
      direction: "backward",
      before: { createdAt: 30, id: "m-30" },
    })

    expect(cursor).not.toContain("session-1")
    expect(
      validateTimelineCursor(cursor, { sessionId: "session-1", direction: "backward" })
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        kind: "keyset",
        sessionId: "session-1",
        direction: "backward",
        before: { createdAt: 30, id: "m-30" },
      },
    })
    expect(
      validateTimelineCursor(cursor, { sessionId: "session-2", direction: "backward" })
    ).toEqual({ ok: false, code: "INVALID_PARAMS" })
    expect(
      validateTimelineCursor("not a cursor", { sessionId: "session-1", direction: "backward" })
    ).toEqual({ ok: false, code: "INVALID_PARAMS" })
  })

  // A client may still hold a cursor a Host issued before keyset paging. It
  // reads as stale, which the client answers by re-reading the newest page.
  it("reads a pre-keyset position cursor as stale, not malformed", () => {
    const legacy = btoa(
      JSON.stringify({
        version: 1,
        sessionId: "session-1",
        revision: 11,
        direction: "backward",
        position: 30,
      })
    ).replace(/=+$/u, "")
    expect(
      validateTimelineCursor(legacy, { sessionId: "session-1", direction: "backward" })
    ).toEqual({ ok: false, code: "TRANSCRIPT_STALE" })
  })

  it("binds detail cursors to the turn and its own version only", () => {
    const cursor = encodeTurnDetailCursor({
      sessionId: "session-1",
      turnKey: "turn:u1",
      detailRevision: 3,
      position: 100,
    })

    expect(
      validateTurnDetailCursor(cursor, {
        sessionId: "session-1",
        turnKey: "turn:u1",
        detailRevision: 3,
      })
    ).toMatchObject({ ok: true, value: { position: 100 } })
    expect(
      validateTurnDetailCursor(cursor, {
        sessionId: "session-1",
        turnKey: "turn:u1",
        detailRevision: 4,
      })
    ).toEqual({ ok: false, code: "TRANSCRIPT_STALE" })
    expect(
      validateTurnDetailCursor(cursor, {
        sessionId: "session-1",
        turnKey: "turn:u2",
        detailRevision: 3,
      })
    ).toEqual({ ok: false, code: "TURN_NOT_FOUND" })
  })
})

describe("transcriptTurnVersion", () => {
  const row = (id: string, syncRevision?: number) =>
    ({
      id,
      sessionId: "s",
      role: "assistant",
      parts: [],
      createdAt: 1,
      ...(syncRevision === undefined ? {} : { syncRevision }),
    }) as unknown as StoredMessage

  it("is a safe integer that changes on an added, rewritten or removed row only", () => {
    const base = transcriptTurnVersion([row("u", 1), row("a", 2), row("b", 3)])
    expect(Number.isSafeInteger(base)).toBe(true)
    expect(base).toBeGreaterThanOrEqual(0)
    expect(transcriptTurnVersion([row("u", 1), row("a", 2), row("b", 3)])).toBe(base)
    // Rewritten: the Host stamps a new syncRevision on every write.
    expect(transcriptTurnVersion([row("u", 1), row("a", 9), row("b", 3)])).not.toBe(base)
    // Removed, including a row that is not the newest.
    expect(transcriptTurnVersion([row("u", 1), row("b", 3)])).not.toBe(base)
    // Added.
    expect(transcriptTurnVersion([row("u", 1), row("a", 2), row("b", 3), row("c", 4)])).not.toBe(
      base
    )
    // Rows written before the stamp existed still version by identity.
    expect(transcriptTurnVersion([row("u"), row("a")])).not.toBe(transcriptTurnVersion([row("u")]))
  })

  it("is what a completed turn reports as its detailRevision, independent of the session", () => {
    const messages = [
      { ...row("u", 1), role: "user", turnKey: "t1" },
      { ...row("a", 2), turnKey: "t1" },
    ] as StoredMessage[]
    const at = (revision: number) =>
      projectTranscriptTimeline({ sessionId: "s", revision, messages })[0]
    expect(at(4)).toMatchObject({ revision: 4, detailRevision: transcriptTurnVersion(messages) })
    expect(at(9)).toMatchObject({ revision: 9, detailRevision: transcriptTurnVersion(messages) })
  })
})

describe("a completed turn's activity summary (protocol 2, D12)", () => {
  const tool = (name: string, state = "output-available") =>
    ({ type: `tool-${name}`, toolCallId: `${name}-${state}`, state, input: {} }) as never

  it("counts the replies' tools, failures, reasoning and sources, naming tools in first-use order", () => {
    const [item] = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 1,
      messages: [
        message("u1", "user", [{ type: "text", text: "go" }]),
        message(
          "a2",
          "assistant",
          [
            { type: "reasoning", text: "plan" } as never,
            tool("Bash"),
            tool("Read"),
            tool("Bash", "output-error"),
            { type: "source-url", sourceId: "s", url: "https://x.test" } as never,
            {
              type: "sources",
              sources: [
                { id: "1", title: "a", origin: "cognia-web" },
                { id: "2", title: "b", origin: "memory" },
              ],
            } as never,
            { type: "text", text: "done" },
          ],
          { metadata: { run: { durationMs: 42_000 } } as never }
        ),
      ],
    })
    expect(item.kind === "completed-turn" && item.activity).toEqual({
      toolCount: 3,
      failedCount: 1,
      reasoningCount: 1,
      sourceCount: 3,
      tools: [
        { name: "Bash", count: 2, failed: 1 },
        { name: "Read", count: 1, failed: 0 },
      ],
      runDurationMs: 42_000,
    })
  })

  it("has none for a turn that neither called a tool nor reasoned", () => {
    const [item] = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 1,
      messages: [
        message("u1", "user", [{ type: "text", text: "hi" }]),
        message("a2", "assistant", [{ type: "text", text: "hello" }]),
      ],
    })
    expect(item.kind === "completed-turn" && item.activity).toBeUndefined()
  })

  it("counts only the selected branch's reply", () => {
    const [item] = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 1,
      activeBranchByGroup: { g: "a3" },
      messages: [
        message("u1", "user", [{ type: "text", text: "go" }]),
        message("a2", "assistant", [tool("Bash"), { type: "text", text: "old" }], {
          metadata: { branchGroupId: "g" } as never,
        }),
        message("a3", "assistant", [{ type: "text", text: "new" }], {
          metadata: { branchGroupId: "g" } as never,
        }),
      ],
    })
    expect(item.kind === "completed-turn" && item.activity).toBeUndefined()
  })

  it("stays under its byte budget, clipping names and naming at most the first tools", () => {
    const names = Array.from({ length: 20 }, (_, index) => `${"x".repeat(200)}${index}`)
    const [item] = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 1,
      messages: [
        message("u1", "user", [{ type: "text", text: "go" }]),
        message("a2", "assistant", [
          ...names.map((name) => tool(name)),
          { type: "text", text: "ok" },
        ]),
      ],
    })
    if (item.kind !== "completed-turn" || !item.activity) throw new Error("no activity")
    expect(item.activity.toolCount).toBe(20)
    expect(item.activity.tools.length).toBeLessThanOrEqual(TRANSCRIPT_ACTIVITY_TOOL_LIMIT)
    expect(item.activity.tools.length).toBeGreaterThan(0)
    for (const entry of item.activity.tools) {
      expect(entry.name.length).toBeLessThanOrEqual(TRANSCRIPT_ACTIVITY_TOOL_NAME_MAX)
    }
    expect(new TextEncoder().encode(JSON.stringify(item.activity)).byteLength).toBeLessThanOrEqual(
      TRANSCRIPT_ACTIVITY_BYTE_LIMIT
    )
  })
})
