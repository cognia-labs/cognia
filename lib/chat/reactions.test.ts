const setMessageReaction = jest.fn(async () => [{ emoji: "👍", actorIds: ["local"] }])
jest.mock("@/lib/db/messages", () => ({
  setMessageReaction: (...args: unknown[]) => setMessageReaction(...(args as [])),
}))
const mockGetSession = jest.fn(async (): Promise<unknown> => undefined)
jest.mock("@/lib/db/sessions", () => ({ getSession: () => mockGetSession() }))
const reflectMessageReactions = jest.fn()
jest.mock("./reactions-store", () => ({
  reflectMessageReactions: (...args: unknown[]) => reflectMessageReactions(...(args as [])),
}))

import {
  MESSAGE_REACTION_EMOJIS,
  messageAllowsReactions,
  platformAddressOf,
  reactionAbilityFor,
  ReactionNeedsHostError,
  readReactions,
  toggleMessageReaction,
} from "./reactions"
import type {
  ConversationChannel,
  ConversationChannelBinding,
} from "@/types/modules/ports/conversation-channel"
import type { WritePlaneRoute } from "@/lib/runtime/write-plane-route"

beforeEach(() => {
  setMessageReaction.mockClear()
  reflectMessageReactions.mockClear()
})

const imMessage = {
  id: "m1",
  metadata: {
    platformMessage: {
      messageId: "42",
      adapterId: "tg-1",
      platform: "telegram",
      conversationKey: "telegram:tg-1:7",
    },
    reactions: [{ emoji: "❤️", actorIds: ["local"], platformReactionIds: { local: "r-9" } }],
  },
}

const binding: ConversationChannelBinding = {
  conversationKey: "telegram:tg-1:7",
  adapterId: "tg-1",
}

function imChannel(
  route: WritePlaneRoute,
  overrides: Partial<Pick<ConversationChannel, "addReaction" | "removeReaction">> = {}
) {
  const calls = { add: [] as unknown[], remove: [] as unknown[] }
  const channel = {
    writeRoute: jest.fn(() => route),
    addReaction: async (input: unknown) => {
      calls.add.push(input)
      return "r-new"
    },
    removeReaction: async (input: unknown) => {
      calls.remove.push(input)
    },
    ...overrides,
  }
  return {
    calls,
    channel,
    channelFor: jest.fn(async () => channel as unknown as ConversationChannel),
  }
}

/** Deps for a toggle on the IM conversation, served by `im`. */
function on(im: ReturnType<typeof imChannel>) {
  return { conversation: async () => binding, channelFor: im.channelFor }
}

describe("messageAllowsReactions", () => {
  it("applies to an IM row and to a row that already carries reactions", () => {
    expect(messageAllowsReactions(imMessage)).toBe(true)
    expect(
      messageAllowsReactions({ metadata: { reactions: [{ emoji: "👍", actorIds: ["x"] }] } })
    ).toBe(true)
  })

  it("does not apply to a solo assistant row, where a reaction reaches nobody", () => {
    expect(messageAllowsReactions({ metadata: {} })).toBe(false)
    expect(messageAllowsReactions({})).toBe(false)
    expect(messageAllowsReactions({ metadata: { reactions: [] } })).toBe(false)
  })
})

describe("readers", () => {
  it("reads reactions and the IM address defensively", () => {
    expect(readReactions({ metadata: { reactions: "no" } })).toEqual([])
    expect(readReactions(imMessage)).toHaveLength(1)
    expect(platformAddressOf(imMessage)).toEqual({
      adapterId: "tg-1",
      platformMessageId: "42",
      conversationKey: "telegram:tg-1:7",
    })
    expect(
      platformAddressOf({ metadata: { platformMessage: { messageId: "x", adapterId: "a" } } })
    ).toEqual({ adapterId: "a", platformMessageId: "x" })
    expect(platformAddressOf({ metadata: { platformMessage: { messageId: "x" } } })).toBeNull()
    expect(platformAddressOf({})).toBeNull()
    expect(MESSAGE_REACTION_EMOJIS).toContain("👍")
  })

  it("maps the write route onto what a shell may do", () => {
    expect(reactionAbilityFor("local")).toBe("write-and-mirror")
    expect(reactionAbilityFor("unavailable")).toBe("write-only")
    expect(reactionAbilityFor("remote")).toBe("host-only")
  })
})

