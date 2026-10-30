"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import type { TranscriptTurnDetail } from "@/lib/chat/transcript/controller"
import type {
  Character,
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
import type { RewindFilesResult } from "@/lib/claude/ipc"
import type { ResolvedMessageDisplayOptions } from "@/lib/chat/message-display"
import { assistantAgentKey, hasMultipleAgentKeys } from "@/lib/chat/transcript-agents"
import { TranscriptAgentsProvider } from "@/components/chat/transcript-agents-context"
import { chatColumnClass } from "./chat-column"

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
  renderAdapters?: {
    characterById?: Map<string, Character>
    directCharacter?: Character | null
    onCopy?: () => void
    onRegenerate?: () => void | Promise<void>
    onEditResend?: (messageId: string, newText: string) => void | Promise<void>
    onRewindFiles?: (
      sessionId: string,
      checkpointId: string,
      dryRun: boolean
    ) => Promise<RewindFilesResult>
    projectRoot?: string | null
    /** Mutations are exposed only for rows present in the caller's writable window. */
    mutableMessageIds?: ReadonlySet<string>
    messageDisplay?: ResolvedMessageDisplayOptions
  }
}

function previewMessage(preview: TranscriptMessagePreview, sessionId: string): UIMessage {
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
    metadata: { sessionId, createdAt: preview.createdAt },
  }
}

function fullMessage(message: TranscriptMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: {
      ...(message.metadata ?? {}),
      sessionId: message.sessionId,
      createdAt: message.createdAt,
      ...(message.turnKey ? { turnKey: message.turnKey } : {}),
    },
  }
}

function renderMessages(
  messages: UIMessage[],
  streaming = false,
  adapters?: TranscriptTimelineSurfaceProps["renderAdapters"],
  allowRegenerate = false
) {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.id
  return messages.map((message, index) => (
    <MessageRenderer
      key={message.id}
      message={message}
      isStreaming={streaming && index === messages.length - 1 && message.role === "assistant"}
      isLastAssistant={message.id === lastAssistant}
      characterById={adapters?.characterById}
      directCharacter={adapters?.directCharacter}
      onCopy={adapters?.onCopy}
      onRegenerate={
        allowRegenerate &&
        (!adapters?.mutableMessageIds || adapters.mutableMessageIds.has(message.id))
          ? adapters?.onRegenerate
          : undefined
      }
      onEditResend={
        !adapters?.mutableMessageIds || adapters.mutableMessageIds.has(message.id)
          ? adapters?.onEditResend
          : undefined
      }
      onRewindFiles={adapters?.onRewindFiles}
      projectRoot={adapters?.projectRoot}
      messageDisplay={adapters?.messageDisplay}
    />
  ))
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
              <TimelineRows
                key={`${props.sessionId}:${ready ? "ready" : "empty"}`}
                props={props}
                scrollRef={scrollRef}
                newestCompletedItemKey={newestCompletedItemKey}
              />
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
      </PerfBoundary>
    </TranscriptAgentsProvider>
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
}: {
  props: TranscriptTimelineSurfaceProps
  scrollRef: RefObject<HTMLDivElement | null>
  newestCompletedItemKey: string | undefined
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
  useEffect(() => {
    if (typeof virtualizer.measure === "function") virtualizer.measure()
  }, [props.renderAdapters?.messageDisplay, virtualizer])

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
                props.renderAdapters,
                true
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
                adapters={props.renderAdapters}
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
  adapters,
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
  adapters: TranscriptTimelineSurfaceProps["renderAdapters"]
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
    return (
      detail?.messages.map(fullMessage) ??
      collapsedMessages(item).map((message) => previewMessage(message, sessionId))
    )
  }, [item, detail, sessionId])

  if (item.kind !== "completed-turn") {
    return renderMessages(messages, item.kind === "active-turn", adapters)
  }
  return (
    <div data-turn-key={item.turnKey}>
      {renderMessages(messages, false, adapters, allowRegenerate)}
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
      {item.collapsed.exists || detail ? (
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
