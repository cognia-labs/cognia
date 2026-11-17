"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import type { TranscriptTurnDetail } from "@/lib/chat/transcript/controller"
import type {
  TranscriptMessage,
  TranscriptMessagePreview,
  TranscriptTimelineItem,
} from "@cognia/agent-config-types"

import { Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStickToBottom } from "@/hooks/chat/use-stick-to-bottom"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import { useSettingsStore } from "@/stores/settings"
import { PerfBoundary } from "@/lib/perf"
import type { TranscriptRenderStatus } from "./transcript-message-list"
import { MessageRenderer } from "./message-renderer"
import { MessageRenderProvider, useMessageRenderContext } from "./message-render-context"
import type {
  MessageMutationKind,
  MessageRenderContextValue,
} from "@/lib/chat/message-render-context"
import { LongPress } from "@/components/interactions/long-press"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { assistantAgentKey, hasMultipleAgentKeys } from "@/lib/chat/transcript-agents"
import { TranscriptAgentsProvider } from "@/components/chat/transcript-agents-context"
import { chatColumnClass } from "./chat-column"
import {
  TRANSCRIPT_ACTIVITY_METADATA_KEY,
  type TranscriptActivityStamp,
} from "@/lib/chat/transcript/turn-activity"

const scrollbarInsetOwners = new WeakMap<Element, symbol>()

export interface TranscriptTimelineLabels {
  expand: string
  collapse: string
  /** Shown while an older page loads; pages load as the reader scrolls up. */
  loadingOlder: string
  loading: string
  retry: string
}

export interface TranscriptTimelineSurfaceProps {
  sessionId: string
  items: TranscriptTimelineItem[]
  expandedTurnKeys: ReadonlySet<string>
  getDetail: (turnKey: string) => TranscriptTurnDetail | undefined
  onPageTurn?: (turnKey: string, direction: "previous" | "next") => void
  loadingTurnKeys?: ReadonlySet<string>
  onExpand: (turnKey: string, revision: number, detailRevision: number) => void
  onCollapse: (turnKey: string) => void
  onLoadOlder: () => void
  onRetry: () => void
  hasMore: boolean
  loading: boolean
  loadingOlder: boolean
  error: unknown | null
  liveMessages: UIMessage[]
  liveStatus: TranscriptRenderStatus
  labels: TranscriptTimelineLabels
}

function previewMessage(
  preview: TranscriptMessagePreview,
  sessionId: string,
  activity?: TranscriptActivityStamp
): UIMessage {
  const parts: UIMessage["parts"] = []
  if (preview.text) parts.push({ type: "text", text: preview.text })
  for (const media of preview.media ?? []) {
    parts.push({
      type: "file",
      url: media.ref,
      mediaType: media.mediaType ?? "application/octet-stream",
      ...(media.filename ? { filename: media.filename } : {}),
    })
  }
  return {
    id: preview.id,
    role: preview.role,
    parts,
    metadata: {
      sessionId,
      createdAt: preview.createdAt,
      ...(activity ? { [TRANSCRIPT_ACTIVITY_METADATA_KEY]: activity } : {}),
    },
  }
}

/**
 * The stamp that lets a folded turn's reply draw its fold row (D12), when the
 * Host summarised the turn's activity and the turn has a reply to carry it.
 */
function activityStampOf(
  item: Extract<TranscriptTimelineItem, { kind: "completed-turn" }>
): TranscriptActivityStamp | undefined {
  if (!item.activity || !item.finalResponse) return undefined
  return {
    activity: item.activity,
    turnKey: item.turnKey,
    revision: item.revision,
    detailRevision: item.detailRevision,
  }
}

/**
 * A Host message as the in-memory `UIMessage`, hoisting the same columns onto
 * `metadata` that `rowToUIMessage` does locally, so the renderer attributes a
 * team or shared-room message the same way on both sides.
 */
