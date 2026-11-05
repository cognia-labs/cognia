import { act, fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { ReplyToQuote } from "./reply-to-quote"
import { registerInlineLinkKind } from "@/lib/chat/inline-links"

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `t:${key}`,
}))

function seed(messages: UIMessage[]) {
  useChatStore.getState().clear()
  useChatStore.getState().setActiveSession("s1")
  useChatStore.getState().replaceSessionMessages("s1", messages)
}

beforeEach(() => {
  toastError.mockReset()
  useChatViewportStore.getState().registerJumpToMessage(null)
})

it("renders the stored preview as plain text when the target is not in the pane", () => {
  seed([])
  render(<ReplyToQuote replyTo={{ messageId: "gone", preview: "the plan" }} sessionId="s1" />)
  const quote = screen.getByTestId("reply-to-quote")
  expect(quote.tagName).toBe("DIV")
  expect(screen.getByTestId("reply-to-preview")).toHaveTextContent("the plan")
  expect(screen.queryByTestId("reply-to-speaker")).toBeNull()
})

it("names the target's speaker and jumps to it when the list can", () => {
  seed([
    {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
      metadata: { senderId: "c1", speakerLabel: "Reviewer" },
    } as unknown as UIMessage,
  ])
  const jump = jest.fn(() => true)
  useChatViewportStore.getState().registerJumpToMessage(jump)
  render(<ReplyToQuote replyTo={{ messageId: "m1", preview: "hi" }} sessionId="s1" />)
  const quote = screen.getByTestId("reply-to-quote")
  expect(quote.tagName).toBe("BUTTON")
  expect(screen.getByTestId("reply-to-speaker")).toBeInTheDocument()
  fireEvent.click(quote)
  expect(jump).toHaveBeenCalledWith("m1", undefined, { align: "center" })
  expect(toastError).not.toHaveBeenCalled()
})

it("tells the user when the jump could not resolve a row", () => {
  seed([{ id: "m1", role: "user", parts: [{ type: "text", text: "q" }] } as UIMessage])
  useChatViewportStore.getState().registerJumpToMessage(() => false)
  render(<ReplyToQuote replyTo={{ messageId: "m1", preview: "q" }} sessionId="s1" />)
  fireEvent.click(screen.getByTestId("reply-to-quote"))
  expect(toastError).toHaveBeenCalledWith("t:jumpFailed")
})

it("falls back to a placeholder for an empty preview", () => {
  seed([])
  render(<ReplyToQuote replyTo={{ messageId: "x", preview: "  " }} />)
  expect(screen.getByTestId("reply-to-preview")).toHaveTextContent("t:emptyPreview")
})

describe("in-app references in the quote", () => {
  let dispose: () => void
  beforeEach(() => {
    dispose = registerInlineLinkKind({
      id: "issue",
      pattern: /\b[A-Z]+-\d+\b/g,
      matches: () => true,
      href: (text) => `/issues?identifier=${text}`,
      parseHref: () => undefined,
      accepts: () => true,
    })
  })
  afterEach(() => act(() => dispose()))

  it("links them in a plain quote", () => {
    seed([])
    render(<ReplyToQuote replyTo={{ messageId: "gone", preview: "fix MERC-3" }} sessionId="s1" />)
    expect(screen.getByRole("link", { name: "MERC-3" })).toHaveAttribute(
      "href",
      "/issues?identifier=MERC-3"
    )
  })

  it("keeps them as text inside a quote that is a jump button", () => {
    seed([{ id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }] } as UIMessage])
    useChatViewportStore.getState().registerJumpToMessage(() => true)
    render(<ReplyToQuote replyTo={{ messageId: "m1", preview: "fix MERC-3" }} sessionId="s1" />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByTestId("reply-to-preview")).toHaveTextContent("fix MERC-3")
  })
})
