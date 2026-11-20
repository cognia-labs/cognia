import type { UIMessage } from "ai"

import {
  createLiveVoiceTurnPersister,
  liveVoiceMessageId,
  liveVoiceToolMessageId,
  liveVoiceTurnsToMessages,
  persistLiveVoiceTurns,
  type LiveVoiceTurnProvenance,
} from "./persist-turns"

const PROVENANCE: LiveVoiceTurnProvenance = {
  provider: "openai",
  modelOrResource: "gpt-realtime-2.1",
  region: "global",
}

const TURNS = [
  { id: "item_1", role: "user" as const, text: "what is the weather" },
  { id: "item_2", role: "assistant" as const, text: "sunny" },
]

function metaOf(message: UIMessage): Record<string, unknown> {
  return (message.metadata ?? {}) as Record<string, unknown>
}

describe("liveVoiceTurnsToMessages", () => {
  it("projects each turn onto a text message", () => {
    const messages = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      id: liveVoiceMessageId("s1", "call-a", "item_1"),
      role: "user",
      parts: [{ type: "text", text: "what is the weather" }],
    })
    expect(messages[1]).toMatchObject({ role: "assistant" })
  })

  it("stamps every turn so it cannot fire chat-message workflows", () => {
    // Speech never went through the send path; firing workflows off it would
    // surprise the user. The flag has to be present on the first write.
    const messages = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    for (const message of messages) {
      expect(metaOf(message).triggerWorkflows).toBe(false)
    }
  })

  it("records which provider and region the turn was spoken to", () => {
    const [first] = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(metaOf(first)).toMatchObject({
      provider: "openai",
      modelOrResource: "gpt-realtime-2.1",
      region: "global",
      modality: "audio",
      final: true,
    })
  })

  it("gives each turn a strictly increasing timestamp", () => {
    // listMessages sorts by createdAt and a whole voice session lands inside
    // one millisecond, so equal stamps would scramble the transcript.
    const messages = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(metaOf(messages[0]).createdAt).toBe(1_000)
    expect(metaOf(messages[1]).createdAt).toBe(1_001)
  })

  it("derives ids from the provider item id so a re-write updates in place", () => {
    const first = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })
    const again = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 9_000,
    })

    expect(first.map((m) => m.id)).toEqual(again.map((m) => m.id))
  })

  it("scopes ids to the session so two sessions never collide", () => {
    expect(liveVoiceMessageId("s1", "call-a", "item_1")).not.toBe(
      liveVoiceMessageId("s2", "call-a", "item_1")
    )
  })

  it("drops a turn the provider heard as silence", () => {
    const messages = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: [{ id: "item_1", role: "user", text: "   " }],
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(messages).toEqual([])
  })

  it("stores no audio, only the transcript", () => {
    const [first] = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(first.parts).toEqual([{ type: "text", text: "what is the weather" }])
  })

  it("stores terminal tool lifecycle records without arguments or provider output", () => {
    const messages = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
      toolRecords: [
        { callId: "call-1", name: "search", status: "completed", durationMs: 42 },
        { callId: "call-2", name: "write", status: "rejected", durationMs: 8 },
      ],
    })

    expect(messages.at(-1)?.parts).toEqual([
      {
        type: "dynamic-tool",
        toolCallId: "call-1",
        toolName: "search",
        state: "output-available",
        input: {},
        output: { status: "completed", durationMs: 42 },
      },
      {
        type: "dynamic-tool",
        toolCallId: "call-2",
        toolName: "write",
        state: "output-available",
        input: {},
        output: { status: "rejected", durationMs: 8 },
      },
    ])
  })
})

describe("liveVoiceMessageId", () => {
  it("keeps the same turn id in two calls of one chat apart", () => {
    // Gemini restarts its item counter per call, so `google-input-0` recurs.
    expect(liveVoiceMessageId("s1", "call-a", "1:google-input-0")).not.toBe(
      liveVoiceMessageId("s1", "call-b", "1:google-input-0")
    )
  })

  it("gives each call its own tool lifecycle row", () => {
    const first = liveVoiceTurnsToMessages("s1", {
      callId: "call-a",
      turns: [],
      provenance: PROVENANCE,
      startedAt: 1_000,
      toolRecords: [{ callId: "t1", name: "search", status: "completed", durationMs: 1 }],
    })
    const second = liveVoiceTurnsToMessages("s1", {
      callId: "call-b",
      turns: [],
      provenance: PROVENANCE,
      startedAt: 2_000,
      toolRecords: [{ callId: "t2", name: "search", status: "completed", durationMs: 1 }],
    })

    expect(first[0].id).toBe(liveVoiceToolMessageId("s1", "call-a"))
    expect(second[0].id).toBe(liveVoiceToolMessageId("s1", "call-b"))
    expect(first[0].id).not.toBe(second[0].id)
  })
})

function persisterWith(commit: jest.Mock, callId = "call-a") {
  return createLiveVoiceTurnPersister({
    sessionId: "s1",
    callId,
    provenance: PROVENANCE,
    startedAt: 1_000,
    commit,
  })
}

function committed(commit: jest.Mock, call: number): UIMessage[] {
  return commit.mock.calls[call][1] as UIMessage[]
}

function textOf(message: UIMessage): string {
  return (message.parts[0] as { text: string }).text
}