function fullMessage(message: TranscriptMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: {
      ...(message.metadata ?? {}),
      ...(message.senderId ? { senderId: message.senderId } : {}),
      ...(message.senderKind ? { senderKind: message.senderKind } : {}),
      ...(message.collaboration ? { collaboration: message.collaboration } : {}),
      sessionId: message.sessionId,
      createdAt: message.createdAt,
      ...(message.turnKey ? { turnKey: message.turnKey } : {}),
    },
  }
}

/** Rows that may be edited but not regenerated: history before the newest turn. */
const NO_REGENERATE: MessageRenderContextValue = {
  canMutate: (_messageId, kind) => kind !== "regenerate",
}
const UNCHANGED: MessageRenderContextValue = {}

/**
 * Where regenerate is allowed for a group of rows. Always the same provider,
 * so a group losing the permission (a live turn started below it) re-renders
 * its rows instead of remounting them, and only when there was a regenerate
 * to take away.
 */
function RegenerateScope({ allow, children }: { allow: boolean; children: ReactNode }) {
  const { onRegenerate } = useMessageRenderContext()
  return (
    <MessageRenderProvider value={!allow && onRegenerate ? NO_REGENERATE : UNCHANGED}>
      {children}
    </MessageRenderProvider>
  )
}

/** A long press on a row, and whether that row may be regenerated from the sheet. */
type RowLongPress = (message: UIMessage, options: { regenerate: boolean }) => void

function renderMessages(
  messages: UIMessage[],
  streaming = false,
  allowRegenerate = false,
  onLongPress?: RowLongPress
) {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.id
  const rows = messages.map((message, index) => {
    const isStreaming = streaming && index === messages.length - 1 && message.role === "assistant"
    const row = (
      <MessageRenderer
        key={message.id}
        message={message}
        isStreaming={isStreaming}
        isLastAssistant={message.id === lastAssistant}
      />
    )
    if (!onLongPress) return row
    return (
      <LongPress
        key={message.id}
        // A long press opens the message's sheet, so it must not also select a
        // word and raise the system's copy menu over it.
        className="select-none [-webkit-touch-callout:none]"
        onLongPress={() => {
          void selectionFeedback()
          onLongPress(message, {
            regenerate: allowRegenerate && !isStreaming && message.id === lastAssistant,
          })
        }}
      >
        {row}
      </LongPress>
    )
  })
  return <RegenerateScope allow={allowRegenerate}>{rows}</RegenerateScope>
}

function collapsedMessages(item: Extract<TranscriptTimelineItem, { kind: "completed-turn" }>) {
  const previews = [...item.userMessages]
  if (item.finalResponse) previews.push(item.finalResponse)
  if (item.visibleResult && item.visibleResult.id !== item.finalResponse?.id) {
    previews.push(item.visibleResult)
  }
  return previews
}

