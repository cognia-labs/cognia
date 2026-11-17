/** @jest-environment jsdom */
import type { UIMessage } from "ai"

import {
  runEditAndResend,
  runRegenerate,
  warnMessagesNotResent,
  type AgentChatEditRegenerateContext,
} from "./agent-chat-edit-regenerate"

const warning = jest.fn()
jest.mock("sonner", () => ({ toast: { warning: (m: string) => warning(m) } }))
let status = "idle"
jest.mock("@/lib/chat/steer-runtime", () => ({ sessionStatusOf: () => status }))
let queued = false
jest.mock("@/lib/execution/chat-lease", () => ({ isChatTurnQueued: () => queued }))
const persistMessages = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/db/messages", () => ({
  persistMessages: (...args: unknown[]) => persistMessages(...args),
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn(async () => null) }))
const resendableAttachments = jest.fn(async () => ({ blocks: [], manifest: [], unavailable: [] }))
const resendableUserTurn = jest.fn(async () => ({
  content: "rebuilt",
  manifest: [],
  unavailable: ["lost.pdf"],
}))
jest.mock("@/lib/chat/attachments/resend", () => ({
  resendableAttachments: () => resendableAttachments(),
  resendableUserTurn: () => resendableUserTurn(),
}))

const thread: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }] },
]
const chat = {
  activeSessionId: "s1",
  sessions: { s1: { messages: thread } } as Record<string, { messages: UIMessage[] }>,
  replaceSessionMessages: jest.fn(),
  setSessionDiagnostic: jest.fn(),
}
jest.mock("@/stores/chat", () => ({ useChatStore: { getState: () => chat } }))

function context(): AgentChatEditRegenerateContext {
  return {
    store: { getState: () => chat } as unknown as AgentChatEditRegenerateContext["store"],
    tAttachments: ((key: string) => key) as never,
    refuseCapturedTurn: jest.fn(() => false),
    messagesMirrorRef: { current: new Map([["s1", []]]) },
    lastUserContentRef: { current: new Map() },
    lastResourceContextRef: { current: new Map() },
    registry: { release: jest.fn() } as never,
    send: jest.fn(async () => true) as never,
    warnNotResent: jest.fn(),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  status = "idle"
  queued = false
})

it("names the attachments a resend could not carry", () => {
  warnMessagesNotResent(context(), [])
  expect(warning).not.toHaveBeenCalled()
  warnMessagesNotResent(context(), ["a.pdf"])
  expect(warning).toHaveBeenCalledWith("notResent")
})

describe("runEditAndResend", () => {
  it("tags the original as a sibling and sends the edit as the new variant", async () => {
    const ctx = context()
    await runEditAndResend(ctx, "u1", "edited")

    expect(ctx.registry.release).toHaveBeenCalledWith("s1")
    expect(ctx.messagesMirrorRef.current.has("s1")).toBe(false)
    expect(chat.replaceSessionMessages).toHaveBeenCalledWith("s1", expect.any(Array))
    expect(persistMessages).toHaveBeenCalledWith("s1", expect.any(Array))
    expect(ctx.send).toHaveBeenCalledWith(
      "edited",
      undefined,
      expect.objectContaining({
        sessionId: "s1",
        branchTag: expect.objectContaining({ edit: expect.objectContaining({ messageId: "u1" }) }),
      })
    )
  })

  it("leaves a live or queued turn alone", async () => {
    for (const set of [() => (status = "streaming"), () => (queued = true)]) {
      set()
      const ctx = context()
      await runEditAndResend(ctx, "u1", "edited")
      expect(ctx.send).not.toHaveBeenCalled()
      status = "idle"
      queued = false
    }
  })
})

describe("runRegenerate", () => {
  it("resends the cached last turn as a regenerated branch", async () => {
    const ctx = context()
    ctx.lastUserContentRef.current.set("s1", { messageId: "u1", content: "cached" } as never)
    await runRegenerate(ctx)

    expect(ctx.send).toHaveBeenCalledWith(
      "cached",
      undefined,
      expect.objectContaining({
        sessionId: "s1",
        skipUserAppend: true,
        regenerateBranch: { anchorId: "u1" },
      })
    )
  })

  it("rebuilds a turn this controller did not send from its row", async () => {
    const ctx = context()
    await runRegenerate(ctx, "s1")

    expect(ctx.warnNotResent).toHaveBeenCalledWith(["lost.pdf"])
    expect(ctx.send).toHaveBeenCalledWith("rebuilt", undefined, expect.anything())
  })

  it("refuses a captured turn", async () => {
    const ctx = context()
    ;(ctx.refuseCapturedTurn as jest.Mock).mockReturnValue(true)
    await runRegenerate(ctx)
    expect(ctx.send).not.toHaveBeenCalled()
  })
})
