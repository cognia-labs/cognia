"use client"

import { CreatedDocumentAction } from "./message-parts/created-document-action"
import { ChatDocumentSessionContext } from "./markdown/chat-link-options"
import { useTranscriptSessionId } from "./transcript-session-context"
import { REMOTE_DOC_PART_KEY } from "@/lib/chat/attachments/remote-document"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ai-elements/message"
import { Reasoning } from "@/components/ai-elements/reasoning"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { MessageMetaLine, MessageShell } from "@/components/chat/message-shell"
import { UserMessageBody } from "@/components/chat/user-message-body"
import type { MarkdownMention } from "@/components/chat/markdown/markdown-plugins"
import { resolveMessageRenderProps } from "@/lib/chat/message-render-context"
import {
  MessageRenderProvider,
  useMessageRenderContext,
} from "@/components/chat/message-render-context"
import { ReasoningToolRow } from "@/components/chat/message-parts/reasoning-part"
import { resolveChatStreamdownConfig } from "@/components/chat/markdown/chat-streamdown-config"
import {
  FINALIZED_MARKDOWN_LAZY_THRESHOLD,
  FinalizedLongTextPart,
  StreamingTextPart,
  createStreamingComponents,
} from "@/components/chat/streaming-text-part"
import { A2UIPart } from "@/components/chat/message-parts/a2ui-part"
import { AsyncQuestionsCard } from "@/components/chat/message-parts/async-questions-card"
import { InboundA2UIRenderer } from "@/components/chat/message-parts/inbound-a2ui-renderer"
import { messagePlatformAvatarTarget } from "@/lib/connectors/platform-avatar"
import { usePlatformAvatar } from "@/hooks/connectors/use-platform-avatar"
import {
  inboundA2UIBlockCoversParts,
  sanitizeInboundA2UIBlock,
} from "@/lib/connectors/adapters/_shared/inbound-a2ui-normalize"
import { preserveLineBreaks } from "@/lib/connectors/adapters/_shared/inbound-markdown"
import { InboundLabelChips } from "@/components/chat/message-parts/inbound-label-chips"
import { SubagentTree } from "@/components/chat/message-parts/subagent-tree"
import { AgentTeamDispatchPart } from "@/components/chat/message-parts/agent-team-dispatch-part"
import { SquadRunPart } from "@/components/chat/message-parts/squad-run-part"
import { SquadGatePart } from "@/components/chat/message-parts/squad-gate-part"
import { VerificationVerdictPart } from "@/components/chat/message-parts/verification-verdict-part"
import { ArtifactPart } from "@/components/chat/message-parts/artifact-part"
import { SourcesPart } from "@/components/chat/message-parts/sources-part"
import { GroundingPart } from "@/components/chat/message-parts/grounding-part"
import { TerminalToolPart } from "@/components/chat/message-parts/terminal-tool-part"
import { FileToolPart, isFileToolPart } from "@/components/chat/message-parts/file-tool-part"
import { StructuredToolPart } from "@/components/chat/message-parts/structured-tool-part"
import { isBashToolPart } from "@/components/chat/message-parts/tool-detail-body"
import { CanvasInlinePart } from "@/components/chat/message-parts/canvas-inline-part"
import { FilePartCard } from "@/components/chat/message-parts/file-part-preview"
import { AttachmentTextCard } from "@/components/chat/message-parts/attachment-text-card"
import { AttachmentSourceActions } from "@/components/chat/message-parts/attachment-source-actions"
import { readAttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import {
  MessageImageGallery,
  type MessageImageGalleryProps,
} from "@/components/chat/renderers/message-image-gallery"
import {
  collectMessageVideoAttachments,
  MessageVideoAttachmentCard,
} from "@/components/chat/renderers/message-video-attachment-card"
import { MessageImageCollectionProvider } from "@/components/chat/renderers/message-image-collection"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { UnknownPartCard } from "@/components/chat/message-parts/unknown-part-card"
import { SHARED_WITHHELD_PART_TYPE } from "@/lib/collab/shared-withheld-part"
import {
  HookNoticeRow,
  type HookNoticePartData,
} from "@/components/chat/message-parts/hook-notice-part"
import { DiagnosticsCard } from "@/components/chat/message-parts/diagnostics-card"
import { SlashCommandResultChip } from "@/components/chat/message-parts/slash-command-result-chip"
import { VideoJobView } from "@/components/chat/video-generation/video-job-view"
import { ShellJobView } from "@/components/chat/shell-job/shell-job-view"
import { toolNameOf } from "@/components/chat/message-parts/mcp-tool-card"
import { VIDEO_GENERATE_TOOL_NAME } from "@/lib/media/agent-tools"
import {
  DIAGNOSTICS_PART_TYPE,
  isSystemMessageBlock,
  isShellJobBlock,
  isSlashCommandResultBlock,
  isVideoJobBlock,
  type SystemMessageBlock,
} from "@/lib/slash-commands/system-blocks"
import { ToolCallRow } from "@/components/chat/message-parts/tool-call-row"
import { ToolUseSummaryPart } from "@/components/chat/message-parts/tool-use-summary-part"
import {
  ToolActivityGroup,
  type ToolActivityChildOptions,
  type ToolActivityGroupEntry,
} from "@/components/chat/message-parts/tool-activity-group"
import { TurnProcessFold } from "@/components/chat/message-parts/turn-process-fold"
import { TurnChangesCard } from "@/components/chat/turn-changes-card"
import { RestorePointDialog } from "@/components/chat/restore-point-dialog"
import { EntranceMotionProvider, MotionReveal } from "@/components/chat/motion/motion-reveal"
import { disclosureKey as rememberedDisclosureKey } from "@/lib/chat/disclosure-memory"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"
import {
  groupAgentParts,
  isToolOnlyFlow,
  type AgentFlowSegment,
  isToolPartType,
  SILENT_CONTROL_PART_TYPES,
} from "@/lib/chat/agent-flow-grouping"
import { foldTurnParts, type TurnFold } from "@/lib/chat/turn-fold"
import { userBubbleClass } from "@/lib/chat/message-bubble"
import { readReplyTo } from "@/lib/chat/reply-to"
import { ReplyToQuote } from "@/components/chat/message-parts/reply-to-quote"
import { PromptPreambleCard } from "@/components/chat/message-parts/prompt-preamble-card"
import { locatePromptPreamble, readPromptPreambleSummary } from "@/lib/chat/prompt-preamble"
import { MessageReactionAdd, MessageReactionPills } from "@/components/chat/message-reactions"
import type { AgentFlowMode } from "@/types/appearance"
import type { ResolvedMessageDisplayOptions } from "@/lib/chat/message-display"
import { BranchNavigator } from "@/components/chat/branch-navigator"
import { BranchPointMarker } from "@/components/chat/branch-children-chip"
import { TriggerBadge } from "@/components/chat/trigger-badge"
import { MemoryLearnedChip, MemoryRecalledChip } from "@/components/chat/memory-chips"
import {
  isAgentTeamDispatchPart,
  isSourcesPart,
  isSquadGatePart,
  isSquadRunPart,
  isToolUseSummaryPart,
} from "@/lib/chat/parts-extensions"
import type {
  A2UIPart as A2UIPartType,
  VerificationVerdictPart as VerificationVerdictPartType,
  ArtifactPart as ArtifactPartType,
  CanvasInlinePart as CanvasInlinePartType,
  GroundingPart as GroundingPartType,
  SourcesPart as SourcesPartType,
} from "@/lib/chat/parts-extensions"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import {
  LinkIcon,
  CornerUpLeftIcon,
  GitBranchIcon,
  HistoryIcon,
  ScissorsIcon,
  ImageIcon,
  PencilIcon,
  BrainIcon,
  CircleDotIcon,
  RefreshCcwIcon,
  Repeat2Icon,
  SendHorizontalIcon,
  Share2Icon,
  MoreHorizontalIcon,
  QuoteIcon,
  ReplyIcon,
  ListChecksIcon,
  BookmarkIcon,
} from "lucide-react"
import { BookmarkIcon as AnimatedBookmarkIcon } from "@/components/ui/bookmark"
import { useEditYieldsToOtherSurfaces } from "@/hooks/chat/use-edit-yields-to-other-surfaces"
import { CheckIcon as AnimatedCheckIcon } from "@/components/ui/check"
import { QuoteCardDialog } from "@/components/share/quote-card-dialog"
import { toast } from "sonner"
import type { ToolUIPart, UIMessage } from "ai"
import type { UsageInfo } from "@/lib/chat/sdk-message-adapter"
import { UsageBreakdown } from "@/components/chat/usage-breakdown"
import type { Character } from "@cognia/agent-config-types"
import React, {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { buildMessagePermalink } from "@/lib/chat/message-permalink"
import { cn } from "@/lib/utils"
import { avatarColor, deterministicColor, type AvatarSubject } from "@/lib/ui/avatar"
import { resolveMessageSpeaker, type SpeakerSource } from "@/lib/chat/speaker"
import { A2UIAgentCatalogProvider } from "@/components/a2ui/a2ui-agent-catalog"
import { runMetadataOf } from "@/lib/chat/message-run-metadata"
import { useMemberStatus } from "@/stores/ui"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { ReadAloudButton } from "./read-aloud-button"
import { TaskUpdateRow } from "@/components/tasks/task-update-row"
import { COPY_FEEDBACK_MS, useCopy } from "@/hooks/ui/use-copy"
import { useShowKeyboardHints } from "@/hooks/ui/use-pointer"
import {
  buildMessageShareContent,
  copyMessageContent,
  messageTypedText,
  shareMessageContent,
} from "@/lib/chat/message-share"
import {
  messageActionCommandsAt,
  resolveMessageActionCommands,
  type MessageActionCommand,
} from "@/lib/chat/message-action-commands"
import { loggers } from "@cognia/logging"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import {
  MessagePluginMenuItems,
  useMessagePluginItems,
} from "@/components/chat/message-plugin-menu"
import { useMessageCommands } from "@/components/chat/use-message-commands"
import { MessageImActions } from "@/components/chat/message-im-actions"
import { BranchDialog } from "@/components/chat/branch-dialog"
import { TruncateFromDialog } from "@/components/chat/truncate-from-dialog"
import { SteerStatusBadge } from "@/components/chat/message-parts/steer-status-badge"
import { TurnAdmissionBadge } from "@/components/chat/message-parts/turn-admission-badge"
import { SessionPeerOriginBadge } from "@/components/chat/session-peer-origin-badge"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { dispatchComposerAppend } from "@/components/chat/composer"
import { useTranscriptSelectionHost } from "@/hooks/chat/use-transcript-selection"
import {
  getMessagePartRenderer,
  subscribeMessagePartRenderers,
  getMessagePartRenderersRevision,
} from "@/lib/plugin/api/message-part-renderers"
import {
  getToolResultRenderer,
  subscribeToolResultRenderers,
  getToolResultRenderersRevision,
} from "@/lib/plugin/api/tool-result-renderers"
import { useSyncExternalStore } from "react"
import { PerfBoundary } from "@/lib/perf"
import { useAgentFileAutoFollow } from "@/hooks/agent/use-agent-file-auto-follow"
import { CheckpointAction } from "@/components/chat/checkpoint-action"
import type { RewindFilesResult } from "@/lib/ai/agent/execution/sidecar-client"

/**
 * Reveal policy for a control group that is hidden until hover.
 *
 * Hover alone is not a reveal path on a touch device — where this app ships
 * through Capacitor — and it leaves keyboard focus sitting on a control the
 * user cannot see. Every hover-revealed group in the repo pairs `group-hover`
 * with `focus-within` and `pointer-coarse` for exactly that reason
 * (code-block, mermaid-block, math-block, image-block, video-block); this
 * constant is that triple for the message surface, shared so the three groups
 * here cannot drift apart. The strings, not the DOM, are what is shared: two of
 * the three only render once a plugin contributes to them.
 *
 * A fourth reveal covers the case hover and focus both lie about: a Radix
 * popup opened from inside the group (the "…" overflow, a plugin menu). Its
 * content portals out, so the pointer sits over the menu and focus lives in
 * it — neither `group-hover` nor `focus-within` holds, and the group would
 * fade away under the open popup. The trigger keeps `data-state="open"` while
 * its popup is up, so `:has` on that keeps the group revealed for exactly the
 * popup's lifetime.
 */
export const HOVER_REVEAL_CLASS =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 has-[[data-state=open]]:opacity-100 group-has-[[data-state=open]]:opacity-100"

interface Props {
  message: UIMessage
  /** True when this is the most recent assistant message and we're still streaming. */
  isStreaming?: boolean
  /** True when this is the most recent assistant message in the list. */
  isLastAssistant?: boolean
  /**
   * The host opens a long-press action sheet for this row (the phone shell's
   * `MessageActionSheet`), which carries every action the inline bar does.
   * In the hover-revealed modes there is no hover on touch, so the bar would
   * otherwise sit under every message permanently; with a sheet it keeps only
   * the latest settled reply's bar, the way phone chat apps do, and every
   * other row reaches its actions by long-press.
   */
  actionSheetHost?: boolean
  /** Lookup table for resolving senderId → Character (team sessions). */
  characterById?: Map<string, Character>
  /**
   * The session-bound character in a 1:1 (direct) chat. Used as the read-aloud
   * voice when the message has no `senderId` (i.e. not a team message).
   */
  directCharacter?: Character | null
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
  onRewindFiles?: (
    sessionId: string,
    checkpointId: string,
    dryRun: boolean
  ) => Promise<RewindFilesResult>
  /** Root used to resolve project-relative links in assistant Markdown. */
  projectRoot?: string | null
  /** Resolved once by the owning transcript when available. */
  messageDisplay?: ResolvedMessageDisplayOptions
}

function usePluginPartRegistryRevision(): number {
  return useSyncExternalStore(
    subscribeMessagePartRenderers,
    getMessagePartRenderersRevision,
    getMessagePartRenderersRevision
  )
}

/**
 * Re-render the message when a plugin registers / unregisters a TOOL-RESULT
 * renderer. Separate from the part registry above because the tool branch is
 * chosen by `isStructuredMcpToolPart` during render — without this, enabling a
 * plugin mid-session would leave already-rendered tool calls on the generic
 * card forever.
 */
function usePluginToolRendererRevision(): number {
  return useSyncExternalStore(
    subscribeToolResultRenderers,
    getToolResultRenderersRevision,
    getToolResultRenderersRevision
  )
}

/** True when every part a render segment draws sits inside the turn's fold. */
function isSegmentFolded(segment: AgentFlowSegment<unknown>, fold: TurnFold): boolean {
  return segment.kind === "single"
    ? fold.folded.has(segment.entry.index)
    : segment.entries.every((entry) => fold.folded.has(entry.index))
}

function MessageRendererInner({
  message: suppliedMessage,
  isStreaming = false,
  isLastAssistant = false,
  actionSheetHost = false,
  characterById,
  directCharacter,
  onCopy,
  onRegenerate,
  onEditResend,
  onRewindFiles,
  projectRoot,
  messageDisplay,
}: Props & { messageDisplay: ResolvedMessageDisplayOptions }) {
  const tActivity = useTranslations("inbox.activity.kind")
  // The commands this surface can carry out, when it supports only some (D10).
  const { allowedCommands } = useMessageRenderContext()
  const isWithdrawn =
    (suppliedMessage as { metadata?: Record<string, unknown> }).metadata?.deletedAt !== undefined
  const message = useMemo(() => {
    const metadata = (suppliedMessage as { metadata?: Record<string, unknown> }).metadata
    if (metadata?.deletedAt === undefined) return suppliedMessage
    const { inboundA2UI: _rich, inboundLabels: _labels, replyTo: _reply, ...kept } = metadata
    return {
      ...suppliedMessage,
      parts: [{ type: "text", text: tActivity("inboundDeleted") }],
      metadata: kept,
    } as UIMessage
  }, [suppliedMessage, tActivity])
  useAgentFileAutoFollow({ parts: message.parts, isStreaming, projectRoot })
  // Re-render when a plugin registers / unregisters a message-part renderer.
  usePluginPartRegistryRevision()
  // ...and likewise for tool-result cards.
  usePluginToolRendererRevision()
  const t = useTranslations("chat.message")
  // "Send (⌘/Ctrl+Enter)" names keys a phone does not have.
  const showKeyboardHints = useShowKeyboardHints()
  // Agent invocation-flow display mode (simplified / standard / detailed).
  const display = messageDisplay
  // `all` is an explicit choice to see every bar, so a sheet does not thin it.
  const inlineActionBar =
    !actionSheetHost ||
    display.actions === "all" ||
    (message.role === "assistant" && isLastAssistant && !isStreaming)
  const agentFlowMode: AgentFlowMode = display.agentFlowMode
  // Read-aloud is gated on the global TTS toggle; the selector keeps this
  // re-render rare (settings change), not on every playback progress tick.
  const ttsEnabled = useSettingsStore((s) => s.settings?.ttsEnabled ?? false)
  const [editingRequested, setEditing] = useState(false)
  const editing = editingRequested && !isWithdrawn
  const [draft, setDraft] = useState("")
  const [shared, setShared] = useState(false)
  const [richCopied, setRichCopied] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [truncateOpen, setTruncateOpen] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  // Stable "now" for messages that carry no createdAt (impure Date read kept
  // out of render via a lazy state initializer).
  const [nowFallback] = useState(() => new Date())
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // Non-null only inside a transcript that mounts selection mode; a read-only
  // transcript renders this same row and offers no "Select".
  const selectionHost = useTranscriptSelectionHost()
  const branchSessionId =
    (typeof (message as { metadata?: { sessionId?: unknown } }).metadata?.sessionId === "string"
      ? ((message as { metadata?: { sessionId?: string } }).metadata!.sessionId as string)
      : undefined) ?? activeSessionId
  const transcriptSessionId = useTranscriptSessionId()
  const documentSessionId =
    (typeof (message as { sessionId?: unknown }).sessionId === "string"
      ? (message as unknown as { sessionId: string }).sessionId
      : undefined) ??
    (typeof (message.metadata as { sessionId?: unknown } | undefined)?.sessionId === "string"
      ? (message.metadata as { sessionId: string }).sessionId
      : undefined) ??
    // A live message has no session id yet; the transcript list knows whose it
    // is (a side chat or an unfocused split pane is not the active session).
    transcriptSessionId ??
    activeSessionId
  // Reply, rerun, save and hand-back: the same work the phone's sheet does.
  const commands = useMessageCommands({
    message,
    sessionId: branchSessionId ?? undefined,
    documentSessionId,
  })
  const { asideTargetSessionId, handBackTargetId, templateRun } = commands
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const messageProvider = (message as { metadata?: { provider?: string } }).metadata?.provider
  const checkpointEnabled =
    message.role === "user" &&
    branchSessionId === activeSessionId &&
    (messageProvider ?? defaultProvider ?? "anthropic") === "anthropic"
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const isBookmarked = useChatStore(
    useCallback((s) => s.bookmarkedIds.includes(message.id), [message.id])
  )
  const toggleBookmark = useChatStore((s) => s.toggleBookmark)

  // For team-session assistant messages, resolve which character spoke.
  const senderId = (message as { metadata?: { senderId?: string } }).metadata?.senderId
  const speaker = useMemo(() => {
    if (!senderId || !characterById) return null
    return characterById.get(senderId) ?? null
  }, [senderId, characterById])
  // The per-member stop (ADR-0177 batch 3): offered on the reply a room
  // member is writing right now, read off the member's live status rather
  // than the row's streaming flag, so two members replying at once each get
  // their own. A sealed reply has run metadata; a live one does not yet.
  const memberStatus = useMemberStatus(branchSessionId ?? null, senderId ?? "")
  const memberBusy =
    Boolean(senderId) &&
    message.role === "assistant" &&
    memberStatus === "thinking" &&
    !runMetadataOf(message)
  const stopSpeaker = useMemo(() => {
    if (!memberBusy || !branchSessionId || !senderId) return undefined
    return () => {
      // Lazy: the stop router reaches the process-wide runner, whose module
      // graph has no place in a renderer that only shows text.
      void import("@/lib/chat/room/stop-member").then(({ stopRoomMember }) =>
        stopRoomMember(branchSessionId, senderId).catch((error: unknown) => {
          loggers.chat.warn("stop member failed", { error: String(error) })
        })
      )
    }
  }, [memberBusy, branchSessionId, senderId])
  // Who authored this, through the one resolver the prompt side also uses
  // (`lib/chat/speaker.ts`). Two ad-hoc reads used to live here, one for a
  // shared session's `AuthorRef` and one for `senderId`, and neither knew about
  // `metadata.platformMessage.sender` — so in an IM group every human message,
  // whoever sent it, rendered as "You".
  const resolvedSpeaker = useMemo(() => resolveMessageSpeaker(message as SpeakerSource), [message])
  // A real name wins (a shared session's author, an IM sender), then the local
  // character behind a team turn, then the stable pseudonym. The pseudonym is
  // last but never skipped: an unnamed participant still has to read apart
  // from the others, and it is the same token the transcript shows the model.
  const resolvedName =
    resolvedSpeaker && !resolvedSpeaker.redacted ? resolvedSpeaker.label : undefined
  const speakerName = resolvedName ?? speaker?.name ?? resolvedSpeaker?.label
  const platformAvatarTarget = useMemo(() => messagePlatformAvatarTarget(message), [message])
  const platformAvatarImageUrl = usePlatformAvatar(platformAvatarTarget)
  // The character's own portrait when we have one. Otherwise a colour seeded
  // from the speaker's stable ID rather than its name, because two people in
  // one group really can share a display name, and seeding from the name would
  // hand them the same hue as well as the same label.
  const speakerAvatar: AvatarSubject | undefined =
    platformAvatarTarget && speakerName
      ? {
          name: speakerName,
          avatarImageUrl: platformAvatarImageUrl,
          ...(resolvedSpeaker ? { avatarColor: deterministicColor(resolvedSpeaker.id) } : {}),
        }
      : speaker
        ? speaker
        : speakerName
          ? {
              name: speakerName,
              ...(resolvedSpeaker ? { avatarColor: deterministicColor(resolvedSpeaker.id) } : {}),
            }
          : undefined

  // Segment the parts into tool-activity groups + standalone parts. Memoized on
  // `message.parts` so it doesn't re-run on every token or on unrelated local
  // state (editing/draft/shared/branchOpen) before the memoized children skip.
  // The composer's context envelope is persisted in the user row (a BYOK
  // provider rebuilds later turns from the saved rows), so the bubble shows the
  // typed text and folds the envelope into `PromptPreambleCard`. The part keeps
  // its index — anchors, the gallery and tool groups all key by position — and
  // becomes a step marker when nothing was typed alongside the references.
  const promptPreamble = useMemo(
    () => (message.role === "user" ? locatePromptPreamble(message.parts) : null),
    [message.role, message.parts]
  )
  const promptPreambleSummary = useMemo(
    () =>
      promptPreamble
        ? readPromptPreambleSummary((message as { metadata?: unknown }).metadata)
        : null,
    [message, promptPreamble]
  )
  // Validate persisted projections too: older rows may predate the mapper's
  // shape guard. Withdrawn content never reaches the presentation pipeline.
  const inboundMetadata = (message as { metadata?: Record<string, unknown> }).metadata
  const inboundProjection = inboundMetadata?.inboundA2UI
  const inboundDeletedAt = inboundMetadata?.deletedAt
  const inboundA2UI = useMemo(() => {
    if (!inboundProjection || inboundDeletedAt !== undefined) return null
    return sanitizeInboundA2UIBlock(inboundProjection)
  }, [inboundProjection, inboundDeletedAt])
  const isInboundIM =
    message.role === "user" &&
    Boolean(
      message.metadata &&
      (Object.hasOwn(message.metadata, "platformMessage") ||
        Object.hasOwn(message.metadata, "inboundA2UI"))
    )
  const replyTo = useMemo(() => readReplyTo(message), [message])
  const presentationParts = useMemo(
    () =>
      message.parts.map((part, index) => {
        // Inbound transport parts are prose/media, never executable tool UI.
        if (isInboundIM && !["text", "file", "image", "step-start"].includes(part.type)) {
          return { type: "step-start" } as UIMessage["parts"][number]
        }
        if (
          message.role === "user" &&
          inboundA2UI &&
          inboundA2UIBlockCoversParts(inboundA2UI, [part], replyTo?.preview)
        ) {
          return { type: "step-start" } as UIMessage["parts"][number]
        }
        if (promptPreamble && index === promptPreamble.index) {
          return promptPreamble.body.length > 0
            ? ({ ...part, text: promptPreamble.body } as UIMessage["parts"][number])
            : ({ type: "step-start" } as UIMessage["parts"][number])
        }
        return shouldHideMessagePart(part, display)
          ? ({ type: "step-start" } as UIMessage["parts"][number])
          : part
      }),
    [display, inboundA2UI, isInboundIM, message.parts, message.role, promptPreamble, replyTo]
  )
  const segments = useMemo(
    () => groupAgentParts(presentationParts, agentFlowMode),
    [presentationParts, agentFlowMode]
  )
  // A finished turn folds its process under one "Worked for …" row and keeps
  // the conclusion on screen (`lib/chat/turn-fold.ts`). Never while the row is
  // still being written, by the live tail or by a room member.
  const turnFold = useMemo(
    () =>
      message.role === "assistant" && !isStreaming && !memberBusy && display.foldCompletedTurns
        ? foldTurnParts(presentationParts)
        : null,
    [message.role, isStreaming, memberBusy, display.foldCompletedTurns, presentationParts]
  )

  // A sent video's parts — its description, and the storyboard, frames or
  // poster the model saw — fold into one card at the first part's position.
  const messageVideoAttachments = useMemo(
    () => collectMessageVideoAttachments(message.parts),
    [message.parts]
  )

  // Image file parts belong to one visual attachment group even when a text or
  // document part sits between them. Render the group at the first image's
  // transcript position and suppress the remaining individual image parts.
  // A video's frames are not among them: they belong to the video's card.
  const messageImageGallery = useMemo(() => {
    const items: MessageImageGalleryProps["items"] = []
    const partIndexes = new Set<number>()
    message.parts.forEach((part, index) => {
      const file = part as { type?: string; url?: string; mediaType?: string; filename?: string }
      if (file.type !== "file" || !file.url || !file.mediaType?.startsWith("image/")) return
      if (messageVideoAttachments.partIndexes.has(index)) return
      partIndexes.add(index)
      items.push({
        id: `${message.id}-${index}`,
        src: file.url,
        alt: file.filename ?? t("attachmentAlt"),
        filename: file.filename,
      })
    })
    return {
      items,
      partIndexes,
      firstPartIndex: partIndexes.values().next().value as number | undefined,
    }
  }, [message.id, message.parts, messageVideoAttachments, t])

  // Plain text of the message, for the "share as card" action + gate.
  const messageText = useMemo(() => messageTypedText(message), [message])
  const messageShareContent = useMemo(() => buildMessageShareContent(message), [message])
  // Command gating is session-scoped — a resend/truncate mid-turn lands as a
  // steer or rewrites history under a live stream — so it keys off the branch
  // session's status, not this row's live-tail flag.
  const sessionBusy = useChatStore((s) => {
    const status = branchSessionId ? s.sessions[branchSessionId]?.status : undefined
    return status === "streaming" || status === "awaiting_approval"
  })
  const messageActionCommands = useMemo(
    () =>
      resolveMessageActionCommands({
        role: message.role,
        hasContent: messageShareContent.hasContent,
        hasSession: Boolean(branchSessionId),
        canEdit: Boolean(onEditResend),
        canRegenerate: Boolean(isLastAssistant && onRegenerate),
        canReadAloud: ttsEnabled,
        canBringBack: Boolean(handBackTargetId),
        canRerunTemplate: Boolean(templateRun && branchSessionId),
        canSaveAsMemory: Boolean(branchSessionId),
        canSaveAsIssue: Boolean(branchSessionId),
        canSelect: Boolean(selectionHost),
        canSendToMain: Boolean(asideTargetSessionId),
        allowed: allowedCommands,
        streaming: isStreaming || sessionBusy,
      }),
    [
      allowedCommands,
      asideTargetSessionId,
      branchSessionId,
      selectionHost,
      handBackTargetId,
      isLastAssistant,
      isStreaming,
      sessionBusy,
      message.role,
      messageShareContent.hasContent,
      onEditResend,
      onRegenerate,
      templateRun,
      ttsEnabled,
    ]
  )
  const barCommands = useMemo(
    () => messageActionCommandsAt(messageActionCommands, "bar"),
    [messageActionCommands]
  )
  const menuCommands = useMemo(
    () => messageActionCommandsAt(messageActionCommands, "menu"),
    [messageActionCommands]
  )
  const pluginItems = useMessagePluginItems({
    messageId: message.id,
    sessionId:
      typeof (message as { metadata?: { sessionId?: unknown } }).metadata?.sessionId === "string"
        ? ((message as { metadata?: { sessionId?: string } }).metadata!.sessionId as string)
        : undefined,
  })

  // A turn that is nothing but tool calls has no prose to copy, quote, read
  // aloud or card, so it renders no action bar. The bar is `opacity-0` until
  // hover but still reserves a ~40px row (icon buttons) plus a `gap-2`, which
  // is what put a strip of chrome between every pair of consecutive tool calls.
  const isToolOnlyTurn = useMemo(
    () => message.role === "assistant" && isToolOnlyFlow(message.parts),
    [message.role, message.parts]
  )

  // Text of an inbound IM message was written by a third party.
  // The plain-text parts are the same message's fallback; when the block
  // already shows all of it, rendering both would print the body twice.
  const inboundA2UICoversParts = useMemo(
    () =>
      inboundA2UI !== null &&
      message.role === "user" &&
      inboundA2UIBlockCoversParts(inboundA2UI, message.parts, replyTo?.preview),
    [inboundA2UI, message.role, message.parts, replyTo]
  )

  // Known character names a user's `@Name` may refer to, drawn as mentions
  // inside the message's Markdown (D7).
  const mentions = useMemo<readonly MarkdownMention[] | null>(() => {
    if (!characterById || characterById.size === 0) return null
    const list = [...characterById.values()]
      .filter((character) => character.name)
      .map((character) => ({ name: character.name, color: avatarColor(character) }))
    return list.length ? list : null
  }, [characterById])

  const startEdit = () => {
    if (isWithdrawn) return
    setDraft(messageTypedText(message))
    setEditing(true)
  }

  const submitEdit = () => {
    if (isWithdrawn) return
    const next = draft.trim()
    if (!next) return
    setEditing(false)
    void onEditResend?.(message.id, next)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft("")
  }

  // The inline edit box is one of the conversation's text-entry surfaces. It
  // closes as soon as the user starts on another one (the composer, its `+`
  // menu or microphone, another message's edit) so there is never a stale
  // edit left open beside the composer the next send actually reads.
  const editSurfaceRef = useRef<HTMLDivElement>(null)
  useEditYieldsToOtherSurfaces(editing, editSurfaceRef, cancelEdit)

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submitEdit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancelEdit()
    }
  }

  const handleCopy = useCallback(async () => {
    const { ok, rich } = await copyMessageContent(messageShareContent, messageText, copy)
    if (ok && rich) {
      setRichCopied(true)
      window.setTimeout(() => setRichCopied(false), COPY_FEEDBACK_MS)
    }
    if (ok) onCopy?.()
  }, [messageShareContent, messageText, copy, onCopy])

  // A permalink back into THIS app (`?session=…&message=…`), not a published
  // share link — see `lib/chat/message-permalink.ts`.
  const [linkCopied, setLinkCopied] = useState(false)
  const handleCopyLink = useCallback(async () => {
    if (!branchSessionId) return
    const ok = await copy(
      buildMessagePermalink({ sessionId: branchSessionId, messageId: message.id })
    )
    if (!ok) return
    setLinkCopied(true)
    window.setTimeout(() => setLinkCopied(false), COPY_FEEDBACK_MS)
  }, [branchSessionId, message.id, copy])

  const handleShare = useCallback(async () => {
    // `shareMessageContent` owns the platform split (the Capacitor WebView has
    // no `navigator.share`, so the phone goes through the native sheet with
    // images staged as cache files) and the clipboard fallback.
    const out = await shareMessageContent(messageShareContent)
    if (out.kind === "cancelled") return
    if (out.kind === "failed") {
      if (out.message) loggers.chat.warn("share failed", { err: out.message })
      toast.error(t("shareFailed"))
      return
    }
    setShared(true)
    window.setTimeout(() => setShared(false), COPY_FEEDBACK_MS)
    // No share surface for this content here: say it went to the clipboard
    // rather than flashing "Shared!" for a share that never happened.
    if (out.kind === "copied") toast.success(t("shareCopiedFallback"))
  }, [messageShareContent, t])

  const handleQuote = useCallback(() => {
    if (!branchSessionId) return
    const content = messageTypedText(message).trim()
    if (!content) return
    const text = `${content
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\n`
    if (!dispatchComposerAppend({ text, sessionId: branchSessionId })) {
      useComposerIntentStore.getState().stage(branchSessionId, {
        candidateId: crypto.randomUUID(),
        prompt: text,
        mode: "append",
      })
      toast.info(t("quoteDraft"))
    }
  }, [branchSessionId, message, t])

  const usage = (message as { metadata?: { usage?: UsageInfo } }).metadata?.usage

  // One drawing per command for each placement (D10): the bar (and, with
  // `actions === "all"`, every command inline) and the "…" menu. A command
  // with no drawing on this surface (the sheet's `selectText`, `delete`) is
  // never resolved here, so it draws nothing.
  const renderInlineCommand = (command: MessageActionCommand): ReactNode => {
    const { disabled } = command
    switch (command.id) {
      case "copy":
        return (
          <MessageAction
            tooltip={copied || richCopied ? t("copyDone") : t("copyTooltip")}
            label={t("copyLabel")}
            onClick={handleCopy}
          >
            <CopyFeedbackIcon copied={copied || richCopied} size={14} />
          </MessageAction>
        )
      case "edit":
        return onEditResend ? (
          <MessageAction
            tooltip={t("editTooltip")}
            label={t("editLabel")}
            onClick={startEdit}
            disabled={disabled}
          >
            <PencilIcon className="size-3.5" />
          </MessageAction>
        ) : null
      case "resend":
        return onEditResend ? (
          <MessageAction
            tooltip={t("resendTooltip")}
            label={t("resendLabel")}
            onClick={() => void onEditResend(message.id, messageTypedText(message))}
            disabled={disabled}
            data-testid="message-resend"
          >
            <SendHorizontalIcon className="size-3.5" />
          </MessageAction>
        ) : null
      case "reply":
        return (
          <MessageAction
            tooltip={t("replyTooltip")}
            label={t("replyLabel")}
            onClick={commands.reply}
            data-testid="message-reply"
          >
            <ReplyIcon className="size-3.5" />
          </MessageAction>
        )
      case "rerunTemplate":
        return (
          <MessageAction
            tooltip={t("rerunTemplateTooltip")}
            label={t("rerunTemplateLabel")}
            onClick={commands.rerunTemplate}
            disabled={disabled}
          >
            <Repeat2Icon className="size-3.5" />
          </MessageAction>
        )
      case "saveAsMemory":
        return (
          <MessageAction
            tooltip={t("saveAsMemoryTooltip")}
            label={t("saveAsMemoryLabel")}
            onClick={() => void commands.saveAsMemory()}
            disabled={disabled}
          >
            <BrainIcon className="size-3.5" />
          </MessageAction>
        )
      case "saveAsIssue":
        return (
          <MessageAction
            tooltip={t("saveAsIssueTooltip")}
            label={t("saveAsIssueLabel")}
            onClick={() => void commands.saveAsIssue()}
            disabled={disabled}
            data-testid="message-save-as-issue"
          >
            <CircleDotIcon className="size-3.5" />
          </MessageAction>
        )
      case "regenerate":
        return onRegenerate ? (
          <MessageAction
            tooltip={t("regenerateTooltip")}
            label={t("regenerateLabel")}
            onClick={() => void onRegenerate()}
            disabled={disabled}
          >
            <RefreshCcwIcon className="size-3.5" />
          </MessageAction>
        ) : null
      // ADR-0127: read-aloud is a host command and stays reachable under every
      // preset, not only `inspector`.
      case "readAloud":
        return (
          <ReadAloudButton
            messageId={message.id}
            text={messageTypedText(message)}
            character={speaker ?? directCharacter ?? null}
          />
        )
      case "share":
        return (
          <MessageAction
            tooltip={shared ? t("shareDone") : t("shareTooltip")}
            label={t("shareLabel")}
            onClick={handleShare}
          >
            <Share2Icon className="size-3.5" />
          </MessageAction>
        )
      case "quote":
        return (
          <MessageAction tooltip={t("quoteLabel")} label={t("quoteLabel")} onClick={handleQuote}>
            <QuoteIcon className="size-3.5" />
          </MessageAction>
        )
      case "copyLink":
        return (
          <MessageAction
            // Deliberately worded as a *link to this message*, never as
            // "share": the neighbouring share action publishes content, this
            // one only navigates, and confusing the two is either a privacy
            // accident or a dead link.
            tooltip={linkCopied ? t("copyLinkDone") : t("copyLinkTooltip")}
            label={t("copyLinkLabel")}
            onClick={handleCopyLink}
          >
            {linkCopied ? (
              <AnimatedActionIcon icon={AnimatedCheckIcon} size={14} animateOnChange />
            ) : (
              <LinkIcon className="size-3.5" />
            )}
          </MessageAction>
        )
      case "shareCard":
        return (
          <MessageAction
            tooltip={t("shareCardTooltip")}
            label={t("shareCardLabel")}
            onClick={() => setCardOpen(true)}
          >
            <ImageIcon className="size-3.5" />
          </MessageAction>
        )
      case "bookmark":
        return (
          <MessageAction
            tooltip={isBookmarked ? t("bookmarkRemoveTooltip") : t("bookmarkTooltip")}
            label={t("bookmarkLabel")}
            onClick={() => toggleBookmark(message.id)}
            className={cn(isBookmarked && "text-yellow-500")}
          >
            <AnimatedActionIcon
              icon={AnimatedBookmarkIcon}
              size={14}
              animateOnChange={isBookmarked}
              className={isBookmarked ? "fill-current" : undefined}
            />
          </MessageAction>
        )
      case "select":
        return selectionHost ? (
          <MessageAction
            tooltip={t("selectLabel")}
            label={t("selectLabel")}
            onClick={() => selectionHost.start(message.id)}
            data-testid="message-select"
          >
            <ListChecksIcon className="size-3.5" />
          </MessageAction>
        ) : null
      case "branch":
        return (
          <MessageAction
            tooltip={isStreaming ? t("branchStreamingTooltip") : t("branchTooltip")}
            label={t("branchLabel")}
            onClick={() => setBranchOpen(true)}
            // A branch snapshots the visible thread, so taking one mid-turn
            // would copy a half-written reply and seed the child with an
            // unfinished exchange.
            disabled={disabled}
          >
            <GitBranchIcon className="size-3.5" />
          </MessageAction>
        )
      case "restorePoint":
        return (
          <MessageAction
            tooltip={t("restorePointLabel")}
            label={t("restorePointLabel")}
            onClick={() => setRestoreOpen(true)}
            disabled={disabled}
            data-testid="message-restore-point-action"
          >
            <HistoryIcon className="size-3.5" />
          </MessageAction>
        )
      // Removing messages has to be asked for explicitly: editing branches
      // instead of deleting the tail.
      case "truncate":
        return (
          <MessageAction
            tooltip={t("truncateFromTooltip")}
            label={t("truncateFromLabel")}
            onClick={() => setTruncateOpen(true)}
            disabled={disabled}
          >
            <ScissorsIcon className="size-3.5" />
          </MessageAction>
        )
      // Hand a conclusion back up: a side chat to the main conversation, a
      // branch to the one it was cut from.
      case "sendToMain":
        return (
          <MessageAction
            tooltip={t("sendToMainLabel")}
            label={t("sendToMainLabel")}
            onClick={() => void commands.sendToMain()}
          >
            <CornerUpLeftIcon className="size-3.5" />
          </MessageAction>
        )
      case "bringBack":
        return (
          <MessageAction
            tooltip={t("bringBackTooltip")}
            label={t("bringBackLabel")}
            onClick={() => void commands.bringBack()}
          >
            <CornerUpLeftIcon className="size-3.5" />
          </MessageAction>
        )
      default:
        return null
    }
  }

  const renderMenuCommand = (command: MessageActionCommand): ReactNode => {
    const { disabled } = command
    switch (command.id) {
      case "share":
        return (
          <DropdownMenuItem onSelect={() => void handleShare()}>
            <Share2Icon className="size-4" />
            {t("shareLabel")}
          </DropdownMenuItem>
        )
      case "quote":
        return (
          <DropdownMenuItem onSelect={handleQuote}>
            <QuoteIcon className="size-4" />
            {t("quoteLabel")}
          </DropdownMenuItem>
        )
      case "copyLink":
        return (
          <DropdownMenuItem onSelect={() => void handleCopyLink()}>
            <LinkIcon className="size-4" />
            {t("copyLinkLabel")}
          </DropdownMenuItem>
        )
      case "shareCard":
        return (
          <DropdownMenuItem onSelect={() => setCardOpen(true)}>
            <ImageIcon className="size-4" />
            {t("shareCardLabel")}
          </DropdownMenuItem>
        )
      case "bookmark":
        return (
          <DropdownMenuItem onSelect={() => toggleBookmark(message.id)}>
            <AnimatedBookmarkIcon className="size-4" />
            {isBookmarked ? t("bookmarkRemoveTooltip") : t("bookmarkTooltip")}
          </DropdownMenuItem>
        )
      case "select":
        return selectionHost ? (
          <DropdownMenuItem
            onSelect={() => selectionHost.start(message.id)}
            data-testid="message-select-menu"
          >
            <ListChecksIcon className="size-4" />
            {t("selectLabel")}
          </DropdownMenuItem>
        ) : null
      case "branch":
        return (
          <DropdownMenuItem disabled={disabled} onSelect={() => setBranchOpen(true)}>
            <GitBranchIcon className="size-4" />
            {t("branchLabel")}
          </DropdownMenuItem>
        )
      case "restorePoint":
        return (
          <DropdownMenuItem
            disabled={disabled}
            onSelect={() => setRestoreOpen(true)}
            data-testid="message-restore-point"
          >
            <HistoryIcon className="size-4" />
            {t("restorePointLabel")}
          </DropdownMenuItem>
        )
      case "truncate":
        return (
          <DropdownMenuItem disabled={disabled} onSelect={() => setTruncateOpen(true)}>
            <ScissorsIcon className="size-4" />
            {t("truncateFromLabel")}
          </DropdownMenuItem>
        )
      case "sendToMain":
        return (
          <DropdownMenuItem onSelect={() => void commands.sendToMain()}>
            <CornerUpLeftIcon className="size-4" />
            {t("sendToMainLabel")}
          </DropdownMenuItem>
        )
      case "bringBack":
        return (
          <DropdownMenuItem onSelect={() => void commands.bringBack()}>
            <CornerUpLeftIcon className="size-4" />
            {t("bringBackLabel")}
          </DropdownMenuItem>
        )
      default:
        return null
    }
  }

  // One render segment: a tool-activity group or a single part. Shared by the
  // folded process and the visible remainder of a finished turn.
  const renderSegment = (segment: (typeof segments)[number], si: number): ReactNode => {
    if (segment.kind === "tasks") {
      // Task bookkeeping (TodoWrite / Task*): one row saying what the run
      // changed; the full list lives in the dock's Tasks panel.
      return (
        <MotionReveal
          key={`${message.id}-tasks-${si}`}
          index={si}
          disabled={display.motion === "off"}
          intensity={display.motion === "expressive" ? "expressive" : "restrained"}
        >
          <TaskUpdateRow
            sessionId={branchSessionId}
            parts={segment.entries.map((entry) => entry.part)}
          />
        </MotionReveal>
      )
    }
    if (segment.kind === "group") {
      const entries: ToolActivityGroupEntry[] = segment.entries.map((e) => {
        const key = `${message.id}-${(e.part as ToolUIPart).toolCallId ?? e.index}`
        return {
          part: e.part as ToolUIPart,
          key,
          // The same key the call uses when it renders on its own (`partKey`
          // there is this same `${message.id}-${index}` when the call has no
          // id), so a row the reader opened stays open as a lone call grows into
          // a group.
          memoryKey: toolDisclosureKey(message.id, e.part as ToolUIPart, key),
          defaultOpen:
            display.tools === "expanded"
              ? true
              : display.tools === "collapsed"
                ? false
                : agentFlowMode === "detailed" ||
                  (agentFlowMode === "standard" &&
                    ((e.part as ToolUIPart).state === "input-available" ||
                      (e.part as ToolUIPart).state === "output-error")),
        }
      })
      return (
        <MotionReveal
          key={`${message.id}-group-${si}`}
          index={si}
          disabled={display.motion === "off"}
          intensity={display.motion === "expressive" ? "expressive" : "restrained"}
        >
          <ToolActivityGroup
            entries={entries}
            mode={agentFlowMode}
            defaultOpen={
              display.tools === "expanded"
                ? true
                : display.tools === "collapsed"
                  ? false
                  : undefined
            }
            // Keyed by the run's first call: segment indexes shift as parts
            // stream in, the first call of a run does not.
            memoryKey={rememberedDisclosureKey(
              message.id,
              "group",
              (segment.entries[0]?.part as ToolUIPart | undefined)?.toolCallId ??
                segment.entries[0]?.index ??
                si
            )}
            renderChild={(part, key, opts) =>
              renderToolPart(
                part,
                key,
                agentFlowMode,
                opts,
                message.id,
                documentSessionId ?? undefined,
                display.tools
              )
            }
          />
        </MotionReveal>
      )
    }

    const { part, index } = segment.entry
    const partKey = `${message.id}-${index}`
    const partType = (part as { type?: string }).type
    if (messageVideoAttachments.partIndexes.has(index)) {
      const video = messageVideoAttachments.byFirstPartIndex.get(index)
      if (!video) return null
      return (
        <MessageVideoAttachmentCard
          key={`${message.id}-video-${video.info.groupId}`}
          attachment={video}
          idPrefix={message.id}
          sessionId={branchSessionId ?? undefined}
        />
      )
    }
    if (messageImageGallery.partIndexes.has(index)) {
      if (index !== messageImageGallery.firstPartIndex) return null
      return (
        <div key={`${message.id}-image-gallery`}>
          <MessageImageGallery items={messageImageGallery.items} />
          {branchSessionId
            ? [
                ...new Set(
                  [...messageImageGallery.partIndexes].flatMap((partIndex) => {
                    const content = readAttachmentExtractedContent(
                      (message.parts[partIndex] as { extractedContent?: unknown })?.extractedContent
                    )
                    return content ? [content.attachmentId] : []
                  })
                ),
              ].map((assetId) => (
                <AttachmentSourceActions
                  key={`${branchSessionId}:${assetId}`}
                  sessionId={branchSessionId}
                  assetId={assetId}
                />
              ))
            : null}
        </div>
      )
    }
    // Tool cards and reasoning read the display mode only through their
    // Collapsible's uncontrolled `defaultOpen`, snapshotted at mount —
    // a live standard⇄detailed switch changes the prop but never
    // re-opens or re-collapses an already-mounted card. Fold the mode
    // into just those parts' key so switching the display mode remounts
    // them and re-applies the per-mode default. Prose keeps a
    // mode-agnostic key (no reflow), and the outer MotionReveal key
    // stays stable so the entrance animation isn't replayed on a toggle.
    const disclosureKey = isToolPartType(partType)
      ? `${agentFlowMode}-${display.tools}`
      : partType === "reasoning"
        ? `${agentFlowMode}-${display.reasoning}`
        : partType === "sources"
          ? display.sources
          : null
    const nodeKey = disclosureKey ? `${partKey}-${disclosureKey}` : partKey
    const node = (
      <MessagePart
        key={nodeKey}
        part={part}
        partKey={partKey}
        isStreaming={isStreaming}
        mentions={message.role === "user" ? mentions : null}
        characterById={characterById}
        messageId={message.id}
        sessionId={documentSessionId ?? undefined}
        mode={agentFlowMode}
        display={display}
        t={t}
        projectRoot={projectRoot}
        untrusted={isInboundIM}
      />
    )
    // Give tool cards/rows and dispatch banners a one-shot entrance;
    // leave text/markdown untouched to avoid wrapping prose in extra
    // block boxes.
    return isToolPartType(partType) || partType === "agent-team-dispatch" ? (
      <MotionReveal
        key={partKey}
        index={si}
        disabled={display.motion === "off"}
        intensity={display.motion === "expressive" ? "expressive" : "restrained"}
      >
        {node}
      </MotionReveal>
    ) : (
      node
    )
  }

  return (
    <PerfBoundary id="chat:message">
      <Message
        from={message.role}
        className={cn(
          // ADR-0127: the vertical rhythm between turns follows the chat
          // density surface (`--density-gap`: 0.5 / 0.75 / 1rem).
          "py-[calc(var(--density-gap,0.75rem)*0.5)] sm:py-[calc(var(--density-gap,0.75rem)*0.667)]",
          display.layout === "cards"
            ? "max-w-full"
            : display.layout === "bubbles"
              ? "max-w-[min(88%,46rem)]"
              : message.role === "user"
                ? "max-w-[min(82%,42rem)]"
                : "max-w-full"
        )}
      >
        <MessageShell
          message={message}
          display={display}
          speakerName={speakerName}
          speakerColor={speakerAvatar ? avatarColor(speakerAvatar) : undefined}
          speakerAvatar={speakerAvatar}
          isStreaming={isStreaming}
          onStopSpeaker={stopSpeaker}
        >
          <PluginExtensionSlot point="chat.message.before" className="mb-1 empty:hidden" />

          {editing ? (
            <div
              ref={editSurfaceRef}
              data-message-edit=""
              data-testid="message-edit-surface"
              className={cn(
                "flex w-full max-w-full flex-col gap-2",
                message.role === "user" && "items-end"
              )}
            >
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                autoFocus
                rows={Math.min(10, draft.split("\n").length + 1)}
                className="min-h-[60px] resize-none"
              />
              <div className="flex justify-end gap-2 text-xs">
                <Button variant="ghost" size="sm" onClick={cancelEdit}>
                  {t("editingCancel")}
                </Button>
                <Button size="sm" onClick={submitEdit}>
                  {t(showKeyboardHints ? "editingSubmit" : "editingSubmitTouch")}
                </Button>
              </div>
            </div>
          ) : (
            // `MessageContent` is `w-fit` so a user bubble hugs its text. For the
            // assistant that makes the column width follow the widest mounted
            // child — collapsing a tool card unmounts its body and the whole
            // column snaps narrow. Pin the assistant side to the full row so
            // expand/collapse never moves the width.
            // Every image in this turn — markdown `![]()`, attachment gallery,
            // tool-result screenshots — registers with one collection so the
            // viewer pages across the whole message instead of dead-ending on
            // whichever image was clicked. With a session behind it that viewer
            // is the editing workbench, and a saved edit lands back on THIS
            // message as another version.
            <MessageImageCollectionProvider
              target={
                branchSessionId
                  ? {
                      sessionId: branchSessionId,
                      messageId: message.id,
                      parts: message.parts,
                      isStreaming,
                    }
                  : undefined
              }
            >
              <MessageContent
                className={cn(
                  "leading-relaxed",
                  // One module owns bubble geometry (ADR-0148). This branch used
                  // to skip the `cards` layout, which left the user bubble on
                  // ai-elements' vendored default — a colour and corner nobody
                  // chose.
                  userBubbleClass(display.layout),
                  "group-[.is-assistant]:w-full"
                )}
              >
                {replyTo ? <ReplyToQuote replyTo={replyTo} sessionId={branchSessionId} /> : null}
                {promptPreamble ? (
                  <PromptPreambleCard
                    preamble={promptPreamble.preamble}
                    summary={promptPreambleSummary}
                  />
                ) : null}
                {inboundA2UI ? (
                  <InboundA2UIRenderer key={message.id} block={inboundA2UI} className="mb-2" />
                ) : null}
                {/* ADR-0194: labels plugins attached to an inbound IM message
                    (e.g. laya observe-mode moderation scores). */}
                <InboundLabelChips
                  metadata={(message as { metadata?: Record<string, unknown> }).metadata}
                  className="mb-1.5"
                />
                {/* Segment the parts so runs of ≥2 consecutive tool calls collapse */}
                {/* into one activity group. Subagent parts are transparent here and */}
                {/* render once below as a dispatch tree. A finished turn draws its */}
                {/* process segments (and the tree) inside the fold, the rest after it. */}
                {message.role === "user" ? (
                  inboundA2UICoversParts ? null : (
                    <UserMessageBody
                      key={message.id}
                      previewText={messageText}
                      message={message as { metadata?: Record<string, unknown> }}
                      sessionId={documentSessionId}
                    >
                      {segments.map((segment, si) => renderSegment(segment, si))}
                      <SubagentTree parts={message.parts} mode={agentFlowMode} />
                    </UserMessageBody>
                  )
                ) : (
                  <>
                    {turnFold ? (
                      <TurnProcessFold
                        fold={turnFold}
                        durationMs={runMetadataOf(message)?.durationMs}
                        memoryKey={rememberedDisclosureKey(message.id, "fold")}
                      >
                        {segments.map((segment, si) =>
                          isSegmentFolded(segment, turnFold) ? renderSegment(segment, si) : null
                        )}
                        <SubagentTree parts={message.parts} mode={agentFlowMode} />
                      </TurnProcessFold>
                    ) : null}
                    {segments.map((segment, si) =>
                      turnFold && isSegmentFolded(segment, turnFold)
                        ? null
                        : renderSegment(segment, si)
                    )}
                    {turnFold ? null : <SubagentTree parts={message.parts} mode={agentFlowMode} />}
                  </>
                )}
              </MessageContent>
            </MessageImageCollectionProvider>
          )}

          {/* The files this turn changed, from its own record. Self-hides for a
            turn that changed nothing or that the host did not track. */}
          {message.role === "assistant" && !isStreaming && !memberBusy && branchSessionId ? (
            <TurnChangesCard sessionId={branchSessionId} messageId={message.id} />
          ) : null}

          {/* Delivery state of a mid-run follow-up. Self-hides for every message
            that is not a pending steer. */}
          <SteerStatusBadge message={message} sessionId={branchSessionId} />
          {/* Whether this turn ran at all: queued behind a held working tree,
            or failed before producing anything. Self-hides otherwise. */}
          <TurnAdmissionBadge message={message} sessionId={branchSessionId} />
          <SessionPeerOriginBadge metadata={message.metadata} />

          <PluginExtensionSlot point="chat.message.after" className="mt-1 empty:hidden" />

          {/* Trigger audit badge — surfaces workflows fired by this message via */}
          {/* `lib/chat/trigger-audit-ring`. Only renders when ≥1 trigger fired. */}
          {(() => {
            const sessionId =
              typeof (message as { metadata?: { sessionId?: unknown } }).metadata?.sessionId ===
              "string"
                ? ((message as { metadata?: { sessionId?: string } }).metadata!.sessionId as string)
                : null
            if (!sessionId) return null
            return <TriggerBadge sessionId={sessionId} messageId={message.id} />
          })()}

          {/* Memory transparency chips — "learned N" + "recalled N" for completed */}
          {/* assistant turns. Mounted only when not streaming so the liveQuery */}
          {/* inside the chips never runs in the token-delta hot path. */}
          {message.role === "assistant" && !isStreaming && (
            <div className="mt-1 flex flex-wrap items-center gap-1 empty:hidden">
              <MemoryLearnedChip messageId={message.id} />
              {(() => {
                const sourcesPart = (message.parts as unknown[]).find(isSourcesPart)
                return sourcesPart ? <MemoryRecalledChip part={sourcesPart} /> : null
              })()}
            </div>
          )}
          {/* ADR-0026 §5 §A — revived hover-action slot. Distinct from the */}
          {/* footer below: this slot is visible above the message body on hover, */}
          {/* the footer holds host copy/regenerate controls. */}
          {/* User-side rows sit inside the shell body (a block), so `ml-auto`
              only right-aligns them when the row is `w-fit` — a block-level
              flex row with auto width ignores auto margins and pins to the
              left under the right-aligned bubble. */}
          {/* Unlike the host action bar above, this slot is hover-revealed
              unconditionally — so it needs the focus/touch reveals even more:
              without them a plugin that contributes a message action has NO
              way to be reached on a touch device, and none by keyboard. */}
          {/* `contents`: the marker must not add a box between the slot and the
              row it right-aligns in. */}
          <div className="contents" data-message-actions="">
            <PluginExtensionSlot
              point="chat.message.actions"
              className={cn(
                "mt-1 flex items-center gap-1 empty:hidden",
                HOVER_REVEAL_CLASS,
                message.role === "user" ? "ml-auto w-fit" : ""
              )}
            />
          </div>

          {/* One line under the body: the reactions on the row (always
              visible) and the action bar, both on the message's side. */}
          {!editing && !isToolOnlyTurn && display.actions !== "all" && (
            <div
              className={cn(
                // `empty:hidden`: with the bar handed to the long-press sheet
                // and no reactions or meta to show, the line has no children
                // and must not keep a row of gap under the bubble.
                "flex min-w-0 items-center gap-2 empty:hidden",
                message.role === "user" && "justify-end"
              )}
              data-testid="message-action-line"
            >
              {/* Always visible, like the reactions beside it. In these
                  action modes the bookmark toggle sits in the "…" overflow or a
                  hover-revealed bar, and on a phone in the long-press sheet, so
                  without this a bookmarked message looked exactly like any
                  other one. (`all` keeps the lit toggle itself on screen.) */}
              {isBookmarked ? (
                <span
                  role="img"
                  aria-label={t("bookmarkedIndicator")}
                  title={t("bookmarkedIndicator")}
                  data-testid="message-bookmark-indicator"
                  className="inline-flex shrink-0 items-center text-yellow-500"
                >
                  <BookmarkIcon aria-hidden className="size-3.5 fill-current" />
                </span>
              ) : null}
              <MessageReactionPills message={message} sessionId={branchSessionId} />
              {/* Marked so selection mode can set the row's own controls aside
                  (`message-list.tsx`); the reactions beside them stay. */}
              {inlineActionBar ? (
                <MessageActions
                  data-message-actions=""
                  className={cn(
                    "text-xs text-muted-foreground transition-opacity",
                    // `focus-within` and `pointer-coarse` are not decoration: hover
                    // is the ONLY reveal a bare `group-hover` offers, so without
                    // them this whole bar (copy / edit / retry / branch / plugin
                    // actions) is permanently invisible on touch — where the app
                    // ships through Capacitor — and a keyboard user lands focus on
                    // a control they cannot see. The shared constant also keeps
                    // the bar up while the "…" overflow's portal is open — both
                    // hover and focus-within sit inside that portal then.
                    display.actions === "hover" && HOVER_REVEAL_CLASS,
                    message.role === "user" ? "w-fit" : ""
                  )}
                >
                  {barCommands.map((command) => (
                    <Fragment key={command.id}>{renderInlineCommand(command)}</Fragment>
                  ))}

                  {/* IM cross-links: forward this text to an IM conversation, or
                  lift an inbound IM message into a fresh main chat. Self-hide
                  when they do not apply. */}
                  <MessageReactionAdd message={message} sessionId={branchSessionId} />
                  <MessageImActions
                    message={message}
                    text={messageText}
                    sessionId={branchSessionId}
                  />

                  {/* Overflow LAST. Everything above is a single-purpose button;
                  this one is the drawer the rest of the actions live in, and a
                  drawer sitting mid-row reads as just another action while
                  pushing the real ones past it. Plugin items sit in it too, after
                  a separator, instead of in a second "…" beside it. */}
                  {menuCommands.length > 0 || pluginItems.length > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={t("moreLabel")}
                          data-testid="message-more"
                        >
                          <MoreHorizontalIcon className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align={message.role === "user" ? "end" : "start"}>
                        {menuCommands.map((command) => (
                          <Fragment key={command.id}>{renderMenuCommand(command)}</Fragment>
                        ))}
                        <MessagePluginMenuItems
                          items={pluginItems}
                          separated={menuCommands.length > 0}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}

                  <BranchNavigator message={message} className="mx-1" />
                  {branchSessionId && (
                    <BranchPointMarker sessionId={branchSessionId} messageId={message.id} />
                  )}
                </MessageActions>
              ) : null}
              {/* Footer meta: the run summary line on the row's right end.
                  Click opens the per-field popover — no inline expansion, so
                  the transcript below never shifts. */}
              <MessageMetaLine
                message={message}
                display={display}
                speakerName={speakerName}
                className="ml-auto"
              />
            </div>
          )}

          {!editing && !isToolOnlyTurn && display.actions === "all" && (
            <div
              className={cn(
                "flex min-w-0 items-center gap-2",
                message.role === "user" && "justify-end"
              )}
              data-testid="message-action-line"
            >
              <MessageReactionPills message={message} sessionId={branchSessionId} />
              {/* Marked so selection mode can set the row's own controls aside
                  (`message-list.tsx`); the reactions beside them stay. */}
              <MessageActions
                data-message-actions=""
                className={cn(
                  "text-xs text-muted-foreground",
                  message.role === "user" ? "w-fit" : ""
                )}
              >
                {usage && message.role === "assistant" && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono">
                        ↑{usage.inputTokens ?? 0} ↓{usage.outputTokens ?? 0}
                        {usage.totalCostUsd !== undefined && ` · $${usage.totalCostUsd.toFixed(4)}`}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <UsageBreakdown usage={usage} />
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Every command inline, the bar's first (ADR-0127: `all` is an
                explicit choice to see them). */}
                {messageActionCommands.map((command) => (
                  <Fragment key={command.id}>{renderInlineCommand(command)}</Fragment>
                ))}

                {message.role === "user" && branchSessionId && onRewindFiles && (
                  <CheckpointAction
                    checkpointId={message.id}
                    enabled={checkpointEnabled}
                    rewindFiles={(checkpointId, dryRun) =>
                      onRewindFiles(branchSessionId, checkpointId, dryRun)
                    }
                  />
                )}

                {/* Both roles: assistant siblings come from regenerating, user
                siblings from editing (which keeps the original rather than
                deleting its tail). The navigator no-ops when the message has
                no branch group, so no role gate is needed. */}
                <BranchNavigator message={message} className="mx-1" />

                {/* Self-hides unless a cross-session branch was cut here. Shows the
                fork where the decision was made, rather than only in the
                header — scrolling a long thread reveals where it diverged. */}
                {branchSessionId && (
                  <BranchPointMarker sessionId={branchSessionId} messageId={message.id} />
                )}

                <MessageReactionAdd message={message} sessionId={branchSessionId} />
                <MessageImActions
                  message={message}
                  text={messageText}
                  sessionId={branchSessionId}
                />

                {/* With every host command inline, the "…" holds only what
                plugins contributed. */}
                {pluginItems.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={t("moreLabel")}
                        data-testid="message-more"
                      >
                        <MoreHorizontalIcon className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align={message.role === "user" ? "end" : "start"}>
                      <MessagePluginMenuItems items={pluginItems} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}

                <PluginExtensionSlot
                  point="chat.message.footer"
                  className="flex items-center gap-1 empty:hidden"
                />
              </MessageActions>
              <MessageMetaLine
                message={message}
                display={display}
                speakerName={speakerName}
                className="ml-auto"
              />
            </div>
          )}

          {/* The action row is suppressed while editing and on tool-only
              turns, but the run metadata still applies — the chip gets a
              meta-only line so the sealed turn keeps its cost/duration read. */}
          {(editing || isToolOnlyTurn) && (
            <div className="flex empty:hidden" data-testid="message-meta-row">
              <MessageMetaLine
                message={message}
                display={display}
                speakerName={speakerName}
                className="ml-auto"
              />
            </div>
          )}
        </MessageShell>

        {branchSessionId && (
          <BranchDialog
            sessionId={branchSessionId}
            messageId={message.id}
            open={branchOpen}
            onOpenChange={setBranchOpen}
          />
        )}

        {/* Mounted only while open, unlike BranchDialog above. Every message row
            renders one of these, and a Radix AlertDialog Root per row is enough
            overhead to disturb the message list's scroll bookkeeping (it broke
            the jump-pill's scroll-fencing tests). Same pattern as
            QuoteCardDialog below. */}
        {truncateOpen && branchSessionId && (
          <TruncateFromDialog
            sessionId={branchSessionId}
            messageId={message.id}
            open
            onOpenChange={setTruncateOpen}
          />
        )}

        {/* Mounted only while open, like the delete dialog above. */}
        {restoreOpen && branchSessionId && (
          <RestorePointDialog
            sessionId={branchSessionId}
            messageId={message.id}
            open
            onOpenChange={setRestoreOpen}
            busy={sessionBusy}
            {...(onEditResend ? { onEdit: startEdit } : {})}
            onBranch={() => setBranchOpen(true)}
            onTruncate={() => setTruncateOpen(true)}
            {...(onRewindFiles
              ? {
                  checkpoint: {
                    eligible: checkpointEnabled,
                    rewindFiles: (checkpointId: string, dryRun: boolean) =>
                      onRewindFiles(branchSessionId, checkpointId, dryRun),
                  },
                }
              : {})}
          />
        )}

        {cardOpen && (
          <QuoteCardDialog
            open={cardOpen}
            onOpenChange={setCardOpen}
            role={message.role}
            authorName={speakerName}
            text={messageShareContent.plainText}
            model={(message as { metadata?: { model?: string } }).metadata?.model}
            timestamp={((): Date => {
              const createdAt = (message as { metadata?: { createdAt?: number } }).metadata
                ?.createdAt
              return createdAt != null ? new Date(createdAt) : nowFallback
            })()}
          />
        )}
      </Message>
    </PerfBoundary>
  )
}