describe("toggleMessageReaction", () => {
  it("adds when the actor has not reacted, mirrors, and keeps the platform id", async () => {
    const im = imChannel("local")
    const result = await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "👍",
      deps: on(im),
    })
    expect(im.calls.add).toEqual([{ binding, platformMessageId: "42", emoji: "👍" }])
    expect(setMessageReaction).toHaveBeenCalledWith("s1", "m1", {
      emoji: "👍",
      actorId: "local",
      add: true,
      platformReactionId: "r-new",
    })
    expect(result).toMatchObject({ added: true, mirror: "done" })
    // The open pane sees the pill at once, not after the next reload.
    expect(reflectMessageReactions).toHaveBeenCalledWith("s1", "m1", [
      { emoji: "👍", actorIds: ["local"] },
    ])
  })

  it("removes with the stored platform id when the actor already reacted", async () => {
    const im = imChannel("local")
    const result = await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "❤️",
      deps: on(im),
    })
    expect(im.calls.remove).toEqual([
      { binding, platformMessageId: "42", reactionId: "r-9", emoji: "❤️" },
    ])
    expect(setMessageReaction).toHaveBeenCalledWith("s1", "m1", {
      emoji: "❤️",
      actorId: "local",
      add: false,
    })
    expect(result.added).toBe(false)
  })

  it("still records the reaction when the platform refuses it, and says so", async () => {
    const im = imChannel("local", {
      addReaction: async () => {
        throw new Error("adapter cannot add reactions")
      },
    })
    const result = await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "👍",
      deps: on(im),
    })
    expect(setMessageReaction).toHaveBeenCalledTimes(1)
    expect(result.mirror).toEqual({ failed: "adapter cannot add reactions" })
  })

  it("skips the mirror for a message with no IM address and off the local route", async () => {
    const im = imChannel("local")
    const plain = await toggleMessageReaction({
      sessionId: "s1",
      message: { id: "m2", metadata: {} },
      emoji: "👍",
      deps: on(im),
    })
    expect(plain.mirror).toBe("skipped")
    const standalone = imChannel("unavailable")
    const offline = await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "👍",
      deps: on(standalone),
    })
    expect(offline.mirror).toBe("skipped")
    expect(im.calls.add).toEqual([])
    expect(standalone.calls.add).toEqual([])
  })

  it("writes without mirroring a conversation no active channel serves", async () => {
    const result = await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "👍",
      deps: { conversation: async () => binding, channelFor: async () => null },
    })
    expect(result.mirror).toBe("skipped")
    expect(setMessageReaction).toHaveBeenCalledTimes(1)
  })

  it("refuses to write on a companion, whose rows belong to the host", async () => {
    await expect(
      toggleMessageReaction({
        sessionId: "s1",
        message: imMessage,
        emoji: "👍",
        deps: on(imChannel("remote")),
      })
    ).rejects.toBeInstanceOf(ReactionNeedsHostError)
    expect(setMessageReaction).not.toHaveBeenCalled()
  })

  it("finds the conversation through the message, else through its session", async () => {
    const im = imChannel("local")
    await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "👍",
      deps: { channelFor: im.channelFor },
    })
    expect(im.channelFor).toHaveBeenLastCalledWith(binding)
    expect(mockGetSession).not.toHaveBeenCalled()
    mockGetSession.mockResolvedValueOnce({
      platformBinding: { conversationKey: "telegram:tg-1:7", adapterId: "tg-1" },
    })
    const legacy = {
      id: "m3",
      metadata: { platformMessage: { messageId: "43", adapterId: "tg-1" } },
    }
    await toggleMessageReaction({
      sessionId: "s1",
      message: legacy,
      emoji: "👍",
      deps: { channelFor: im.channelFor },
    })
    expect(im.channelFor).toHaveBeenLastCalledWith(binding)
    expect(im.calls.add.at(-1)).toEqual({ binding, platformMessageId: "43", emoji: "👍" })
  })

  it("resolves the conversation from production when no seam is given", async () => {
    const result = await toggleMessageReaction({
      sessionId: "s1",
      message: { id: "m2", metadata: {} },
      emoji: "👀",
    })
    expect(result.mirror).toBe("skipped")
  })
})