describe("LiveVoiceTurnPersister", () => {
  it("serializes incremental writes and ignores a revision already queued", async () => {
    let releaseFirst: (() => void) | undefined
    const commit = jest
      .fn<Promise<void>, [string, UIMessage[]]>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValue(undefined)
    const persister = persisterWith(commit)

    const first = persister.append([TURNS[0]])
    const duplicate = persister.append([TURNS[0]])
    const second = persister.append([TURNS[1]])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(commit).toHaveBeenCalledTimes(1)

    releaseFirst?.()
    await Promise.all([first, duplicate, second])

    expect(commit).toHaveBeenCalledTimes(2)
  })

  it("re-writes a turn whose text the provider revised under the same id", async () => {
    // Gemini reports one input item as it grows; persisting only the first
    // partial left the history saying "hello" while the UI said "hello world".
    const commit = jest.fn<Promise<void>, [string, UIMessage[]]>().mockResolvedValue(undefined)
    const persister = persisterWith(commit)
    const partial = { id: "1:google-input-0", role: "user" as const, text: "hello" }

    await persister.append([partial])
    await persister.append([{ ...partial, text: "hello world" }])
    await persister.flush([{ ...partial, text: "hello world" }])

    expect(commit).toHaveBeenCalledTimes(2)
    expect(textOf(committed(commit, 1)[0])).toBe("hello world")
    expect(committed(commit, 1)[0].id).toBe(committed(commit, 0)[0].id)
    expect(metaOf(committed(commit, 1)[0]).createdAt).toBe(
      metaOf(committed(commit, 0)[0]).createdAt
    )
  })

  it("writes the final text when a revision queues behind an in-flight partial", async () => {
    let releaseFirst: (() => void) | undefined
    const commit = jest
      .fn<Promise<void>, [string, UIMessage[]]>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValue(undefined)
    const persister = persisterWith(commit)
    const partial = { id: "1:google-input-0", role: "user" as const, text: "hello" }

    const first = persister.append([partial])
    const revised = persister.append([{ ...partial, text: "hello world" }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseFirst?.()
    await Promise.all([first, revised])
    await persister.flush([{ ...partial, text: "hello world" }])

    expect(commit).toHaveBeenCalledTimes(2)
    expect(textOf(committed(commit, 1)[0])).toBe("hello world")
  })

  it("keeps timestamps increasing across separate incremental writes", async () => {
    const commit = jest.fn<Promise<void>, [string, UIMessage[]]>().mockResolvedValue(undefined)
    const persister = persisterWith(commit)

    await persister.append([TURNS[0]])
    await persister.append(TURNS)

    expect(metaOf(committed(commit, 0).at(-1) as UIMessage).createdAt).toBe(1_000)
    expect(metaOf(committed(commit, 1).at(-1) as UIMessage).createdAt).toBe(1_001)
  })

  it("orders tool history between turns and keeps its timestamp stable on updates", async () => {
    const commit = jest.fn<Promise<void>, [string, UIMessage[]]>().mockResolvedValue(undefined)
    const persister = persisterWith(commit)
    const tool = { callId: "call-1", name: "search", status: "completed" as const, durationMs: 5 }

    await persister.append([TURNS[0]])
    await persister.append([TURNS[0]], [tool])
    await persister.append(TURNS, [tool])
    await persister.append(TURNS, [{ ...tool, durationMs: 8 }])

    expect(metaOf(committed(commit, 0).at(-1) as UIMessage).createdAt).toBe(1_000)
    expect(metaOf(committed(commit, 1).at(-1) as UIMessage).createdAt).toBe(1_001)
    expect(metaOf(committed(commit, 2).at(-1) as UIMessage).createdAt).toBe(1_002)
    expect(metaOf(committed(commit, 3).at(-1) as UIMessage).createdAt).toBe(1_001)
  })

  it("retries a failed incremental write when the session flushes", async () => {
    const commit = jest
      .fn<Promise<void>, [string, UIMessage[]]>()
      .mockRejectedValueOnce(new Error("dexie unavailable"))
      .mockResolvedValue(undefined)
    const persister = persisterWith(commit)

    await expect(persister.append([TURNS[0]])).rejects.toThrow("dexie unavailable")
    await expect(persister.flush([TURNS[0]])).resolves.toBeUndefined()

    expect(commit).toHaveBeenCalledTimes(2)
  })
})

describe("persistLiveVoiceTurns", () => {
  it("upserts only the voice turns and never re-sends the rest of the history", async () => {
    // The call does not own the transcript; a full replace from a stale read
    // would delete whatever another writer committed meanwhile.
    const commit = jest.fn<Promise<void>, [string, UIMessage[]]>().mockResolvedValue(undefined)

    const written = await persistLiveVoiceTurns({
      sessionId: "s1",
      callId: "call-a",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
      commit,
    })

    expect(written.map((message) => message.id)).toEqual([
      liveVoiceMessageId("s1", "call-a", "item_1"),
      liveVoiceMessageId("s1", "call-a", "item_2"),
    ])
    expect(commit).toHaveBeenCalledWith("s1", written)
  })

  it("writes nothing at all for a session where nobody spoke", async () => {
    const commit = jest.fn<Promise<void>, [string, UIMessage[]]>()

    const written = await persistLiveVoiceTurns({
      sessionId: "s1",
      callId: "call-a",
      turns: [],
      provenance: PROVENANCE,
      startedAt: 1_000,
      commit,
    })

    expect(written).toEqual([])
    expect(commit).not.toHaveBeenCalled()
  })
})
