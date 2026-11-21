import { chatStatusToEmit, wireChatSource } from "./chat-source"
import { makeSessionSlice, useChatStore } from "@/stores/chat/chat-store"
import type { PetEvent } from "@/types/pet"

function collect() {
  const events: PetEvent[] = []
  return {
    events,
    emit: (e: Omit<PetEvent, "at"> & { at?: number }) => events.push({ ...e, at: e.at ?? 0 }),
  }
}

describe("chatStatusToEmit", () => {
  it("maps each transition", () => {
    const { events, emit } = collect()
    chatStatusToEmit("streaming", "idle", emit)
    chatStatusToEmit("awaiting_approval", "streaming", emit)
    chatStatusToEmit("error", "streaming", emit)
    chatStatusToEmit("idle", "streaming", emit) // completed turn → review
    chatStatusToEmit("idle", "error", emit) // recovered → idle
    expect(events.map((e) => e.kind)).toEqual(["thinking", "waiting", "error", "review", "idle"])
  })

  it("ignores no-op transitions", () => {
    const { events, emit } = collect()
    chatStatusToEmit("idle", "idle", emit)
    expect(events).toHaveLength(0)
  })
})

describe("wireChatSource", () => {
  beforeEach(() => {
    useChatStore.setState({
      activeSessionId: null,
      status: "idle",
      sessions: {},
    })
  })

  it("reacts to real chat store transitions", () => {
    useChatStore.setState({ status: "idle" })
    const { events, emit } = collect()
    const off = wireChatSource(emit)
    useChatStore.setState({ status: "streaming" })
    useChatStore.setState({ status: "idle" })
    off()
    useChatStore.setState({ status: "streaming" })
    expect(events.map((e) => e.kind)).toEqual(["thinking", "review"])
  })

  it("does not emit a false review when switching focus from a streaming session to an idle one (F2)", () => {
    const sliceA = { ...makeSessionSlice(), status: "streaming" as const }
    const sliceB = { ...makeSessionSlice(), status: "idle" as const }
    useChatStore.setState({
      activeSessionId: "session-a",
      status: "streaming",
      sessions: { "session-a": sliceA, "session-b": sliceB },
    })
    const { events, emit } = collect()
    const off = wireChatSource(emit)

    // Switching focus updates top-level `status` from streaming→idle, while
    // session-a is still streaming in the background.
    useChatStore.setState({
      activeSessionId: "session-b",
      status: "idle",
      sessions: { "session-a": sliceA, "session-b": sliceB },
    })
    expect(events).toHaveLength(0)

    // When session-a actually finishes in the background, emit one real review.
    useChatStore.setState({
      activeSessionId: "session-b",
      status: "idle",
      sessions: {
        "session-a": { ...sliceA, status: "idle" },
        "session-b": sliceB,
      },
    })
    off()
    expect(events).toEqual([
      expect.objectContaining({
        source: "chat",
        kind: "review",
        xp: 2,
        meta: { sessionId: "session-a" },
      }),
    ])
  })

  it("releases radar state without awarding review XP when an active session is removed", () => {
    const sliceA = { ...makeSessionSlice(), status: "streaming" as const }
    useChatStore.setState({
      activeSessionId: "session-a",
      status: "streaming",
      sessions: { "session-a": sliceA },
    })
    const { events, emit } = collect()
    const off = wireChatSource(emit)

    useChatStore.setState({
      activeSessionId: null,
      status: "idle",
      sessions: {},
    })
    off()
    expect(events.map((e) => e.kind)).toEqual(["idle"])
    expect(events.some((e) => e.kind === "review")).toBe(false)
  })
})
