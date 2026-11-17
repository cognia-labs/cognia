"use client"

/**
 * Remote Session Control — mobile session detail view.
 *
 * Live view of one desktop-hosted agent session: streams assistant turns via
 * `useRemoteSessionStream`, renders a tool-use approval card when the host
 * routes one here, and (when this device holds the remote-control capability)
 * mounts `RemoteSessionComposer` to send follow-ups, attach files, and
 * interrupt.
 *
 * Three tabs, because a transcript answers "what was said" and not "what
 * happened to the code". Changes reads the host's task-workspace patch set;
 * Tests reads verification counts off the synced run snapshot. Both are
 * read-only, and the approval card and composer stay mounted across all three
 * — an approval blocks the session, not the tab.
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useRemoteSessionStream } from "@/hooks/data/use-remote-session-stream"
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import { RemoteSessionComposer } from "./remote-session-composer"
import { CONNECTION_STATE_META } from "@/components/mobile/connection-state-badge"
import { cn } from "@/lib/utils"
import { ApprovalCard } from "./approval-card"
import { SessionChangesPanel } from "./session-changes-panel"
import { SessionTestsPanel } from "./session-tests-panel"
import { TranscriptTimelineSurface } from "@/components/chat/transcript-timeline-surface"
import { useTranscriptController } from "@/hooks/chat/use-transcript-controller"
import { useTranscriptLiveTurn } from "@/hooks/chat/use-transcript-live-turn"
import { SessionMediaProvider } from "@/hooks/chat/session-media-provider"
import { lastUserMessageOf, withLiveTurn } from "@/lib/chat/transcript/live-turn-view"
import { hostStateMessageBranchNegotiatedIn } from "@/lib/db/mobile-outbound-queue"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { createRemoteTranscriptSource } from "@/lib/chat/transcript/source"
import { transport } from "@/lib/tauri"
import { onTransportChange } from "@/lib/tauri/transport-instance"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"
import { getSession } from "@/lib/db/sessions"
import { MessageRenderProvider } from "@/components/chat/message-render-context"
import { MessageActionSheet } from "@/components/mobile/chat/message-action-sheet"
import { RefusedHostMessages } from "@/components/chat/refused-host-messages"
import { useRefusedHostMessages } from "@/hooks/chat/use-refused-host-messages"
import { useStableCharacterById } from "@/hooks/data/use-stable-character-by-id"
import { useCharacter, useCharacters } from "@/lib/data-hooks/context"
import type { MessageActionCommandId } from "@/lib/chat/message-action-commands"
import type { MessageRenderContextValue } from "@/lib/chat/message-render-context"
import { withoutRefusedHostMessages } from "@/lib/chat/refused-host-message"
import { useCompanionFusionRuns } from "@/components/router-fusion/companion/use-companion-fusion-runs"
import { CompanionFusionRunList } from "@/components/router-fusion/companion/companion-fusion-run-view"

// Resolved per call: a browser that pairs after this module loaded swaps the
// transport, and a captured instance would keep reading the pre-pairing stub.
const remoteTranscriptSource = createRemoteTranscriptSource(() => transport, { onTransportChange })

/**
 * The row commands this view can carry out. The transcript is the Host's, so
 * anything that writes it locally (branch, truncate, restore point, quote or
 * reply into the local composer, save as memory or issue against a local
 * session) is left out.
 */
const REMOTE_MESSAGE_COMMANDS: ReadonlySet<MessageActionCommandId> = new Set<MessageActionCommandId>(
  ["copy", "share", "shareCard", "bookmark", "readAloud", "selectText"]
)

/**
 * With a Host that branches a turn for this device (`HostStateMessageBranch`):
 * edit, resend and regenerate run there, keeping what they replace as siblings.
 */
const REMOTE_BRANCH_COMMANDS: ReadonlySet<MessageActionCommandId> = new Set<MessageActionCommandId>(
  [...REMOTE_MESSAGE_COMMANDS, "edit", "resend", "regenerate"]
)

export interface RemoteSessionDetailProps {
  sessionId: string
}

