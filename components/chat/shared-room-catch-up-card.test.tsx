/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"

jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
let mockLocale = "en"

let mockSession: ChatSession | undefined
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => mockSession,
}))

const mockUtility = jest.fn()
const mockHeadless = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => mockUtility(...args),
}))
jest.mock("@/lib/ai/headless-turn-llm-client", () => ({
  buildHeadlessTurnLlmClient: (...args: unknown[]) => mockHeadless(...args),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => ({}),
}))

import { SharedRoomCatchUpCard, catchUpLanguage } from "./shared-room-catch-up-card"

const shared = {
  id: "local",
  collaboration: { orgId: "o", workspaceId: "w", sessionId: "s", policyRevision: 1 },
} as unknown as ChatSession
const message = (id: string, text: string, name = "Ada") => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
  metadata: { collaboration: { author: { kind: "human", id: `u_${name}`, displayName: name } } },
})
const messages = [
  message("m0", "seen"),
  message("m1", "Ship Friday?"),
  message("m2", "If tests pass.", "Bo"),
  message("m3", "Two failures in auth."),
  message("m4", "Bo takes auth.", "Bo"),
]

function client(answer: string | (() => Promise<string>)) {
  return {
    complete: jest.fn<Promise<string>, [string, { system?: string }?]>(
      typeof answer === "string" ? async () => answer : answer
    ),
  }
}

beforeEach(() => {
  mockSession = shared
  mockLocale = "en"
  mockUtility.mockReset().mockReturnValue(null)
  mockHeadless.mockReset().mockReturnValue(null)
  useChatViewportStore.getState().registerJumpToMessage(null)
})

describe("SharedRoomCatchUpCard", () => {
  it("offers a catch-up of what was missed, and asks nothing until pressed", () => {
    const llm = client("- x @msg:m1")
    mockUtility.mockReturnValue(llm)
    render(<SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m1" />)
    expect(screen.getByTestId("shared-room-catch-up")).toHaveTextContent('unread:{"count":4}')
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it("summarises with cited points that jump to their messages", async () => {
    const jump = jest.fn(() => true)
    useChatViewportStore.getState().registerJumpToMessage(jump)
    mockUtility.mockReturnValue(client("- Bo takes auth after two failures. @msg:m3 @msg:m4"))
    render(<SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m1" />)
    fireEvent.click(screen.getByTestId("shared-room-catch-up-run"))
    const citations = await screen.findAllByTestId("shared-room-catch-up-citation")
    expect(citations.map((citation) => citation.textContent)).toEqual(["3", "4"])
    expect(screen.getByTestId("shared-room-catch-up-points")).toHaveTextContent(
      "Bo takes auth after two failures."
    )
    expect(screen.getByTestId("shared-room-catch-up")).toHaveTextContent('covered:{"count":4}')
    fireEvent.click(citations[1])
    expect(jump).toHaveBeenCalledWith("m4", undefined, { align: "center" })
  })

  it("falls back to one headless turn without a renderer key, and says when neither exists", async () => {
    const llm = client("- Point. @msg:m2")
    mockHeadless.mockReturnValueOnce(llm)
    const { unmount } = render(
      <SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m1" />
    )
    fireEvent.click(screen.getByTestId("shared-room-catch-up-run"))
    await screen.findAllByTestId("shared-room-catch-up-citation")
    expect(mockHeadless).toHaveBeenCalledWith({ session: shared, label: "runLabel" })
    unmount()

    render(<SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m1" />)
    fireEvent.click(screen.getByTestId("shared-room-catch-up-run"))
    expect(await screen.findByRole("status")).toHaveTextContent("skipped.no-model")
  })

  it("says when the model fails, and offers to try again", async () => {
    mockUtility.mockReturnValue(
      client(async () => {
        throw new Error("down")
      })
    )
    render(<SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m1" />)
    fireEvent.click(screen.getByTestId("shared-room-catch-up-run"))
    expect(await screen.findByRole("status")).toHaveTextContent("failed")
    expect(screen.getByTestId("shared-room-catch-up-run")).toHaveTextContent("retry")
  })

  it("says when a cited message is no longer here", async () => {
    useChatViewportStore.getState().registerJumpToMessage(() => false)
    mockUtility.mockReturnValue(client("- Point. @msg:m2"))
    render(<SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m1" />)
    fireEvent.click(screen.getByTestId("shared-room-catch-up-run"))
    fireEvent.click(await screen.findByTestId("shared-room-catch-up-citation"))
    expect(screen.getByRole("status")).toHaveTextContent("citationMissing")
  })

  it("draws nothing outside a shared room, for too little, or once dismissed", () => {
    mockSession = { id: "plain" } as ChatSession
    const { container, rerender } = render(
      <SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m1" />
    )
    expect(container).toBeEmptyDOMElement()
    mockSession = shared
    rerender(<SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m3" />)
    expect(container).toBeEmptyDOMElement()
    rerender(<SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m1" />)
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }))
    expect(container).toBeEmptyDOMElement()
  })

  it("answers in the reader's language", async () => {
    mockLocale = "zh-CN"
    const llm = client("- 要点。@msg:m1")
    mockUtility.mockReturnValue(llm)
    render(<SharedRoomCatchUpCard sessionId="local" messages={messages} firstUnreadId="m1" />)
    fireEvent.click(screen.getByTestId("shared-room-catch-up-run"))
    await waitFor(() => expect(llm.complete).toHaveBeenCalled())
    expect(llm.complete.mock.calls[0][1]?.system).toContain("Write in 简体中文.")
    expect(catchUpLanguage("en-US")).toBe("English")
  })
})