export function TranscriptTimelineSurface(props: TranscriptTimelineSurfaceProps) {
  const tTimeline = useTranslations("chat.timeline")
  const render = useMessageRenderContext()
  // The long-press sheet (phone shells, D10): which row it is open for, and
  // whether that row may be regenerated.
  const [sheet, setSheet] = useState<{ message: UIMessage; regenerate: boolean } | null>(null)
  const onLongPress = useCallback<RowLongPress>(
    (message, { regenerate }) => setSheet({ message, regenerate }),
    []
  )
  // A folded turn's fold row opens the turn (D12). Read through a ref so the
  // rows' context stays the same object while the caller's handler changes.
  const onExpandRef = useRef(props.onExpand)
  useIsomorphicLayoutEffect(() => {
    onExpandRef.current = props.onExpand
  })
  const expandContext = useMemo<MessageRenderContextValue>(
    () => ({
      expandTurn: (turnKey, revision, detailRevision) =>
        onExpandRef.current(turnKey, revision, detailRevision),
    }),
    []
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const stage = scroller?.closest<HTMLElement>('[data-slot="chat-surface-stage"]')
    if (!scroller || !stage) return
    const owner = Symbol()
    scrollbarInsetOwners.set(stage, owner)
    const measure = () => {
      if (scrollbarInsetOwners.get(stage) !== owner) return
      const style = getComputedStyle(scroller)
      const borders =
        (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0)
      // Use layout widths: an animated pane can scale its visual rectangle.
      const inset = Math.max(0, scroller.offsetWidth - scroller.clientWidth - borders)
      const value = `${inset}px`
      if (stage.style.getPropertyValue("--chat-native-scrollbar-inset") !== value) {
        stage.style.setProperty("--chat-native-scrollbar-inset", value)
      }
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(scroller)
    return () => {
      observer?.disconnect()
      // A departing transcript must not clear the replacement pane's inset.
      if (scrollbarInsetOwners.get(stage) !== owner) return
      scrollbarInsetOwners.delete(stage)
      stage.style.removeProperty("--chat-native-scrollbar-inset")
    }
  }, [props.sessionId])

  // The same scroll ownership as the local transcript (ADR-0138): open at the
  // latest turn, follow a live turn while the reader stays at the foot, and
  // let them read up without being dragged back down.
  const autoScrollOnStream = useSettingsStore(
    (state) => state.settings?.composerBehavior?.autoScrollOnStream
  )
  const live = props.liveStatus === "streaming" || props.liveStatus === "awaiting_approval"
  const {
    handleScroll: trackScrollPosition,
    handleContentClick,
    resetToBottom,
  } = useStickToBottom({
    scrollRef,
    contentRef,
    enabled: autoScrollOnStream !== false,
    active: live,
    pinKey: props.liveMessages,
  })
  // Rows exist to position. The rows component is keyed on this, so its
  // virtualizer is created when the first page lands and draws the newest
  // turns on its very first render (see `TimelineRows`).
  const ready = props.items.length > 0 || props.liveMessages.length > 0
  useIsomorphicLayoutEffect(() => {
    if (ready) resetToBottom()
  }, [ready, props.sessionId, resetToBottom])

  // Earlier turns load as the reader scrolls up to them — there is no button
  // to find. A page also loads while the history is too short to scroll at
  // all, since then there is no scrolling up to ask for it. A failed page
  // stops the loop and leaves the retry button below.
  const { hasMore, loadingOlder, loading, error, onLoadOlder } = props
  const requestOlder = useCallback(() => {
    if (!ready || !hasMore || loadingOlder || loading || error) return
    onLoadOlder()
  }, [error, hasMore, loading, loadingOlder, onLoadOlder, ready])
  const handleScroll = useCallback(() => {
    trackScrollPosition()
    const el = scrollRef.current
    if (el && el.scrollTop < el.clientHeight) requestOlder()
  }, [requestOlder, trackScrollPosition])
  useEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollHeight <= el.clientHeight + 1) requestOlder()
  }, [props.items, requestOlder])

  const newestCompletedItemKey = [...props.items]
    .reverse()
    .find((item) => item.kind === "completed-turn")?.itemKey
  // ADR-0218: collapsed turns carry only previews, so the projection stamps
  // `agentKey` on each final response; live turns are full messages.
  const multiAgent = useMemo(
    () =>
      hasMultipleAgentKeys([
        ...props.items.flatMap((item) =>
          item.kind === "completed-turn"
            ? [item.finalResponse?.agentKey]
            : item.kind === "active-turn"
              ? item.messages.map(assistantAgentKey)
              : []
        ),
        ...props.liveMessages.map(assistantAgentKey),
      ]),
    [props.items, props.liveMessages]
  )

  return (
    <TranscriptAgentsProvider multiAgent={multiAgent}>
      <PerfBoundary id="chat:transcript-timeline">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            role="log"
            aria-label={tTimeline("scrollConversation")}
            tabIndex={0}
            aria-busy={props.loading || props.liveStatus === "streaming"}
            data-session-id={props.sessionId}
            className="conversation-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
            onScroll={handleScroll}
          >
            <div
              ref={contentRef}
              onClickCapture={handleContentClick}
              className={`${chatColumnClass} py-5 sm:py-7`}
              data-slot="conversation-reading-column"
            >
              {props.error ? (
                <div className="pb-3">
                  <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
                    {props.labels.retry}
                  </Button>
                </div>
              ) : null}
              <MessageRenderProvider value={expandContext}>
                <TimelineRows
                  key={`${props.sessionId}:${ready ? "ready" : "empty"}`}
                  props={props}
                  scrollRef={scrollRef}
                  newestCompletedItemKey={newestCompletedItemKey}
                  onLongPress={render.actionSheet ? onLongPress : undefined}
                />
              </MessageRenderProvider>
            </div>
          </div>
          {/* Floating over the top edge, so a page arriving or failing moves
              nothing in the transcript; the virtualizer keeps the reader's
              place as the page is inserted above them. */}
          {props.loadingOlder ? (
            <div
              className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
              data-testid="transcript-loading-older"
            >
              <span
                role="status"
                className="flex items-center gap-1.5 rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
              >
                <Loader2Icon className="size-3 animate-spin" aria-hidden />
                {props.labels.loadingOlder}
              </span>
            </div>
          ) : null}
        </div>
        {render.actionSheet ? (
          <TimelineActionSheet sheet={sheet} idle={!live} onClose={() => setSheet(null)} />
        ) : null}
      </PerfBoundary>
    </TranscriptAgentsProvider>
  )
}

