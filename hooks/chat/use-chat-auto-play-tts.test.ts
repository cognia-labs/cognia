import { act, renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"

import { __resetPortsForTesting, __setPortForTesting } from "@/lib/modules/ports"
import type { SpeechPort } from "@/types/modules/ports/speech"

const flags = { ttsEnabled: true, ttsAutoPlay: true }
let settingsHolder: typeof flags | null = flags
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: typeof flags | null }) => unknown) =>
    selector({ settings: settingsHolder }),
}))

const speakChatMessage = jest.fn().mockResolvedValue(undefined)
const speakChatMessageStream = jest.fn().mockResolvedValue(undefined)
const speech = {
  readAloud: {
    speakChatMessage: (...a: unknown[]) => speakChatMessage(...a),
    speakChatMessageStream: (...a: unknown[]) => speakChatMessageStream(...a),
  },
} as unknown as SpeechPort

interface FakePushable {
  push: jest.Mock
  close: jest.Mock
  stream: AsyncIterable<string>
}
const pushables: FakePushable[] = []
jest.mock("@/lib/utils/pushable-stream", () => ({
  createPushableStream: () => {
    const p: FakePushable = {
      push: jest.fn(),
      close: jest.fn(),
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      },
    }
    pushables.push(p)
    return p
  },
}))

jest.mock("@cognia/logging", () => ({ loggers: { tts: { warn: jest.fn() } } }))

import { useChatAutoPlayTTS } from "./use-chat-auto-play-tts"

type Status = "idle" | "streaming" | "awaiting_approval" | "error"

function asstMsg(id: string, text: string, senderId?: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    ...(senderId ? { metadata: { senderId } } : {}),
  } as UIMessage
}

function audioAsstMsg(id: string, text: string): UIMessage {
  return {
    ...asstMsg(id, text),
    metadata: { modality: "audio" },
  } as UIMessage
}

function setup(initial: {
  messages: UIMessage[]
  status: Status
  characterById?: Map<string, never>
  directCharacter?: unknown
}) {
  return renderHook((props: typeof initial) => useChatAutoPlayTTS(props as never), {
    initialProps: initial,
  })
}

/** Let the speech port's (already resolved) load hand over to the reader. */
const flush = () => act(async () => {})

beforeEach(() => {
  __resetPortsForTesting()
  __setPortForTesting("speech", speech)
  speakChatMessage.mockClear()
  speakChatMessageStream.mockClear()
  pushables.length = 0
  settingsHolder = flags
  flags.ttsEnabled = true
  flags.ttsAutoPlay = true
})

describe("useChatAutoPlayTTS — streaming path", () => {
  it("streams the reply while the turn is in flight and feeds the initial text", async () => {
    setup({ messages: [asstMsg("a1", "partial answer")], status: "streaming" })
    await flush()
    expect(speakChatMessageStream).toHaveBeenCalledTimes(1)
    expect(speakChatMessageStream).toHaveBeenCalledWith(expect.anything(), {
      messageId: "a1",
      character: null,
    })
    expect(pushables[0].push).toHaveBeenCalledWith("partial answer")
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("feeds only the newly-appended text as deltas", async () => {
    const { rerender } = setup({ messages: [asstMsg("a1", "Hello")], status: "streaming" })
    await flush()
    rerender({ messages: [asstMsg("a1", "Hello, world")], status: "streaming" })
    await flush()
    expect(pushables[0].push).toHaveBeenNthCalledWith(1, "Hello")
    expect(pushables[0].push).toHaveBeenNthCalledWith(2, ", world")
  })

  it("does not re-read the message on completion (no double-speak) and flushes the tail", async () => {
    const { rerender } = setup({ messages: [asstMsg("a1", "answer")], status: "streaming" })
    await flush()
    rerender({ messages: [asstMsg("a1", "answer")], status: "idle" })
    await flush()
    expect(speakChatMessageStream).toHaveBeenCalledTimes(1)
    expect(speakChatMessage).not.toHaveBeenCalled()
    expect(pushables[0].close).toHaveBeenCalled()
  })

  it("does not start a stream for a tool-only (text-less) message", async () => {
    const toolOnly = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-Bash" }],
    } as unknown as UIMessage
    setup({ messages: [toolOnly], status: "streaming" })
    await flush()
    expect(speakChatMessageStream).not.toHaveBeenCalled()
  })

  it("does not stream an assistant reply already delivered as live audio", async () => {
    setup({ messages: [audioAsstMsg("a1", "spoken live")], status: "streaming" })
    await flush()
    expect(speakChatMessageStream).not.toHaveBeenCalled()
  })

  it("keeps the session across a mid-turn approval pause (no restart)", async () => {
    const { rerender } = setup({ messages: [asstMsg("a1", "Start")], status: "streaming" })
    await flush()
    rerender({ messages: [asstMsg("a1", "Start")], status: "awaiting_approval" })
    await flush()
    rerender({ messages: [asstMsg("a1", "Start and more")], status: "streaming" })
    await flush()
    expect(speakChatMessageStream).toHaveBeenCalledTimes(1) // one session, not restarted
    expect(pushables).toHaveLength(1)
    expect(pushables[0].push).toHaveBeenNthCalledWith(2, " and more")
  })

  it("resolves the team character via senderId", async () => {
    const alice = { id: "c1", name: "Alice" } as never
    const characterById = new Map([["c1", alice]])
    setup({ messages: [asstMsg("a1", "hi", "c1")], status: "streaming", characterById })
    await flush()
    expect(speakChatMessageStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ character: alice })
    )
  })

  it("swallows a streaming rejection without throwing", async () => {
    speakChatMessageStream.mockRejectedValueOnce(new Error("boom"))
    expect(() => setup({ messages: [asstMsg("a1", "hi")], status: "streaming" })).not.toThrow()
    await flush()
    expect(speakChatMessageStream).toHaveBeenCalled()
  })

  it("reads nothing and ends the stream where no module provides the speech port", async () => {
    __setPortForTesting("speech", null)
    const { rerender } = setup({ messages: [asstMsg("a1", "hi")], status: "streaming" })
    await flush()
    expect(speakChatMessageStream).not.toHaveBeenCalled()
    expect(pushables[0].close).toHaveBeenCalled()
    rerender({ messages: [asstMsg("a1", "hi")], status: "idle" })
    await flush()
    expect(speakChatMessage).not.toHaveBeenCalled()
  })
})