export function RemoteSessionDetail({ sessionId }: RemoteSessionDetailProps) {
  const t = useTranslations("mobile.remoteSessions.detail")
  const tc = useTranslations("mobile.connectionState")
  const tFusion = useTranslations("routerFusionCompanion")
  // Router + Fusion runs from this device (ADR-0188 D25). `available` is the
  // host's own answer: its companion switch, and this device's grant.
  const fusion = useCompanionFusionRuns(sessionId)
  const session = useLiveQuery(() => getSession(sessionId), [sessionId])
  const tCopy = useTranslations("chat.copy")
  const messageDisplay = useMessageDisplay(session?.messageDisplayOverride)
  const transcript = useTranscriptController(sessionId, remoteTranscriptSource)
  const characterById = useStableCharacterById(useCharacters())
  const directCharacter = useCharacter(session?.characterId) ?? null
  const onCopy = useCallback(() => {
    toast.success(tCopy("success"))
  }, [tCopy])
  // Sends the Host refused stay on this device, beside the transcript.
  const refused = useRefusedHostMessages(sessionId)
  const timelineItems = useMemo(
    () => withoutRefusedHostMessages(transcript.snapshot.items, refused.hiddenIds),
    [transcript.snapshot.items, refused.hiddenIds]
  )
  const {
    messages,
    status,
    pendingApproval,
    canControl,
    attachDowngrade,
    sessionEnded,
    notFound,
    send,
    regenerate,
    editResend,
    interrupt,
    respond,
    reconcileTranscript,
  } = useRemoteSessionStream(sessionId)
  // A member agent's reply arrives live from the person brain (P6e), never
  // through this device's stream: draw it in place of the timeline's older
  // copy. The stream's own unfinished turn wins over the timeline's copy of
  // it the same way, so an in-flight turn is drawn once.
  const liveReply = useTranscriptLiveTurn(
    sessionId,
    remoteTranscriptSource,
    transcript.snapshot.revision
  )
  const view = useMemo(
    () => withLiveTurn({ items: timelineItems, tail: messages, live: liveReply }),
    [timelineItems, messages, liveReply]
  )
  const liveStatus = liveReply?.state === "streaming" ? "streaming" : status
  // D10: the rows read the same characters, copy feedback and display
  // settings as the chat, and a long press opens the message's sheet with the
  // commands this view can carry out. Edit and regenerate are the Host's to
  // run, as branches, so they are offered only by a Host that takes them and
  // only while this device controls the conversation.
  const runtimeSnapshot = useRuntimeSnapshot()
  const branchOffered =
    hostStateMessageBranchNegotiatedIn(runtimeSnapshot) &&
    canControl &&
    !sessionEnded &&
    !notFound
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  const onRegenerate = useCallback(async () => {
    const question = lastUserMessageOf(viewRef.current)
    if (question) await regenerate(question)
  }, [regenerate])
  const renderContext = useMemo<MessageRenderContextValue>(
    () => ({
      characterById,
      directCharacter,
      onCopy,
      messageDisplay,
      actionSheet: MessageActionSheet,
      allowedCommands: branchOffered ? REMOTE_BRANCH_COMMANDS : REMOTE_MESSAGE_COMMANDS,
      ...(branchOffered ? { onRegenerate, onEditResend: editResend } : {}),
    }),
    [
      characterById,
      directCharacter,
      onCopy,
      messageDisplay,
      branchOffered,
      onRegenerate,
      editResend,
    ]
  )
  const reconciledRevisionRef = useRef<number | null>(null)
  const connection = useConnectionState()
  // Sends can't reach the desktop while the transport is down — gate the
  // composer so the user gets an explicit hint instead of a silent failure.
  const offlineLike = connection === "offline" || connection === "reconnecting"
  const composable = canControl && !sessionEnded && !notFound

  useEffect(() => {
    if (transcript.snapshot.mode !== "timeline" || transcript.snapshot.revision === null) return
    if (reconciledRevisionRef.current === transcript.snapshot.revision) return
    reconciledRevisionRef.current = transcript.snapshot.revision
    reconcileTranscript()
  }, [reconcileTranscript, transcript.snapshot.mode, transcript.snapshot.revision])

  return (
    <div className="flex h-full flex-col" data-testid="remote-session-detail">
      {/* Wraps: the connection pill plus "Observe only — remote control is
          off for this device" is wider than a phone, and neither could shrink,
          so the header ran off the right edge. */}
      <div
        className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b px-4 py-2"
        data-testid="remote-session-header"
      >
        <span className="text-sm font-medium">{t("title")}</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {connection ? (
            <Badge
              variant="outline"
              data-testid="remote-connection-pill"
              data-state={connection}
              className={cn(
                "font-mono text-2xs uppercase",
                CONNECTION_STATE_META[connection].tone
              )}
            >
              {tc(CONNECTION_STATE_META[connection].labelKey)}
            </Badge>
          ) : null}
          {sessionEnded ? (
            <Badge variant="outline" data-testid="remote-ended-badge">
              {t("endedBadge")}
            </Badge>
          ) : status === "streaming" ? (
            <Badge variant="secondary" data-testid="remote-streaming-badge">
              {t("streaming")}
            </Badge>
          ) : null}
          {!canControl && !notFound ? (
            // Say *why* it is read-only. The two reasons need different actions
            // from the user: a missing grant stays until someone turns remote
            // control on for this device, while a stream that has not caught up
            // clears itself on reconnect.
            <Badge
              variant="outline"
              className="max-w-full whitespace-normal text-left"
              data-testid="remote-observe-only"
            >
              {attachDowngrade === "missing-capability"
                ? t("observeOnlyMissingGrant")
                : attachDowngrade === "event-plane-not-ready"
                  ? t("observeOnlyReconnecting")
                  : t("observeOnly")}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {notFound ? (
          <p
            className="flex-1 p-4 text-xs text-muted-foreground"
            data-testid="remote-session-not-found"
          >
            {t("notFound")}
          </p>
        ) : (
          <Tabs defaultValue="transcript" className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList className="mx-3 mt-2 shrink-0" data-testid="remote-session-tabs">
              <TabsTrigger value="transcript">{t("tabs.transcript")}</TabsTrigger>
              <TabsTrigger value="changes">{t("tabs.changes")}</TabsTrigger>
              <TabsTrigger value="tests">{t("tabs.tests")}</TabsTrigger>
            </TabsList>

            {/* Radix unmounts an inactive tab, so neither panel below issues a
                single RPC or Dexie read until someone actually opens it. */}
            <TabsContent value="transcript" className="flex min-h-0 flex-1 flex-col">
              {transcript.snapshot.mode === "timeline" ? (
          transcript.snapshot.items.length === 0 && view.liveMessages.length === 0 && !transcript.snapshot.loading ? (
            <p className="flex-1 p-4 text-xs text-muted-foreground">{t("empty")}</p>
          ) : (
            <SessionMediaProvider sessionId={sessionId} transport={transport}>
              <MessageRenderProvider value={renderContext}>
              <TranscriptTimelineSurface
                sessionId={sessionId}
                items={view.items}
                expandedTurnKeys={transcript.snapshot.expandedTurnKeys}
                getDetail={transcript.getDetail}
                onPageTurn={(turnKey, direction) => void transcript.pageTurn(turnKey, direction)}
                loadingTurnKeys={transcript.snapshot.loadingTurnKeys}
                onExpand={(turnKey, revision, detailRevision) => {
                  void transcript.expandTurn(turnKey, revision, detailRevision)
                }}
                onCollapse={transcript.collapseTurn}
                onLoadOlder={() => void transcript.loadOlder()}
                onRetry={() => void transcript.retry()}
                hasMore={transcript.snapshot.hasMore}
                loading={transcript.snapshot.loading}
                loadingOlder={transcript.snapshot.loadingOlder}
                error={transcript.snapshot.error}
                liveMessages={view.liveMessages}
                liveStatus={liveStatus}
                labels={{
                  expand: t("expandTurn"),
                  collapse: t("collapseTurn"),
                  loadingOlder: t("loadingOlder"),
                  loading: t("loadingTranscript"),
                  retry: t("retryTranscript"),
                }}
              />
              <RefusedHostMessages messages={refused.messages} />
              </MessageRenderProvider>
            </SessionMediaProvider>
          )
              ) : (
                <p className="flex-1 p-4 text-xs text-muted-foreground">{t("loadingTranscript")}</p>
              )}
            </TabsContent>

            <TabsContent value="changes" className="min-h-0 flex-1">
              <SessionChangesPanel sessionId={sessionId} />
            </TabsContent>

            <TabsContent value="tests" className="min-h-0 flex-1">
              <SessionTestsPanel sessionId={sessionId} />
            </TabsContent>
          </Tabs>
        )}

        {/* An observer still sees that the run is waiting on a decision, in
            the card's observe mode: arguments redacted, no buttons. Hiding it
            made a blocked run look idle to anyone without control. */}
        {pendingApproval && !sessionEnded && !notFound ? (
          <div className="shrink-0 p-4 pt-0">
            <ApprovalCard
              approval={pendingApproval}
              onRespond={respond}
              mode={composable ? "control" : "observe"}
            />
          </div>
        ) : null}

        {sessionEnded ? (
          <p
            className="shrink-0 px-4 pb-4 text-xs text-muted-foreground"
            data-testid="remote-session-ended"
          >
            {t("ended")}
          </p>
        ) : null}
      </div>

      <CompanionFusionRunList runs={fusion.runs} onDismiss={fusion.dismiss} />

      {composable ? (
        <RemoteSessionComposer
          sessionId={sessionId}
          streaming={status === "streaming"}
          offline={offlineLike}
          onSend={send}
          onInterrupt={() => void interrupt()}
          {...(fusion.available
            ? {
                onFusionRun: async (text: string, mode: "cascade" | "panel") => {
                  await fusion.start(
                    text,
                    mode,
                    tFusion("composer.queueLabel", { mode: tFusion(`picker.${mode}`) })
                  )
                },
              }
            : {})}
        />
      ) : null}
    </div>
  )
}
