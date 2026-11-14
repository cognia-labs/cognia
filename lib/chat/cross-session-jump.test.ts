/**
 * @jest-environment jsdom
 */

import type { UIMessage } from "ai"

type Listener = () => void

interface ChatStateLike {
  activeSessionId: string | null
  messages: UIMessage[]
  messagesLoading: boolean
  sessions: Record<string, { messages: UIMessage[]; messagesLoading: boolean }>
  setActiveSession: jest.Mock
}

const chatListeners = new Set<Listener>()
const chatState: ChatStateLike = {
  activeSessionId: null,
  sessions: {},
  messages: [],
  messagesLoading: false,
  setActiveSession: jest.fn((id: string) => {
    chatState.activeSessionId = id
    chatState.messagesLoading = true
    notifyChat()
  }),
}
function notifyChat() {
  for (const listener of [...chatListeners]) listener()
}

const viewportListeners = new Set<Listener>()
const viewportState: { jumpToMessage: jest.Mock | null; sessionJumps: Record<string, jest.Mock> } =
  { jumpToMessage: null, sessionJumps: {} }
function notifyViewport() {
  for (const listener of [...viewportListeners]) listener()
}

jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => chatState,
    subscribe: (listener: Listener) => {
      chatListeners.add(listener)
      return () => chatListeners.delete(listener)
    },
  },
}))

jest.mock("@/stores/chat/chat-viewport-store", () => ({
  useChatViewportStore: {
    getState: () => viewportState,
    subscribe: (listener: Listener) => {
      viewportListeners.add(listener)
      return () => viewportListeners.delete(listener)
    },
  },
}))

import { CROSS_SESSION_JUMP_TIMEOUT_MS, jumpToSessionMessage } from "./cross-session-jump"

function message(id: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: id }] } as UIMessage
}

/** The target session's history arrives and its pane registers a jump. */
function hydrate(messages: UIMessage[], jump: jest.Mock) {
  chatState.messages = messages
  chatState.messagesLoading = false
  viewportState.jumpToMessage = jump
  notifyViewport()
  notifyChat()
}

beforeEach(() => {
  jest.useFakeTimers()
  chatListeners.clear()
  viewportListeners.clear()
  chatState.activeSessionId = null
  chatState.messages = []
  chatState.messagesLoading = false
  chatState.setActiveSession.mockClear()
  viewportState.jumpToMessage = null
  viewportState.sessionJumps = {}
  chatState.sessions = {}
})

afterEach(() => {
  jest.useRealTimers()
})

describe("jumpToSessionMessage", () => {
  it("focuses the target conversation before anything else", () => {
    void jumpToSessionMessage("other", "m1")
    expect(chatState.setActiveSession).toHaveBeenCalledWith("other")
  })

  it("jumps straight away when the row is already renderable", async () => {
    const jump = jest.fn().mockReturnValue(true)
    chatState.activeSessionId = "here"
    chatState.messages = [message("m1")]
    viewportState.jumpToMessage = jump

    await expect(jumpToSessionMessage("here", "m1", { align: "center" })).resolves.toBe(true)
    expect(jump).toHaveBeenCalledWith("m1", undefined, { align: "center" })
    expect(chatState.setActiveSession).not.toHaveBeenCalled()
  })

  it("waits for the parent's history instead of firing one frame later", async () => {
    // The whole point: `setActiveSession` only STARTS the load, and the pane
    // that registers the jump has not mounted yet. A single requestAnimationFrame
    // reported "not found" for a message that was about to render.
    const jump = jest.fn().mockReturnValue(true)
    const pending = jumpToSessionMessage("parent", "m2")
    expect(jump).not.toHaveBeenCalled()

    hydrate([message("m1"), message("m2")], jump)
    await expect(pending).resolves.toBe(true)
    expect(jump).toHaveBeenCalledWith("m2", undefined, undefined)
  })

  it("keeps waiting while history is loading even if the id is already present", async () => {
    const jump = jest.fn().mockReturnValue(true)
    const pending = jumpToSessionMessage("parent", "m2")

    chatState.messages = [message("m2")]
    viewportState.jumpToMessage = jump
    notifyChat()
    expect(jump).not.toHaveBeenCalled()

    chatState.messagesLoading = false
    notifyChat()
    await expect(pending).resolves.toBe(true)
  })

  it("keeps waiting until a list has registered its jump", async () => {
    const pending = jumpToSessionMessage("parent", "m2")
    chatState.messages = [message("m2")]
    chatState.messagesLoading = false
    notifyChat()

    const jump = jest.fn().mockReturnValue(true)
    viewportState.jumpToMessage = jump
    notifyViewport()
    await expect(pending).resolves.toBe(true)
  })

  it("reports failure when the row never arrives, rather than waiting forever", async () => {
    const pending = jumpToSessionMessage("parent", "ghost")
    jest.advanceTimersByTime(CROSS_SESSION_JUMP_TIMEOUT_MS + 1)
    await expect(pending).resolves.toBe(false)
  })

  it("reports failure when the list refuses the row", async () => {
    const jump = jest.fn().mockReturnValue(false)
    const pending = jumpToSessionMessage("parent", "m2")
    hydrate([message("m2")], jump)
    await expect(pending).resolves.toBe(false)
  })

  it("gives up if the user navigates somewhere else while waiting", async () => {
    const pending = jumpToSessionMessage("parent", "m2")
    chatState.activeSessionId = "somewhere-else"
    notifyChat()
    await expect(pending).resolves.toBe(false)
  })

  it("leaves no timer or subscription behind once it settles", async () => {
    const jump = jest.fn().mockReturnValue(true)
    const pending = jumpToSessionMessage("parent", "m2")
    hydrate([message("m2")], jump)
    await pending
    expect(chatListeners.size).toBe(0)
    expect(viewportListeners.size).toBe(0)
    expect(jest.getTimerCount()).toBe(0)
  })
})

it("waits for aside hydration and its own list while the parent stays active", async () => {
  chatState.activeSessionId = "parent"
  const mainJump = jest.fn(() => true)
  viewportState.jumpToMessage = mainJump
  const pending = jumpToSessionMessage("aside", "target", {
    activeSessionId: "parent",
    align: "center",
  })
  const asideJump = jest.fn(() => true)
  chatState.sessions.aside = { messages: [message("target")], messagesLoading: false }
  notifyChat()
  expect(mainJump).not.toHaveBeenCalled()
  viewportState.sessionJumps.aside = asideJump
  notifyViewport()
  await expect(pending).resolves.toBe(true)
  expect(asideJump).toHaveBeenCalledWith("target", undefined, { align: "center" })
  expect(chatState.activeSessionId).toBe("parent")
  expect(chatState.setActiveSession).not.toHaveBeenCalled()
})

it("cancels a pending aside jump when the consumer unmounts", async () => {
  chatState.activeSessionId = "parent"
  const controller = new AbortController()
  const pending = jumpToSessionMessage("aside", "target", {
    activeSessionId: "parent",
    signal: controller.signal,
  })
  controller.abort()
  await expect(pending).resolves.toBe(false)
  expect(chatListeners.size).toBe(0)
  expect(viewportListeners.size).toBe(0)
  expect(jest.getTimerCount()).toBe(0)
})