/**
 * The phone's long-press sheet for a timeline row: copy, select and read
 * aloud always; edit and regenerate where the transcript's `canMutate` allows
 * and no turn is in flight.
 */
function TimelineActionSheet({
  sheet,
  idle,
  onClose,
}: {
  sheet: { message: UIMessage; regenerate: boolean } | null
  idle: boolean
  onClose: () => void
}) {
  const render = useMessageRenderContext()
  const Sheet = render.actionSheet
  const message = sheet?.message ?? null
  const allows = (kind: MessageMutationKind) =>
    message !== null && (render.canMutate ? render.canMutate(message.id, kind) : true)
  const senderId = (message as { metadata?: { senderId?: string } } | null)?.metadata?.senderId
  const onEditResend = render.onEditResend
  if (!Sheet) return null
  return (
    <Sheet
      message={message}
      messageMotion={render.messageDisplay?.motion}
      // Same speaker resolution as the renderer: team sender first, then the
      // session's 1:1 character (the read-aloud voice).
      character={
        (senderId ? render.characterById?.get(senderId) : null) ?? render.directCharacter ?? null
      }
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      onRegenerate={
        render.onRegenerate && sheet?.regenerate && idle && allows("regenerate")
          ? render.onRegenerate
          : undefined
      }
      onEditResend={
        onEditResend && message?.role === "user" && idle && allows("edit")
          ? (target, text) => onEditResend(target.id, text)
          : undefined
      }
      allowedCommands={render.allowedCommands}
    />
  )
}

/**
 * The virtualized rows. Keyed by the parent on whether any row exists yet, so
 * the virtualizer is created with the first page in hand: `initialOffset` at
 * the foot then makes its first render draw the newest turns, where the
 * transcript opens, instead of drawing the oldest and correcting a frame later.
 */