/**
 * Surfaces in an assistant message that name no A2UI catalog render with the
 * catalog of the agent that wrote it: the room member who spoke (same lookup
 * as the speaker above), else the session's agent.
 */
export function messageAgentCatalogId(
  message: Props["message"],
  characterById: Props["characterById"],
  directCharacter: Props["directCharacter"]
): string | undefined {
  if (message.role !== "assistant") return undefined
  const senderId = (message as { metadata?: { senderId?: string } }).metadata?.senderId
  const speaker = senderId ? characterById?.get(senderId) : undefined
  return (speaker ?? directCharacter ?? undefined)?.a2uiCatalogId
}

function MessageRendererWithAgentCatalog(suppliedProps: Props) {
  // D10: what the list shell supplies once; a prop on this row still wins.
  const context = useMessageRenderContext()
  const fallbackMessageDisplay = useMessageDisplay()
  const messageDisplay =
    suppliedProps.messageDisplay ?? context.messageDisplay ?? fallbackMessageDisplay
  const props = { ...resolveMessageRenderProps(suppliedProps, context), messageDisplay }
  // Renderers nested in this message (tool cards, subagent transcripts, file
  // previews) draw with the same display settings.
  const nested = useMemo(() => ({ messageDisplay }), [messageDisplay])
  return (
    <A2UIAgentCatalogProvider
      catalogId={messageAgentCatalogId(props.message, props.characterById, props.directCharacter)}
    >
      {/* A reply still being written is the only content that ARRIVES; every
          other row is history being drawn (on open, or as the virtual list
          remounts it), and replaying entrances there was a burst of fades on
          every switch and a replay on every scroll. */}
      <EntranceMotionProvider arriving={Boolean(props.isStreaming)}>
        <MessageRenderProvider value={nested}>
          <MessageRendererInner {...props} />
        </MessageRenderProvider>
      </EntranceMotionProvider>
    </A2UIAgentCatalogProvider>
  )
}

