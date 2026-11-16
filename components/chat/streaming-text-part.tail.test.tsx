// The trailing-block policy of the streaming branch (chat-surface overhaul D8,
// D9): ink on the tail only, off for long replies, large open fences on a timer.
import { act, render } from "@testing-library/react"
import type { ReactNode } from "react"
import type { BlockProps } from "streamdown"

const mockBlock = jest.fn()
jest.mock(
  "streamdown",
  () => ({
    Block: (props: { content: string }) => {
      mockBlock(props)
      return <div data-testid="streamdown-block">{props.content}</div>
    },
    parseMarkdownIntoBlocks: (markdown: string) =>
      markdown.split(/(\n\n+)/).filter((block) => block.length > 0),
  }),
  { virtual: true }
)

const mockMessageResponse = jest.fn()
jest.mock("@/components/ai-elements/message", () => ({
  MessageResponse: (props: { children: ReactNode }) => {
    mockMessageResponse(props)
    return <div data-testid="msg-response">{props.children}</div>
  },
}))

const flowMotion = { reduce: false, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))
jest.mock("./markdown-renderer", () => ({ MarkdownRenderer: () => null }))
jest.mock("./markdown/rendering-policy", () => ({
  chatMarkdownUrlTransform: (url: string) => url,
  chatStreamdownRehypePlugins: ["shared-rehype"],
}))

import { STREAMING_INK_ANIMATION, StreamingBlock, StreamingTextPart } from "./streaming-text-part"
import {
  FENCE_THROTTLE_MS,
  INK_REPLY_LIMIT,
  LARGE_FENCE_CHARS,
  TAIL_BLOCK_ATTR,
} from "./streaming-block-policy"

type Props = Record<string, unknown>
const lastResponseProps = () => mockMessageResponse.mock.calls.at(-1)?.[0] as Props
const lastBlockProps = () => mockBlock.mock.calls.at(-1)?.[0] as Props

beforeEach(() => {
  mockBlock.mockClear()
  mockMessageResponse.mockClear()
  flowMotion.reduce = false
})

describe("StreamingTextPart tail index", () => {
  it("passes the index of the reply's last block while ink runs", () => {
    render(<StreamingTextPart text={"one\n\ntwo\n\nthree"} isStreaming />)
    const props = lastResponseProps()
    expect(props.animated).toBe(STREAMING_INK_ANIMATION)
    // "one", "\n\n", "two", "\n\n", "three" under the stub parser.
    expect(props[TAIL_BLOCK_ATTR]).toBe(4)
  })

  it("turns ink off past the long-reply limit and under reduced motion", () => {
    const { rerender } = render(
      <StreamingTextPart text={"a".repeat(INK_REPLY_LIMIT + 1)} isStreaming />
    )
    expect(lastResponseProps().animated).toBe(false)
    expect(lastResponseProps()[TAIL_BLOCK_ATTR]).toBeUndefined()

    flowMotion.reduce = true
    rerender(<StreamingTextPart text="short" isStreaming />)
    expect(lastResponseProps().animated).toBe(false)
  })
})

describe("StreamingBlock", () => {
  const harden = () => undefined
  const animate = () => undefined
  const animatePlugin = { rehypePlugin: animate, commit: jest.fn() } as unknown as NonNullable<
    BlockProps["animatePlugin"]
  >
  // One list per block, as Streamdown passes it.
  const rehypePlugins = [harden, animate]
  const blockProps = (index: number, content = "prose"): BlockProps => ({
    animatePlugin,
    content,
    index,
    isIncomplete: false,
    rehypePlugins,
    shouldNormalizeHtmlIndentation: false,
    shouldParseIncompleteMarkdown: true,
  })

  it("renders a settled block without its animate plugin", () => {
    render(<StreamingBlock {...blockProps(0)} {...{ [TAIL_BLOCK_ATTR]: 2 }} />)
    const props = lastBlockProps()
    expect(props.animatePlugin).toBeNull()
    expect(props.rehypePlugins).toEqual([harden])
    // The tail index stays with the wrapper; Block never sees it.
    expect(props).not.toHaveProperty(TAIL_BLOCK_ATTR)
  })

  it("keeps the reveal on the tail block, and on every block without a tail index", () => {
    render(<StreamingBlock {...blockProps(2)} {...{ [TAIL_BLOCK_ATTR]: 2 }} />)
    expect(lastBlockProps().animatePlugin).toBe(animatePlugin)
    expect(lastBlockProps().rehypePlugins).toBe(rehypePlugins)

    render(<StreamingBlock {...blockProps(0)} />)
    expect(lastBlockProps().animatePlugin).toBe(animatePlugin)
  })

  it("drops a block's reveal once a new block starts after it", () => {
    const { rerender } = render(<StreamingBlock {...blockProps(1)} {...{ [TAIL_BLOCK_ATTR]: 1 }} />)
    expect(lastBlockProps().animatePlugin).toBe(animatePlugin)
    rerender(<StreamingBlock {...blockProps(1)} {...{ [TAIL_BLOCK_ATTR]: 3 }} />)
    expect(lastBlockProps().animatePlugin).toBeNull()
  })

  describe("large open fence", () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    const fence = (lines: number) => "```ts\n" + "const value = compute()\n".repeat(lines)
    const open = (content: string): BlockProps => ({
      ...blockProps(0, content),
      isIncomplete: true,
    })

    it("advances on a timer instead of on every delta, then shows all of it once closed", () => {
      const big = fence(Math.ceil(LARGE_FENCE_CHARS / 20))
      const { rerender } = render(<StreamingBlock {...open(big)} />)
      act(() => jest.advanceTimersByTime(0))
      expect(lastBlockProps().content).toBe(big)

      rerender(<StreamingBlock {...open(`${big}a`)} />)
      rerender(<StreamingBlock {...open(`${big}ab`)} />)
      expect(lastBlockProps().content).toBe(big)

      act(() => jest.advanceTimersByTime(FENCE_THROTTLE_MS))
      expect(lastBlockProps().content).toBe(`${big}ab`)

      const closed = `${big}ab\n\`\`\``
      rerender(<StreamingBlock {...blockProps(0, closed)} />)
      expect(lastBlockProps().content).toBe(closed)
    })

    it("streams a small open fence delta by delta", () => {
      const small = fence(3)
      const { rerender } = render(<StreamingBlock {...open(small)} />)
      rerender(<StreamingBlock {...open(`${small}a`)} />)
      expect(lastBlockProps().content).toBe(`${small}a`)
    })
  })
})
