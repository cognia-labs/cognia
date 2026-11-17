import { fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

import {
  TranscriptTimelineSurface,
  type TranscriptTimelineSurfaceProps,
} from "./transcript-timeline-surface"
import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"
import type { MessageRenderContextValue } from "@/lib/chat/message-render-context"
import { MessageRenderProvider } from "./message-render-context"

function providing(value: MessageRenderContextValue) {
  return function Providing({ children }: { children: React.ReactNode }) {
    return <MessageRenderProvider value={value}>{children}</MessageRenderProvider>
  }
}

const messageRenderMock = jest.fn()

jest.mock("./message-renderer", () => ({
  MessageRenderer: jest.requireActual("react").memo(function MessageRenderer(supplied: {
    message: UIMessage
    isLastAssistant?: boolean
  }) {
    // What the real renderer draws with: its props over the context (D10).
    const { useMessageRenderContext } = jest.requireActual(
      "./message-render-context"
    ) as typeof import("./message-render-context")
    const { resolveMessageRenderProps } = jest.requireActual(
      "@/lib/chat/message-render-context"
    ) as typeof import("@/lib/chat/message-render-context")
    const { message, onEditResend, onRegenerate, messageDisplay } = resolveMessageRenderProps(
      supplied,
      useMessageRenderContext()
    )
    messageRenderMock(message)
    // The real renderer draws the turn's fold row from this stamp (D12).
    const { transcriptActivityOf } = jest.requireActual(
      "@/lib/chat/transcript/turn-activity"
    ) as typeof import("@/lib/chat/transcript/turn-activity")
    const stamp = transcriptActivityOf(message)
    const { expandTurn } = useMessageRenderContext()
    return (
      <div
        data-testid={`message-${message.id}`}
        data-editable={Boolean(onEditResend)}
        data-regenerable={Boolean(onRegenerate)}
        data-preset={messageDisplay?.preset}
      >
        {stamp && expandTurn ? (
          <button
            type="button"
            onClick={() => expandTurn(stamp.turnKey, stamp.revision, stamp.detailRevision)}
          >
            {`fold ${stamp.activity.toolCount}`}
          </button>
        ) : null}
        {message.parts.map((part) => (part.type === "text" ? part.text : part.type))}
      </div>
    )
  }),
}))

jest.mock("@/components/interactions/long-press", () => ({
  LongPress: ({
    children,
    onLongPress,
  }: {
    children: React.ReactNode
    onLongPress: () => void
  }) => (
    <div>
      <button type="button" data-testid="long-press" onClick={onLongPress} />
      {children}
    </div>
  ),
}))
jest.mock("@/lib/capacitor/haptics", () => ({ selectionFeedback: jest.fn() }))
const sheetMock = jest.fn()
// The shell's sheet, handed to the surface through the context (D10).
function SheetStandIn(props: {
  allowedCommands?: ReadonlySet<string>
  message: UIMessage | null
  onRegenerate?: unknown
  onEditResend?: unknown
  character?: { name?: string } | null
}) {
  sheetMock(props)
  return props.message ? (
    <div
      data-testid="action-sheet"
      data-message={props.message.id}
      data-regenerate={Boolean(props.onRegenerate)}
      data-edit={Boolean(props.onEditResend)}
      data-character={props.character?.name}
      data-allowed={props.allowedCommands ? [...props.allowedCommands].join(",") : undefined}
    />
  ) : null
}

const virtualizerMeasureMock = jest.fn()
let latestItemKey: ((index: number) => string | number) | undefined
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number
    getItemKey?: (index: number) => string | number
    getScrollElement: () => Element | null
    estimateSize: () => number
    measureElement: (element?: Element) => number
  }) => {
    latestItemKey = options.getItemKey
    options.getScrollElement()
    options.estimateSize()
    options.measureElement()
    options.measureElement({ getBoundingClientRect: () => ({ height: 239.7 }) } as Element)
    return {
      getVirtualItems: () =>
        Array.from({ length: options.count }, (_, index) => ({
          index,
          key: options.getItemKey?.(index) ?? index,
          start: index * 240,
        })),
      getTotalSize: () => options.count * 240,
      measureElement: jest.fn(),
      measure: virtualizerMeasureMock,
    }
  },
}))