export const MessageRenderer = memo(
  MessageRendererWithAgentCatalog,
  (prev, next) =>
    prev.message === next.message &&
    prev.isStreaming === next.isStreaming &&
    prev.isLastAssistant === next.isLastAssistant &&
    prev.characterById === next.characterById &&
    prev.directCharacter === next.directCharacter &&
    prev.onCopy === next.onCopy &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onEditResend === next.onEditResend &&
    prev.onRewindFiles === next.onRewindFiles &&
    prev.projectRoot === next.projectRoot &&
    prev.messageDisplay === next.messageDisplay &&
    prev.actionSheetHost === next.actionSheetHost
)

MessageRenderer.displayName = "MessageRenderer"

function shouldHideMessagePart(
  part: UIMessage["parts"][number],
  display: ResolvedMessageDisplayOptions
): boolean {
  const typed = part as {
    type?: string
    state?: string
    twinDegraded?: boolean
    memoryDegraded?: boolean
  }
  if (typed.type === "reasoning") return display.reasoning === "hidden"
  if (typed.type === "sources") {
    return display.sources === "hidden" && !typed.twinDegraded && !typed.memoryDegraded
  }
  if (isToolPartType(typed.type) && display.tools === "hidden") {
    // Only successful, settled tools may disappear. Running, failed and
    // approval-sensitive states remain reachable regardless of preference.
    return typed.state === "output-available"
  }
  return false
}