describe("useChatAutoPlayTTS — turn-complete fallback", () => {
  it("reads the finished message when streaming never ran (message appears at idle)", async () => {
    const user = { id: "u1", role: "user", parts: [{ type: "text", text: "q" }] } as UIMessage
    const { rerender } = setup({ messages: [user], status: "streaming" })
    await flush()
    expect(speakChatMessageStream).not.toHaveBeenCalled()
    rerender({ messages: [user, asstMsg("a1", "final")], status: "idle" })
    await flush()
    expect(speakChatMessage).toHaveBeenCalledWith({
      messageId: "a1",
      text: "final",
      character: null,
    })
  })

  it("does not fire on idle → idle (no completion edge)", async () => {
    const messages = [asstMsg("a1", "hi")]
    const { rerender } = setup({ messages, status: "idle" })
    await flush()
    rerender({ messages, status: "idle" })
    await flush()
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("does not read a completed assistant reply already delivered as live audio", async () => {
    const user = { id: "u1", role: "user", parts: [{ type: "text", text: "q" }] } as UIMessage
    const { rerender } = setup({ messages: [user], status: "streaming" })
    await flush()
    rerender({ messages: [user, audioAsstMsg("a1", "spoken live")], status: "idle" })
    await flush()
    expect(speakChatMessage).not.toHaveBeenCalled()
  })
})

describe("useChatAutoPlayTTS — gating", () => {
  it("neither streams nor speaks when auto-play is off", async () => {
    flags.ttsAutoPlay = false
    const { rerender } = setup({ messages: [asstMsg("a1", "hi")], status: "streaming" })
    await flush()
    rerender({ messages: [asstMsg("a1", "hi")], status: "idle" })
    await flush()
    expect(speakChatMessageStream).not.toHaveBeenCalled()
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("neither streams nor speaks when TTS is disabled", async () => {
    flags.ttsEnabled = false
    const { rerender } = setup({ messages: [asstMsg("a1", "hi")], status: "streaming" })
    await flush()
    rerender({ messages: [asstMsg("a1", "hi")], status: "idle" })
    await flush()
    expect(speakChatMessageStream).not.toHaveBeenCalled()
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("treats absent settings as disabled (no crash)", async () => {
    settingsHolder = null
    const { rerender } = setup({ messages: [asstMsg("a1", "hi")], status: "streaming" })
    await flush()
    rerender({ messages: [asstMsg("a1", "hi")], status: "idle" })
    await flush()
    expect(speakChatMessageStream).not.toHaveBeenCalled()
    expect(speakChatMessage).not.toHaveBeenCalled()
  })
})