const labels = {
  expand: "Expand details",
  collapse: "Collapse details",
  loadingOlder: "Loading older",
  loading: "Loading",
  retry: "Retry",
}

describe("<TranscriptTimelineSurface />", () => {
  it("keeps measured scrollbar insets current and owned by each pane", () => {
    const originalObserver = globalThis.ResizeObserver
    const callbacks: Array<() => void> = []
    const insets: Record<string, number> = { first: 8, replacement: 17, other: 17 }
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(() => callback([], this as unknown as ResizeObserver))
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    const width = jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(707)
    const client = jest
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return 707 - (insets[this.dataset.sessionId ?? ""] ?? 0)
      })
    const base: TranscriptTimelineSurfaceProps = {
      sessionId: "first",
      items: [],
      expandedTurnKeys: new Set(),
      getDetail: () => undefined,
      onExpand: jest.fn(),
      onCollapse: jest.fn(),
      onLoadOlder: jest.fn(),
      onRetry: jest.fn(),
      hasMore: false,
      loading: false,
      loadingOlder: false,
      error: null,
      liveMessages: [],
      liveStatus: "idle",
      labels,
    }
    const tree = (first: boolean, replacement: boolean, other: boolean) => (
      <>
        <div data-slot="chat-surface-stage" data-testid="pane-a">
          {first && <TranscriptTimelineSurface key="first" {...base} />}
          {replacement && (
            <TranscriptTimelineSurface key="replacement" {...base} sessionId="replacement" />
          )}
        </div>
        <div data-slot="chat-surface-stage" data-testid="pane-b">
          {other && <TranscriptTimelineSurface {...base} sessionId="other" />}
        </div>
      </>
    )
    const view = render(tree(true, false, true))
    try {
      const firstPane = screen.getByTestId("pane-a")
      const otherPane = screen.getByTestId("pane-b")
      const inset = (element: HTMLElement) =>
        element.style.getPropertyValue("--chat-native-scrollbar-inset")
      expect(inset(firstPane)).toBe("8px")
      expect(inset(otherPane)).toBe("17px")
      insets.first = 0
      callbacks.forEach((callback) => callback())
      expect(inset(firstPane)).toBe("0px")
      expect(inset(otherPane)).toBe("17px")
      view.rerender(tree(true, true, true))
      expect(inset(firstPane)).toBe("17px")
      view.rerender(tree(false, true, true))
      callbacks.forEach((callback) => callback())
      expect(inset(firstPane)).toBe("17px")
      view.rerender(tree(false, false, false))
      callbacks.forEach((callback) => callback())
      expect(inset(firstPane)).toBe("")
      expect(inset(otherPane)).toBe("")
    } finally {
      view.unmount()
      width.mockRestore()
      client.mockRestore()
      globalThis.ResizeObserver = originalObserver
    }
  })
  it("does not rerender settled messages when only the live tail changes", () => {
    const props: TranscriptTimelineSurfaceProps = {
      sessionId: "stream-session",
      items: [
        {
          kind: "system",
          itemKey: "system:history",
          revision: 1,
          startedAt: 1,
          status: "completed",
          message: { id: "history", role: "system", text: "Historical notice", createdAt: 1 },
        },
      ],
      expandedTurnKeys: new Set(),
      getDetail: () => undefined,
      onExpand: jest.fn(),
      onCollapse: jest.fn(),
      onLoadOlder: jest.fn(),
      onRetry: jest.fn(),
      hasMore: false,
      loading: false,
      loadingOlder: false,
      error: null,
      liveMessages: [{ id: "live", role: "assistant", parts: [{ type: "text", text: "A" }] }],
      liveStatus: "streaming",
      labels,
    }
    const { rerender } = render(<TranscriptTimelineSurface {...props} />)
    const log = screen.getByRole("log")
    expect(log).toHaveClass("conversation-scroll")
    expect(log).toHaveAttribute("tabindex", "0")
    expect(log).toHaveAccessibleName()
    expect(screen.queryByRole("scrollbar")).not.toBeInTheDocument()
    messageRenderMock.mockClear()
    rerender(
      <TranscriptTimelineSurface
        {...props}
        liveMessages={[{ id: "live", role: "assistant", parts: [{ type: "text", text: "AB" }] }]}
      />
    )
    expect(screen.getByTestId("message-live")).toHaveTextContent("AB")
    expect(messageRenderMock.mock.calls.map(([message]) => message.id)).toEqual(["live"])
    const historyKey = latestItemKey!(0)
    const newItem = {
      ...props.items[0],
      itemKey: "system:older",
      kind: "system" as const,
      status: "completed" as const,
      message: { id: "older", role: "system" as const, text: "Older notice", createdAt: 0 },
    }
    rerender(<TranscriptTimelineSurface {...props} items={[newItem, ...props.items]} />)
    expect(latestItemKey!(1)).toBe(historyKey)
    expect(screen.getAllByTestId(/^message-/).map((element) => element.textContent)).toEqual([
      "Older notice",
      "Historical notice",
      "A",
    ])
    rerender(<TranscriptTimelineSurface {...props} sessionId="other-session" />)
    expect(latestItemKey!(0)).not.toBe(historyKey)
    expect(messageRenderMock.mock.calls.at(-2)?.[0].metadata.sessionId).toBe("other-session")
  })

  it("refreshes summaries and loaded details without caching stale content or controls", () => {
    const item = {
      kind: "completed-turn" as const,
      itemKey: "turn:u1",
      turnKey: "turn:u1",
      revision: 1,
      detailRevision: 1,
      status: "completed" as const,
      userMessages: [{ id: "u1", role: "user" as const, text: "Question", createdAt: 1 }],
      finalResponse: { id: "a1", role: "assistant" as const, text: "Summary", createdAt: 2 },
      visibleResult: { id: "result", role: "assistant" as const, text: "Result", createdAt: 3 },
      collapsed: { exists: true, messageCount: 3, trailingCount: 1, mediaCount: 0 },
      startedAt: 1,
    }
    const props: TranscriptTimelineSurfaceProps = {
      sessionId: "s1",
      items: [item],
      expandedTurnKeys: new Set(),
      getDetail: () => undefined,
      onExpand: jest.fn(),
      onCollapse: jest.fn(),
      onLoadOlder: jest.fn(),
      onRetry: jest.fn(),
      hasMore: true,
      loading: false,
      loadingOlder: false,
      error: new Error("offline"),
      liveMessages: [],
      liveStatus: "idle",
      labels,
    }
    const { rerender } = render(<TranscriptTimelineSurface {...props} />)
    const streaming = {
      liveMessages: [
        { id: "live", role: "assistant" as const, parts: [{ type: "text" as const, text: "A" }] },
      ],
      liveStatus: "streaming" as const,
    }
    messageRenderMock.mockClear()
    rerender(<TranscriptTimelineSurface {...props} {...streaming} />)
    expect(messageRenderMock.mock.calls.map(([message]) => message.id)).toEqual(["live"])
    expect(screen.getAllByTestId(/^message-/).map((element) => element.textContent)).toEqual([
      "Question",
      "Summary",
      "Result",
      "A",
    ])
    const column = document.querySelector('[data-slot="conversation-reading-column"]')
    expect(column).toHaveClass("mx-auto", "max-w-[52rem]", "px-3", "sm:px-5")
    for (const message of screen.getAllByTestId(/^message-/)) {
      expect(column).toContainElement(message)
    }
    expect(screen.getByRole("button", { name: labels.retry }).parentElement).not.toHaveClass(
      "px-3",
      "sm:px-5"
    )
    fireEvent.click(screen.getByRole("button", { name: labels.retry }))
    // A failed page stops automatic loading; the retry button is the way on.
    expect(props.onLoadOlder).not.toHaveBeenCalled()
    expect(props.onRetry).toHaveBeenCalledTimes(1)
    rerender(
      <TranscriptTimelineSurface
        {...props}
        items={[
          { ...item, revision: 2, finalResponse: { ...item.finalResponse, text: "Revised" } },
        ]}
        expandedTurnKeys={new Set([item.turnKey])}
      />
    )
    expect(screen.getByTestId("message-a1")).toHaveTextContent("Revised")
    expect(screen.getByText(labels.loading)).toBeVisible()
    const detail = {
      messages: [
        {
          id: "a1",
          sessionId: "s1",
          turnKey: item.turnKey,
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: "Full answer" }],
          createdAt: 2,
          metadata: { test: true },
        },
      ],
      revision: 2,
      detailRevision: 2,
      total: 1,
      approximateBytes: 100,
      hasMore: false,
    }
    rerender(
      <MessageRenderProvider value={{ onEditResend: jest.fn() }}>
        <TranscriptTimelineSurface
          {...props}
          expandedTurnKeys={new Set([item.turnKey])}
          getDetail={() => detail}
          loadingOlder
        />
      </MessageRenderProvider>
    )
    expect(screen.getByTestId("message-a1")).toHaveTextContent("Full answer")
    expect(screen.getByTestId("message-a1")).toHaveAttribute("data-editable", "true")
    // An older page in flight floats a status over the top edge.
    expect(screen.getByTestId("transcript-loading-older")).toHaveTextContent(labels.loadingOlder)
    fireEvent.click(screen.getByRole("button", { name: labels.collapse }))
    expect(props.onCollapse).toHaveBeenCalledWith(item.turnKey)
    const expandedProps = {
      ...props,
      expandedTurnKeys: new Set([item.turnKey]),
      getDetail: () => detail,
    }
    rerender(<TranscriptTimelineSurface {...expandedProps} />)
    messageRenderMock.mockClear()
    rerender(<TranscriptTimelineSurface {...expandedProps} {...streaming} />)
    expect(messageRenderMock.mock.calls.map(([message]) => message.id)).toEqual(["live"])
    expect(screen.getByTestId("message-a1")).toHaveTextContent("Full answer")
    const onPageTurn = jest.fn()
    const pagedProps = {
      ...expandedProps,
      onPageTurn,
      getDetail: () => ({ ...detail, hasPrevious: true, hasMore: true, nextCursor: "next" }),
    }
    rerender(<TranscriptTimelineSurface {...pagedProps} />)
    fireEvent.click(screen.getByRole("button", { name: "Previous messages" }))
    fireEvent.click(screen.getByRole("button", { name: "Next messages" }))
    expect(onPageTurn.mock.calls).toEqual([
      [item.turnKey, "previous"],
      [item.turnKey, "next"],
    ])
    rerender(
      <TranscriptTimelineSurface {...pagedProps} loadingTurnKeys={new Set([item.turnKey])} />
    )
    expect(screen.getByRole("button", { name: "Previous messages" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Next messages" })).toBeDisabled()
    expect(screen.getByTestId("message-a1")).toHaveTextContent("Full answer")
  })

  it("hands expanded Host messages to the renderer with their author, as local rows are", () => {
    const item = {
      kind: "completed-turn" as const,
      itemKey: "t1",
      turnKey: "t1",
      revision: 1,
      detailRevision: 1,
      status: "completed" as const,
      userMessages: [{ id: "u1", role: "user" as const, text: "Question", createdAt: 1 }],
      collapsed: { exists: true, messageCount: 2, trailingCount: 0, mediaCount: 0 },
      startedAt: 1,
    }
    const author = { kind: "human" as const, id: "person-b", displayName: "Bea" }
    const detail = {
      messages: [
        {
          id: "u1",
          sessionId: "s1",
          turnKey: "t1",
          role: "user" as const,
          parts: [{ type: "text" as const, text: "Question" }],
          collaboration: { author, sourceEventId: "e1", eventSequence: 1, version: 1 },
          createdAt: 1,
        },
        {
          id: "a1",
          sessionId: "s1",
          turnKey: "t1",
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: "Answer" }],
          senderId: "char-1",
          senderKind: "assistant" as const,
          metadata: { model: "m" },
          createdAt: 2,
        },
      ],
      revision: 1,
      detailRevision: 1,
      total: 2,
      approximateBytes: 100,
      hasMore: false,
    }
    messageRenderMock.mockClear()
    render(
      <TranscriptTimelineSurface
        sessionId="s1"
        items={[item]}
        expandedTurnKeys={new Set(["t1"])}
        getDetail={() => detail}
        onExpand={jest.fn()}
        onCollapse={jest.fn()}
        onLoadOlder={jest.fn()}
        onRetry={jest.fn()}
        hasMore={false}
        loading={false}
        loadingOlder={false}
        error={null}
        liveMessages={[]}
        liveStatus="idle"
        labels={labels}
      />
    )
    const rendered = new Map(
      messageRenderMock.mock.calls.map(([message]) => [message.id, message.metadata])
    )
    // The speaker resolver and the team-member lookup read these off metadata.
    expect(rendered.get("u1")).toMatchObject({ collaboration: { author } })
    expect(rendered.get("a1")).toMatchObject({
      senderId: "char-1",
      senderKind: "assistant",
      model: "m",
      turnKey: "t1",
    })
  })

  it("renders a folded turn through MessageRenderer and expands lazily", () => {
    const onExpand = jest.fn()
    render(
      <TranscriptTimelineSurface
        sessionId="s1"
        items={[
          {
            kind: "completed-turn",
            itemKey: "turn:u1",
            turnKey: "turn:u1",
            revision: 2,
            detailRevision: 2,
            status: "completed",
            userMessages: [{ id: "u1", role: "user", text: "question", createdAt: 1 }],
            finalResponse: { id: "a1", role: "assistant", text: "answer", createdAt: 2 },
            collapsed: { exists: true, messageCount: 3, trailingCount: 1, mediaCount: 0 },
            startedAt: 1,
            completedAt: 2,
          },
        ]}
        expandedTurnKeys={new Set()}
        getDetail={() => undefined}
        onExpand={onExpand}
        onCollapse={jest.fn()}
        onLoadOlder={jest.fn()}
        onRetry={jest.fn()}
        hasMore={false}
        loading={false}
        loadingOlder={false}
        error={null}
        liveMessages={[]}
        liveStatus="idle"
        labels={labels}
      />
    )

    expect(screen.getByTestId("message-u1")).toHaveTextContent("question")
    expect(screen.getByTestId("message-a1")).toHaveTextContent("answer")
    fireEvent.click(screen.getByRole("button", { name: "Expand details" }))
    expect(onExpand).toHaveBeenCalledWith("turn:u1", 2, 2)
  })

  it("hands a folded turn's activity to its reply, whose fold row opens the turn (D12)", () => {
    const onExpand = jest.fn()
    const items: TranscriptTimelineSurfaceProps["items"] = [
      {
        kind: "completed-turn",
        itemKey: "turn:u1",
        turnKey: "turn:u1",
        revision: 4,
        detailRevision: 7,
        status: "completed",
        userMessages: [{ id: "u1", role: "user", text: "question", createdAt: 1 }],
        finalResponse: { id: "a1", role: "assistant", text: "answer", createdAt: 2 },
        collapsed: { exists: true, messageCount: 2, trailingCount: 0, mediaCount: 0 },
        activity: {
          toolCount: 3,
          failedCount: 0,
          reasoningCount: 1,
          sourceCount: 0,
          tools: [{ name: "Bash", count: 3, failed: 0 }],
        },
        startedAt: 1,
        completedAt: 2,
      },
    ]
    const expanded = new Set<string>()
    const surface = (onExpandHandler: jest.Mock) => (
      <TranscriptTimelineSurface
        sessionId="s1"
        items={items}
        expandedTurnKeys={expanded}
        getDetail={() => undefined}
        onExpand={onExpandHandler}
        onCollapse={jest.fn()}
        onLoadOlder={jest.fn()}
        onRetry={jest.fn()}
        hasMore={false}
        loading={false}
        loadingOlder={false}
        error={null}
        liveMessages={[]}
        liveStatus="idle"
        labels={labels}
      />
    )
    const view = render(surface(onExpand))

    // The user's preview carries no stamp; the reply carries the fold row,
    // which replaces the generic expand button.
    expect(screen.getByTestId("message-u1")).not.toHaveTextContent("fold")
    expect(screen.queryByRole("button", { name: "Expand details" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "fold 3" }))
    expect(onExpand).toHaveBeenCalledWith("turn:u1", 4, 7)

    // A new handler from the caller is used without re-rendering the rows.
    const rendersBefore = messageRenderMock.mock.calls.length
    const next = jest.fn()
    view.rerender(surface(next))
    expect(messageRenderMock.mock.calls.length).toBe(rendersBefore)
    fireEvent.click(screen.getByRole("button", { name: "fold 3" }))
    expect(next).toHaveBeenCalledWith("turn:u1", 4, 7)
  })

  it("renders fetched detail and the active live lane without merging them into timeline state", () => {
    render(
      <TranscriptTimelineSurface
        sessionId="s1"
        items={[]}
        expandedTurnKeys={new Set(["turn:u1"])}
        getDetail={() => undefined}
        onExpand={jest.fn()}
        onCollapse={jest.fn()}
        onLoadOlder={jest.fn()}
        onRetry={jest.fn()}
        hasMore={false}
        loading={false}
        loadingOlder={false}
        error={null}
        liveMessages={[
          { id: "live", role: "assistant", parts: [{ type: "text", text: "stream" }] },
        ]}
        liveStatus="streaming"
        labels={labels}
      />,
      {
        wrapper: providing({
          messageDisplay: resolveMessageDisplayOptions({ preset: "inspector" }),
        }),
      }
    )

    expect(screen.getByTestId("message-live")).toHaveTextContent("stream")
    expect(screen.getByTestId("message-live")).toHaveAttribute("data-preset", "inspector")
    expect(virtualizerMeasureMock).toHaveBeenCalled()
  })

  it("does not expose mutation controls for summary rows outside the writable window", () => {
    render(
      <TranscriptTimelineSurface
        sessionId="s1"
        items={[
          {
            kind: "completed-turn",
            itemKey: "turn:u1",
            turnKey: "turn:u1",
            revision: 1,
            detailRevision: 1,
            status: "completed",
            userMessages: [{ id: "u1", role: "user", text: "old", createdAt: 1 }],
            finalResponse: { id: "a1", role: "assistant", text: "done", createdAt: 2 },
            collapsed: { exists: false, messageCount: 2, trailingCount: 0, mediaCount: 0 },
            startedAt: 1,
            completedAt: 2,
          },
        ]}
        expandedTurnKeys={new Set()}
        getDetail={() => undefined}
        onExpand={jest.fn()}
        onCollapse={jest.fn()}
        onLoadOlder={jest.fn()}
        onRetry={jest.fn()}
        hasMore={false}
        loading={false}
        loadingOlder={false}
        error={null}
        liveMessages={[]}
        liveStatus="idle"
        labels={labels}
      />,
      { wrapper: providing({ onEditResend: jest.fn(), canMutate: () => false }) }
    )

    expect(screen.getByTestId("message-u1")).toHaveAttribute("data-editable", "false")
  })

  describe("the message render context (D10)", () => {
    const turn = (n: number) => ({
      kind: "completed-turn" as const,
      itemKey: `turn:${n}`,
      turnKey: `turn:${n}`,
      revision: 1,
      detailRevision: 1,
      status: "completed" as const,
      userMessages: [{ id: `u${n}`, role: "user" as const, text: `ask ${n}`, createdAt: n }],
      finalResponse: { id: `a${n}`, role: "assistant" as const, text: `answer ${n}`, createdAt: n },
      collapsed: { exists: false, messageCount: 2, trailingCount: 0, mediaCount: 0 },
      startedAt: n,
      completedAt: n,
    })
    const surface = (
      overrides: Partial<TranscriptTimelineSurfaceProps> = {}
    ): TranscriptTimelineSurfaceProps => ({
      sessionId: "s1",
      items: [turn(1), turn(2)],
      expandedTurnKeys: new Set(),
      getDetail: () => undefined,
      onExpand: jest.fn(),
      onCollapse: jest.fn(),
      onLoadOlder: jest.fn(),
      onRetry: jest.fn(),
      hasMore: false,
      loading: false,
      loadingOlder: false,
      error: null,
      liveMessages: [],
      liveStatus: "idle",
      labels,
      ...overrides,
    })

    it("offers regenerate on the newest turn only, edit on every writable row", () => {
      render(<TranscriptTimelineSurface {...surface()} />, {
        wrapper: providing({ onRegenerate: jest.fn(), onEditResend: jest.fn() }),
      })
      expect(screen.getByTestId("message-a1")).toHaveAttribute("data-regenerable", "false")
      expect(screen.getByTestId("message-a2")).toHaveAttribute("data-regenerable", "true")
      expect(screen.getByTestId("message-u1")).toHaveAttribute("data-editable", "true")
    })

    it("narrows regenerate inside the caller's own canMutate", () => {
      render(<TranscriptTimelineSurface {...surface()} />, {
        wrapper: providing({
          onRegenerate: jest.fn(),
          canMutate: (messageId) => messageId !== "a2",
        }),
      })
      expect(screen.getByTestId("message-a2")).toHaveAttribute("data-regenerable", "false")
    })

    it("draws no long-press affordance unless the host opens a sheet", () => {
      render(<TranscriptTimelineSurface {...surface()} />)
      expect(screen.queryByTestId("long-press")).toBeNull()
      expect(sheetMock).not.toHaveBeenCalled()
    })

    it("opens the row's sheet on a long press, with the actions that row allows", () => {
      const host = { id: "char_host", name: "Host agent", systemPrompt: "" }
      render(<TranscriptTimelineSurface {...surface()} />, {
        wrapper: providing({
          actionSheet: SheetStandIn,
          directCharacter: host as never,
          onRegenerate: jest.fn(),
          onEditResend: jest.fn(),
        }),
      })
      const presses = screen.getAllByTestId("long-press")
      // u1, a1, u2, a2
      fireEvent.click(presses[3])
      expect(screen.getByTestId("action-sheet")).toHaveAttribute("data-message", "a2")
      expect(screen.getByTestId("action-sheet")).toHaveAttribute("data-regenerate", "true")
      expect(screen.getByTestId("action-sheet")).toHaveAttribute("data-character", "Host agent")

      fireEvent.click(presses[1])
      expect(screen.getByTestId("action-sheet")).toHaveAttribute("data-message", "a1")
      expect(screen.getByTestId("action-sheet")).toHaveAttribute("data-regenerate", "false")

      fireEvent.click(presses[0])
      expect(screen.getByTestId("action-sheet")).toHaveAttribute("data-edit", "true")
    })

    it("hands the sheet the commands the surface allows", () => {
      render(<TranscriptTimelineSurface {...surface()} />, {
        wrapper: providing({ actionSheet: SheetStandIn, allowedCommands: new Set(["copy"]) }),
      })
      fireEvent.click(screen.getAllByTestId("long-press")[0])
      expect(screen.getByTestId("action-sheet")).toHaveAttribute("data-allowed", "copy")
    })

    it("offers neither edit nor regenerate from the sheet while a turn is live", () => {
      render(
        <TranscriptTimelineSurface
          {...surface({
            liveMessages: [{ id: "live", role: "assistant", parts: [{ type: "text", text: "…" }] }],
            liveStatus: "streaming",
          })}
        />,
        {
          wrapper: providing({
            actionSheet: SheetStandIn,
            onRegenerate: jest.fn(),
            onEditResend: jest.fn(),
          }),
        }
      )
      fireEvent.click(screen.getAllByTestId("long-press")[0])
      expect(screen.getByTestId("action-sheet")).toHaveAttribute("data-edit", "false")
      expect(screen.getByTestId("action-sheet")).toHaveAttribute("data-regenerate", "false")
    })
  })

  describe("loading earlier turns", () => {
    const notice = (key: string, text: string) => ({
      kind: "system" as const,
      itemKey: key,
      revision: 1,
      startedAt: 1,
      status: "completed" as const,
      message: { id: key, role: "system" as const, text, createdAt: 1 },
    })
    const base = (): TranscriptTimelineSurfaceProps => ({
      sessionId: "s1",
      items: [notice("n1", "First")],
      expandedTurnKeys: new Set(),
      getDetail: () => undefined,
      onExpand: jest.fn(),
      onCollapse: jest.fn(),
      onLoadOlder: jest.fn(),
      onRetry: jest.fn(),
      hasMore: true,
      loading: false,
      loadingOlder: false,
      error: null,
      liveMessages: [],
      liveStatus: "idle",
      labels,
    })
    const tallScroller = (top: number) => {
      const log = screen.getByRole("log")
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 600 })
      Object.defineProperty(log, "scrollHeight", { configurable: true, value: 5000 })
      Object.defineProperty(log, "scrollTop", { configurable: true, writable: true, value: top })
      return log
    }

    it("loads a page by itself while the history is too short to scroll", () => {
      const props = base()
      render(<TranscriptTimelineSurface {...props} />)
      // jsdom lays nothing out: the scroller reports no overflow.
      expect(props.onLoadOlder).toHaveBeenCalled()
      expect(screen.queryByRole("button", { name: /older/i })).toBeNull()
    })

    it("does not load before any turn is here, after the last page, or mid-load", () => {
      for (const override of [
        { items: [] },
        { hasMore: false },
        { loadingOlder: true },
        { loading: true },
      ] as Partial<TranscriptTimelineSurfaceProps>[]) {
        const props = { ...base(), ...override }
        const view = render(<TranscriptTimelineSurface {...props} />)
        expect(props.onLoadOlder).not.toHaveBeenCalled()
        view.unmount()
      }
    })

    it("loads when the reader scrolls up near the top, not while reading lower down", () => {
      const props = { ...base(), hasMore: false }
      const { rerender } = render(<TranscriptTimelineSurface {...props} />)
      const withMore = { ...props, hasMore: true }
      const log = tallScroller(3000)
      rerender(<TranscriptTimelineSurface {...withMore} />)
      // The fill check sees a scroller that overflows: nothing to do yet.
      expect(withMore.onLoadOlder).not.toHaveBeenCalled()
      fireEvent.scroll(log)
      expect(withMore.onLoadOlder).not.toHaveBeenCalled()
      log.scrollTop = 200
      fireEvent.scroll(log)
      expect(withMore.onLoadOlder).toHaveBeenCalledTimes(1)
    })
  })
})