/**
 * Memoized boundary around a single message part. Parts inside a finalized
 * message keep stable references (the adapter only replaces the changed
 * message object, not its parts), so when `MessageRenderer` re-renders for an
 * unrelated reason this lets React skip re-reconciling every part subtree —
 * the expensive ones being `<Tool>` cards and `<MarkdownRenderer>`. Without
 * this, each re-render rebuilt the whole part tree (the ~11ms/row cost the
 * PerfHud surfaced). The default shallow prop compare is exactly right here:
 * `part` / `mentions` / `characterById` / `t` are all reference-stable
 * while the message is unchanged.
 */
const MessagePart = memo(function MessagePart({
  part,
  partKey,
  isStreaming,
  mentions,
  characterById,
  messageId,
  sessionId,
  mode,
  display,
  t,
  projectRoot,
  untrusted,
}: {
  part: UIMessage["parts"][number]
  partKey: string
  isStreaming: boolean
  mentions: readonly MarkdownMention[] | null
  characterById: Map<string, Character> | undefined
  messageId: string | undefined
  sessionId: string | undefined
  mode: AgentFlowMode
  display: ResolvedMessageDisplayOptions
  t: ReturnType<typeof useTranslations>
  projectRoot?: string | null
  untrusted: boolean
}) {
  return (
    <ChatDocumentSessionContext.Provider value={sessionId}>
      {renderPart(
        part,
        partKey,
        isStreaming,
        mentions,
        characterById,
        messageId,
        sessionId,
        mode,
        display,
        t,
        projectRoot,
        untrusted
      )}
    </ChatDocumentSessionContext.Provider>
  )
})
MessagePart.displayName = "MessagePart"

