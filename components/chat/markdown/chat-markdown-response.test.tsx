import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

import { ChatMarkdownResponse } from "./chat-markdown-response"
import { resolveChatStreamdownConfig } from "./chat-streamdown-config"

const mockMessageResponse = jest.fn()
jest.mock("@/components/ai-elements/message", () => ({
  MessageResponse: (props: { children: ReactNode }) => {
    mockMessageResponse(props)
    return <div data-testid="response">{props.children}</div>
  },
}))
const display = { markdown: { math: true, codeWrap: true, mathAlign: "left" } }
jest.mock("@/hooks/chat/use-message-display", () => ({ useMessageDisplay: () => display }))
jest.mock("./chat-streamdown-config", () => {
  const actual = jest.requireActual("./chat-markdown-config")
  const configs = new Map<string, object>()
  return {
    resolveChatStreamdownConfig: (markdown: object) => {
      const key = JSON.stringify(markdown)
      if (!configs.has(key)) {
        configs.set(key, {
          config: actual.resolveChatMarkdownConfig(markdown),
          plugins: { chat: true },
          rehypePlugins: ["chat-rehype"],
          urlTransform: (url: string) => url,
          lineNumbers: false,
        })
      }
      return configs.get(key)
    },
  }
})
jest.mock("@/components/chat/streaming-text-part", () => ({
  createStreamingComponents: () => ({ a: "chat-link" }),
}))

beforeEach(() => mockMessageResponse.mockClear())

it("draws the text with the chat configuration and the user's knobs", () => {
  render(<ChatMarkdownResponse className="own">{"see \\[x\\]"}</ChatMarkdownResponse>)

  const streamdown = resolveChatStreamdownConfig(display.markdown as never)
  const props = mockMessageResponse.mock.calls.at(-1)?.[0]
  expect(props).toMatchObject({
    plugins: streamdown.plugins,
    rehypePlugins: streamdown.rehypePlugins,
    urlTransform: streamdown.urlTransform,
    lineNumbers: false,
    components: { a: "chat-link" },
    mode: "static",
    isAnimating: false,
  })
  // Its own typography stays; only the knob classes are added.
  expect(props.className).toContain("own")
  expect(props.className).toContain("chat-math-left")
  expect(props.className).not.toContain("typeset")
  expect(screen.getByTestId("response")).toHaveTextContent("see $$x$$")
})

it("streams while the text is still arriving", () => {
  render(<ChatMarkdownResponse isAnimating>partial</ChatMarkdownResponse>)
  expect(mockMessageResponse.mock.calls.at(-1)?.[0]).toMatchObject({
    mode: "streaming",
    isAnimating: true,
  })
})

it("draws with the knobs of the transcript it sits in (D10)", () => {
  const { MessageRenderProvider } = jest.requireActual(
    "@/components/chat/message-render-context"
  ) as typeof import("@/components/chat/message-render-context")
  const transcript = { markdown: { math: false } }
  render(
    <MessageRenderProvider value={{ messageDisplay: transcript as never }}>
      <ChatMarkdownResponse>{"see \\[x\\]"}</ChatMarkdownResponse>
    </MessageRenderProvider>
  )
  expect(mockMessageResponse.mock.calls.at(-1)?.[0].plugins).toBe(
    resolveChatStreamdownConfig(transcript.markdown as never).plugins
  )
  // Math is off in this transcript, so the delimiters are left alone.
  expect(screen.getByTestId("response")).toHaveTextContent("see \\[x\\]")
})