function TimelineRows({
  props,
  scrollRef,
  newestCompletedItemKey,
  onLongPress,
}: {
  props: TranscriptTimelineSurfaceProps
  scrollRef: RefObject<HTMLDivElement | null>
  newestCompletedItemKey: string | undefined
  onLongPress?: RowLongPress
}) {
  const rowCount = props.items.length + (props.liveMessages.length > 0 ? 1 : 0)
  const getItemKey = useCallback(
    (index: number) => `${props.sessionId}:${props.items[index]?.itemKey ?? "active-live-turn"}`,
    [props.items, props.sessionId]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative measurement methods
  const virtualizer = useVirtualizer({
    count: rowCount,
    getItemKey,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 280,
    overscan: 4,
    measureElement: (element) => Math.round(element?.getBoundingClientRect().height ?? 0),
    initialOffset: () => Number.MAX_SAFE_INTEGER,
    // An older page lands ABOVE the reader: keep them on the turn they were
    // reading, corrected in the same render that adds the rows.
    anchorTo: "end",
  })
  const { messageDisplay } = useMessageRenderContext()
  useEffect(() => {
    if (typeof virtualizer.measure === "function") virtualizer.measure()
  }, [messageDisplay, virtualizer])

  return (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const item = props.items[virtualItem.index]
        const isLive = virtualItem.index === props.items.length
        return (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            {isLive ? (
              renderMessages(
                props.liveMessages,
                props.liveStatus === "streaming",
                true,
                onLongPress
              )
            ) : item ? (
              <TranscriptTimelineRow
                item={item}
                sessionId={props.sessionId}
                expanded={
                  item.kind === "completed-turn" && props.expandedTurnKeys.has(item.turnKey)
                }
                detail={
                  item.kind === "completed-turn" && props.expandedTurnKeys.has(item.turnKey)
                    ? props.getDetail(item.turnKey)
                    : undefined
                }
                onLongPress={onLongPress}
                allowRegenerate={
                  item.itemKey === newestCompletedItemKey && props.liveMessages.length === 0
                }
                labels={props.labels}
                onExpand={props.onExpand}
                onCollapse={props.onCollapse}
                onPageTurn={props.onPageTurn}
                loadingDetail={
                  item.kind === "completed-turn" &&
                  Boolean(props.loadingTurnKeys?.has(item.turnKey))
                }
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** Keep canonical message identities stable while adjacent rows stream or scroll. */
function TranscriptTimelineRow({
  item,
  sessionId,
  expanded,
  detail,
  onLongPress,
  allowRegenerate,
  labels,
  onExpand,
  onCollapse,
  onPageTurn,
  loadingDetail,
}: {
  item: TranscriptTimelineItem
  sessionId: string
  expanded: boolean
  detail?: TranscriptTurnDetail
  onLongPress?: RowLongPress
  allowRegenerate: boolean
  labels: TranscriptTimelineLabels
  onExpand: TranscriptTimelineSurfaceProps["onExpand"]
  onCollapse: TranscriptTimelineSurfaceProps["onCollapse"]
  onPageTurn?: TranscriptTimelineSurfaceProps["onPageTurn"]
  loadingDetail: boolean
}) {
  const t = useTranslations("chat.transcript")
  const messages = useMemo(() => {
    if (item.kind === "active-turn") return item.messages.map(fullMessage)
    if (item.kind === "system") return [previewMessage(item.message, sessionId)]
    if (detail) return detail.messages.map(fullMessage)
    const activity = activityStampOf(item)
    return collapsedMessages(item).map((message) =>
      previewMessage(message, sessionId, message === item.finalResponse ? activity : undefined)
    )
  }, [item, detail, sessionId])

  if (item.kind !== "completed-turn") {
    return renderMessages(messages, item.kind === "active-turn", false, onLongPress)
  }
  return (
    <div data-turn-key={item.turnKey}>
      {renderMessages(messages, false, allowRegenerate, onLongPress)}
      {expanded && !detail ? (
        <p className="py-2 text-xs text-muted-foreground">{labels.loading}</p>
      ) : null}
      {expanded && detail && onPageTurn && (detail.hasPrevious || detail.hasMore) ? (
        <div className="flex items-center gap-2 py-2" aria-busy={loadingDetail}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loadingDetail || !detail.hasPrevious}
            onClick={() => onPageTurn(item.turnKey, "previous")}
          >
            {t("previousDetails")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loadingDetail || !detail.hasMore}
            onClick={() => onPageTurn(item.turnKey, "next")}
          >
            {t("nextDetails")}
          </Button>
        </div>
      ) : null}
      {/* A reply carrying the turn's fold row opens the turn itself. */}
      {(item.collapsed.exists && !activityStampOf(item)) || detail ? (
        <div className="pb-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              expanded
                ? onCollapse(item.turnKey)
                : onExpand(item.turnKey, item.revision, item.detailRevision)
            }
          >
            {expanded ? labels.collapse : labels.expand}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