/**
 * The disclosure-memory key for one tool call: the message plus the call's own
 * id (a part index for the rare call without one). Shared by the grouped and
 * the standalone paths so a call keeps the reader's choice in either.
 */
function toolDisclosureKey(
  messageId: string | undefined,
  part: ToolUIPart,
  fallback: string | number
): string {
  return rememberedDisclosureKey(messageId, "tool", part.toolCallId ?? fallback)
}

/**
 * Build a single tool-call element for standard/detailed modes (or a compact
 * row for simplified), plus the per-call plugin action slot. Shared by the
 * inline single-tool path and the activity group's `renderChild`, so a grouped
 * tool and a standalone one are rendered by the exact same code — including the
 * plugin slot, which used to be dropped for every tool inside a simplified
 * group.
 *
 * The body itself lives in `ToolDetailBody` and is identical across modes; only
 * the chrome differs by mode. Grouped children receive controlled disclosure
 * state; standalone children retain their per-state default-open heuristic.
 */
function renderToolPart(
  tp: ToolUIPart,
  key: string,
  mode: AgentFlowMode,
  opts: ToolActivityChildOptions,
  messageId: string | undefined,
  sessionId: string | undefined,
  visibility: ResolvedMessageDisplayOptions["tools"]
): React.ReactNode {
  const slot = (
    <>
      <CreatedDocumentAction part={tp} sessionId={sessionId} />
      <PluginExtensionSlot
        point="chat.tool-call.actions"
        className="mt-1 flex items-center gap-1 empty:hidden"
        context={{
          toolName: tp.type,
          toolState: tp.state,
          toolInput: tp.input,
          messageId,
          sessionId,
        }}
      />
    </>
  )
  const preferenceOpen =
    visibility === "expanded" ? true : visibility === "collapsed" ? false : undefined
  // A standalone row remembers the reader's toggle by call identity; a grouped
  // one is controlled by its group, which remembers it under the same key.
  const memoryKey = toolDisclosureKey(messageId, tp, key)

  // Simplified mode: every tool collapses to a one-line, expandable row.
  if (mode === "simplified") {
    return (
      <React.Fragment key={key}>
        <ToolCallRow
          part={tp}
          sessionId={sessionId}
          expanded={opts.expanded}
          onToggle={opts.onToggle}
          defaultOpen={preferenceOpen}
          memoryKey={memoryKey}
        />
        {slot}
      </React.Fragment>
    )
  }

  // A failed call and a still-running one open by default (the user needs the
  // trace / the live output); a settled success stays collapsed — except a
  // generated video, whose row IS the result the user asked for (its job card,
  // then the video), not a trace of how the answer was reached, and a card
  // registered as the call's purpose (a proposal a person answers).
  const toolName = toolNameOf(tp)
  const defaultOpen =
    preferenceOpen ??
    (mode === "detailed" ||
      tp.state === "output-error" ||
      tp.state === "input-available" ||
      toolName === VIDEO_GENERATE_TOOL_NAME ||
      (toolName !== null && getToolResultRenderer(toolName)?.opensRow === true))

  // Every tool renders as an inline row (status dot + lead + target + meta +
  // chevron) through the shared `ToolRowShell` chrome: Bash gets the `$`
  // prompt row, file tools the verb row, and everything else — built-ins,
  // plugin tools, unknown MCP tools — the generic structured row. The
  // expanded body is `ToolDetailBody` in every case, so a row never decides
  // how a payload renders.
  const toolEl = isBashToolPart(tp) ? (
    <TerminalToolPart
      part={tp}
      defaultOpen={defaultOpen}
      expanded={opts.expanded}
      onToggle={opts.onToggle}
      memoryKey={memoryKey}
    />
  ) : isFileToolPart(tp) ? (
    <FileToolPart
      part={tp}
      sessionId={sessionId}
      defaultOpen={defaultOpen}
      expanded={opts.expanded}
      onToggle={opts.onToggle}
      memoryKey={memoryKey}
    />
  ) : (
    <StructuredToolPart
      part={tp}
      sessionId={sessionId}
      defaultOpen={defaultOpen}
      expanded={opts.expanded}
      onToggle={opts.onToggle}
      memoryKey={memoryKey}
    />
  )

  return (
    <React.Fragment key={key}>
      {toolEl}
      {slot}
    </React.Fragment>
  )
}

function renderPart(
  part: UIMessage["parts"][number],
  key: string,
  isStreaming: boolean,
  mentions: readonly MarkdownMention[] | null,
  characterById: Map<string, Character> | undefined,
  messageId: string | undefined,
  sessionId: string | undefined,
  mode: AgentFlowMode,
  display: ResolvedMessageDisplayOptions,
  t: ReturnType<typeof useTranslations>,
  projectRoot?: string | null,
  untrusted = false
) {
  const type = (part as { type?: string }).type
  if (!type) return null

  if (type === "data-tool-summary") {
    return isToolUseSummaryPart(part) ? <ToolUseSummaryPart key={key} part={part} /> : null
  }

  if (type === "artifact") {
    return <ArtifactPart key={key} part={part as unknown as ArtifactPartType} />
  }

  if (type === "sources") {
    return (
      <SourcesPart
        key={key}
        part={part as unknown as SourcesPartType}
        defaultOpen={display.sources === "expanded"}
      />
    )
  }

  if (type === "grounding") {
    return <GroundingPart key={key} part={part as unknown as GroundingPartType} />
  }

  if (type === "canvas") {
    return <CanvasInlinePart key={key} part={part as unknown as CanvasInlinePartType} />
  }

  if (type === "hook-notice") {
    // Inline hook-notice part — emitted by external agents (event-to-parts).
    // The built-in agent's hook notices are whole system messages routed by
    // message-list, so they never reach renderPart.
    return <HookNoticeRow key={key} data={part as unknown as HookNoticePartData} />
  }

  if (type === "a2ui") {
    if (untrusted) return null
    return (
      <A2UIPart
        key={key}
        part={part as unknown as A2UIPartType}
        _messageId={messageId}
        sessionId={sessionId}
      />
    )
  }

  if (type === DIAGNOSTICS_PART_TYPE) {
    const data = (part as { data?: unknown }).data
    if (isSlashCommandResultBlock(data)) {
      return <SlashCommandResultChip key={key} block={data} />
    }
    if (isVideoJobBlock(data)) {
      return <VideoJobView key={key} jobId={data.jobId} />
    }
    if (isShellJobBlock(data)) {
      return <ShellJobView key={key} block={data} />
    }
    if (isSystemMessageBlock(data)) {
      return <DiagnosticsCard key={key} block={data as SystemMessageBlock} />
    }
    return null
  }

  if (type === "subagent") {
    // Subagent parts are rendered together as a dispatch tree at the message
    // level (see the parts map), never individually here.
    return null
  }

  // The guards check the fields each card reads, so a part that only carries
  // the type (a truncated sync, an older writer) is not handed to it. They read
  // an `unknown` view: these custom parts are not members of the declared part
  // union, so narrowing `part` itself would leave `never`.
  const custom: unknown = part
  if (isAgentTeamDispatchPart(custom)) {
    const fromName = characterById?.get(custom.from)?.name
    return <AgentTeamDispatchPart key={key} part={custom} fromName={fromName} mode={mode} />
  }

  if (isSquadRunPart(custom)) {
    return <SquadRunPart key={key} part={custom} />
  }

  if (isSquadGatePart(custom)) {
    return <SquadGatePart key={key} part={custom} />
  }

  if (type === "verification-verdict") {
    return (
      <VerificationVerdictPart key={key} part={part as unknown as VerificationVerdictPartType} />
    )
  }

  if (type === "text") {
    const text = (part as { text?: string }).text ?? ""
    // An empty text part carries no prose — the model emitted none between two
    // tool calls. Rendering it would add a zero-height box that still eats a
    // `gap-2` from `MessageContent`'s flex column.
    if (!text.trim()) return null
    // Text a third party sent through an IM platform: no raw HTML, no live
    // A2UI fences, no project links, and the sender's line breaks kept
    // (every IM dialect treats a newline as a break).
    if (untrusted) {
      return (
        <MarkdownRenderer
          key={key}
          content={preserveLineBreaks(text)}
          untrusted
          mentions={mentions ?? undefined}
          messageId={messageId}
          markdown={display.markdown}
          className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      )
    }

    if (isStreaming) {
      return (
        <StreamingTextPart
          key={key}
          text={text}
          messageId={messageId}
          isStreaming={isStreaming}
          projectRoot={projectRoot}
          richControls={display.richControls}
          markdown={display.markdown}
        />
      )
    }

    if (text.length >= FINALIZED_MARKDOWN_LAZY_THRESHOLD) {
      return (
        <FinalizedLongTextPart
          key={key}
          text={text}
          messageId={messageId}
          projectRoot={projectRoot}
          markdown={display.markdown}
          mentions={mentions ?? undefined}
        />
      )
    }

    return (
      <MarkdownRenderer
        key={key}
        content={text}
        messageId={messageId}
        isStreaming={isStreaming}
        projectRoot={projectRoot}
        markdown={display.markdown}
        mentions={mentions ?? undefined}
        className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      />
    )
  }

  if (type === "reasoning") {
    const text = (part as { text?: string }).text ?? ""
    const reasoningMarkdown = resolveChatStreamdownConfig(display.markdown)
    const stillStreaming = isStreaming && (part as { state?: string }).state !== "done"
    // Detailed mode keeps the reasoning expanded; simplified keeps it collapsed;
    // standard defers to the component's stream-aware auto open/close.
    const reasoningDefaultOpen =
      display.reasoning === "expanded"
        ? true
        : display.reasoning === "collapsed"
          ? false
          : mode === "detailed"
            ? true
            : mode === "simplified"
              ? false
              : undefined
    return (
      <Reasoning
        key={key}
        isStreaming={stillStreaming}
        defaultOpen={reasoningDefaultOpen}
        // Keep a finished thinking block in place instead of auto-collapsing it
        // the instant the answer streams in — the reasoning is part of the
        // transcript and should stay readable.
        closeOnFinish={false}
        // The row joins the activity stream — no section spacing.
        className="mb-0"
      >
        <ReasoningToolRow
          text={reasoningMarkdown.config.preprocess(text)}
          streamdownProps={{
            // D7: the answer body's configuration — fence renderers, sanitize
            // and URL policy, line numbers, and the class-borne knobs.
            className: reasoningMarkdown.config.className,
            // Reasoning uses the same typography, but stays outside plugin URL matching.
            components: createStreamingComponents(projectRoot, stillStreaming, undefined, false),
            controls: { table: false },
            isAnimating: stillStreaming,
            lineNumbers: reasoningMarkdown.lineNumbers,
            mode: stillStreaming ? "streaming" : "static",
            plugins: reasoningMarkdown.plugins,
            rehypePlugins: reasoningMarkdown.rehypePlugins,
            urlTransform: reasoningMarkdown.urlTransform,
          }}
        />
      </Reasoning>
    )
  }

  if (type === "data-async-questions") {
    // Non-blocking agent questions (opt-in: settings.inlineQuestions). The
    // card answers with ordinary user messages via the chat-send bridge.
    return <AsyncQuestionsCard key={key} part={part} sessionId={sessionId} messageId={messageId} />
  }

  if (type === SHARED_WITHHELD_PART_TYPE) {
    // A shared run replaced a part its PII gate refused (ADR-0241). It holds
    // no content: an inert label where the part was, never a control.
    return (
      <div
        key={key}
        role="note"
        data-inert="shared-withheld"
        className="border-muted-foreground/30 text-muted-foreground border-l-2 pl-3 text-xs italic"
      >
        {t("sharedWithheld")}
      </div>
    )
  }

  if (type === "data-commentary") {
    const data = (part as { data?: { text?: string } }).data
    const text = data?.text ?? ""
    if (!text.trim()) return null
    return (
      <div
        key={key}
        role="status"
        aria-live="polite"
        className="border-muted-foreground/30 text-muted-foreground border-l-2 pl-3 text-sm"
      >
        <MarkdownRenderer
          content={text}
          messageId={messageId}
          isStreaming={isStreaming}
          projectRoot={projectRoot}
          markdown={display.markdown}
          className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      </div>
    )
  }

  if (type === "file") {
    const url = (part as { url?: string }).url
    const mediaType = (part as { mediaType?: string }).mediaType
    const filename = (part as { filename?: string }).filename

    if (url && mediaType?.startsWith("image/")) {
      return (
        <MessageImageGallery
          key={key}
          items={[
            {
              id: key,
              src: url,
              alt: filename ?? t("attachmentAlt"),
              filename,
            },
          ]}
        />
      )
    }

    // A document the user attached: the model got its extracted text, and that
    // text rides along on the part; the original is held in session assets.
    // Render it as a collapsed file card instead
    // of spilling the whole document into the bubble.
    const attachedText = (part as { text?: string }).text
    const extraction = readAttachmentExtractedContent(
      (part as { extractedContent?: unknown }).extractedContent
    )
    // Even an extraction from another build may still name an asset. Keep
    // that identity so deleting its source can never revive the part body.
    const storedAssetId = (part as { extractedContent?: { attachmentId?: unknown } })
      .extractedContent?.attachmentId
    const sourceAssetId =
      extraction?.attachmentId ?? (typeof storedAssetId === "string" ? storedAssetId : undefined)
    if (!url && (attachedText || extraction)) {
      return (
        <AttachmentTextCard
          key={key}
          filename={filename ?? t("attachmentAlt")}
          mediaType={mediaType}
          text={attachedText ?? ""}
          sessionId={sessionId}
          assetId={sourceAssetId}
          messageId={messageId}
          provenance={(part as unknown as Record<string, unknown>)[REMOTE_DOC_PART_KEY]}
        />
      )
    }

    if (!url) return null

    // Non-image file: the same file card the composer showed, with an inline
    // preview for text/code/pdf/video under it, or a download card otherwise.
    return (
      <FilePartCard
        key={key}
        messageId={messageId}
        url={url}
        mediaType={mediaType}
        filename={filename}
      />
    )
  }

  // Plugin-contributed part types — checked before the generic tool fallback
  // so a plugin can override custom types it owns, but AFTER the host's own
  // hard-coded parts so plugins cannot shadow `artifact` / `a2ui` / etc.
  const pluginEntry =
    typeof type === "string" && !isToolPartType(type) ? getMessagePartRenderer(type) : undefined
  if (pluginEntry) {
    const PluginRenderer = pluginEntry.component
    return (
      <React.Fragment key={key}>
        <PluginSurface
          pluginId={pluginEntry.pluginId}
          surfaceId={`message-renderer:${pluginEntry.type}`}
          formFactor="block"
        >
          <PluginRenderer part={part} messageId={messageId} isStreaming={isStreaming} />
        </PluginSurface>
        {/* UI companion to the `provider.message-renderer` runtime point: */}
        {/* plugins can mount per-part actions beneath any rendered part. */}
        <PluginExtensionSlot
          point="chat.message-part.actions"
          className="mt-1 flex items-center gap-1 empty:hidden"
          context={{ partType: pluginEntry.type, messageId, sessionId, isStreaming }}
        />
      </React.Fragment>
    )
  }

  // `dynamic-tool` is the AI SDK shape for a tool the client never declared
  // statically — imported transcripts and CLI handoff carry it, and every
  // other consumer (grouping, summaries, exports, ToolHeader/ToolBody) already
  // treats it as a tool call. Route it through the same renderer instead of
  // dropping it into the unknown-part card.
  if (isToolPartType(type)) {
    const tp = part as ToolUIPart
    // Delegate to the shared tool renderer (mode-aware: simplified row vs.
    // standard/detailed card), which also appends the per-call plugin slot.
    return renderToolPart(tp, key, mode, {}, messageId, sessionId, display.tools)
  }

  // AI SDK structural/control parts carry no visible content — render nothing
  // (don't fall through to the unknown-part card and spam a box per step).
  if (typeof type === "string" && SILENT_CONTROL_PART_TYPES.has(type)) return null

  // gap1 — unknown non-tool part: surface a debuggable fallback card instead
  // of silently dropping it (mirrors the always-visible unknown-`tool-` card).
  return <UnknownPartCard key={key} part={part} />
}
