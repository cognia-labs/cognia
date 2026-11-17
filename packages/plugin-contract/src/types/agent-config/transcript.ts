import type { UIMessage } from "ai"
import type { MessageCollaborationMetadata } from "./collaboration"

/**
 * 2: a completed turn carries its {@link TranscriptTurnActivity}, so a reader
 * draws the turn's fold row without its detail.
 */
export const TRANSCRIPT_PROTOCOL_VERSION = 2 as const
export const TRANSCRIPT_TIMELINE_PAGE_DEFAULT = 30
export const TRANSCRIPT_TIMELINE_PAGE_MAX = 100
export const TRANSCRIPT_DETAIL_PAGE_DEFAULT = 100
export const TRANSCRIPT_DETAIL_PAGE_MAX = 200
export const TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT = 2 * 1024 * 1024
export const TRANSCRIPT_SUMMARY_BYTE_LIMIT = 64 * 1024
export const TRANSCRIPT_SUMMARY_MEDIA_LIMIT = 12
/** Ceiling on one turn's activity summary, as JSON. */
export const TRANSCRIPT_ACTIVITY_BYTE_LIMIT = 1024
/** How many distinct tools an activity summary names. */
export const TRANSCRIPT_ACTIVITY_TOOL_LIMIT = 8
/** How long a tool name in an activity summary may be. */
export const TRANSCRIPT_ACTIVITY_TOOL_NAME_MAX = 64

export type TranscriptMediaVariant = "thumbnail" | "canonical"
export type TranscriptDirection = "backward" | "forward"
export type TranscriptErrorCode =
  | "INVALID_PARAMS"
  /** This host does not hold the named session; it is not a malformed request. */
  | "SESSION_NOT_FOUND"
  | "TRANSCRIPT_STALE"
  | "TURN_NOT_FOUND"
  | "TURN_NOT_COMPLETED"
  | "MEDIA_NOT_FOUND"
  /**
   * A write refused because the host's authority (its brain) is not
   * connected; nothing was written (ADR-0250 §4). Retryable.
   */
  | "HOST_UNAVAILABLE"

export interface TranscriptCapabilitiesV1 {
  version: typeof TRANSCRIPT_PROTOCOL_VERSION
  maxTimelinePageSize: number
  maxTurnMessagePageSize: number
  maxTurnMessagePageBytes: number
  maxSummaryBytes: number
  maxSummaryMediaRefs: number
  mediaVariants: TranscriptMediaVariant[]
}

export interface SessionTimelineRequest {
  sessionId: string
  direction?: TranscriptDirection
  cursor?: string
  limit?: number
}

export interface SessionTurnMessagesRequest {
  sessionId: string
  turnKey: string
  revision: number
  detailRevision: number
  cursor?: string
  limit?: number
}

/** Full message shape used only by active turns and lazily fetched details. */
export interface TranscriptMessage {
  id: string
  sessionId: string
  turnKey?: string
  role: UIMessage["role"]
  parts: UIMessage["parts"]
  senderId?: string
  senderKind?: "user" | "assistant" | "system"
  /** A shared session's author record, which names who wrote the message. */
  collaboration?: MessageCollaborationMetadata
  metadata?: Record<string, unknown>
  createdAt: number
}

export interface TranscriptMediaReference {
  ref: string
  mediaType?: string
  filename?: string
}

/** Small, display-safe projection. Tool inputs/results and reasoning are omitted. */
export interface TranscriptMessagePreview {
  id: string
  role: UIMessage["role"]
  text?: string
  media?: TranscriptMediaReference[]
  createdAt: number
  truncated?: boolean
  /**
   * Which agent answered an assistant turn: `route:<handle>` or
   * `preset:<id>`, as `lib/chat/transcript-agents.ts` keys it. Lets a reader
   * of collapsed turns tell when a transcript has several agents without the
   * full message (ADR-0218). Absent on user turns and unstamped turns, and
   * from hosts that do not compute it; an absent key takes no part.
   */
  agentKey?: string
}

export interface TranscriptCollapsedDetail {
  exists: boolean
  messageCount: number
  trailingCount: number
  mediaCount: number
}

/** One tool a turn called, and how often. */
export interface TranscriptActivityTool {
  name: string
  count: number
  /** Calls that ended in an error. */
  failed: number
}

/**
 * What a completed turn did on the way to its answer, without the detail:
 * enough to draw the "Worked for …" row a local turn folds its process into
 * (ADR-0114). Under {@link TRANSCRIPT_ACTIVITY_BYTE_LIMIT}: tool names are
 * clipped and only the first {@link TRANSCRIPT_ACTIVITY_TOOL_LIMIT} named.
 */
export interface TranscriptTurnActivity {
  toolCount: number
  failedCount: number
  reasoningCount: number
  /** Citations and source documents the turn's replies carry. */
  sourceCount: number
  /** Tools by name, in order of first use. */
  tools: TranscriptActivityTool[]
  /** The sealed run's duration (`metadata.run.durationMs`), when it recorded one. */
  runDurationMs?: number
}

export interface TranscriptBranchGroupSummary {
  groupId: string
  selectedMessageId: string
  messageIds: string[]
}

export interface TranscriptBranchSummary {
  groups: TranscriptBranchGroupSummary[]
}

interface TranscriptTimelineItemBase {
  itemKey: string
  revision: number
  startedAt: number
  completedAt?: number
  durationMs?: number
}

export interface CompletedTurnTimelineItem extends TranscriptTimelineItemBase {
  kind: "completed-turn"
  turnKey: string
  detailRevision: number
  status: "completed" | "failed"
  userMessages: TranscriptMessagePreview[]
  finalResponse?: TranscriptMessagePreview
  visibleResult?: TranscriptMessagePreview
  collapsed: TranscriptCollapsedDetail
  /** Present when the turn called a tool or reasoned (protocol 2). */
  activity?: TranscriptTurnActivity
  branchSummary?: TranscriptBranchSummary
}

export interface ActiveTurnTimelineItem extends TranscriptTimelineItemBase {
  kind: "active-turn"
  turnKey: string
  status: "active"
  messages: TranscriptMessage[]
}

export interface SystemTimelineItem extends TranscriptTimelineItemBase {
  kind: "system"
  status: "completed"
  message: TranscriptMessagePreview
}

export type TranscriptTimelineItem =
  CompletedTurnTimelineItem | ActiveTurnTimelineItem | SystemTimelineItem

export interface SessionTimelinePage {
  items: TranscriptTimelineItem[]
  revision: number
  nextCursor?: string
  hasMore: boolean
}

export interface SessionTurnMessagesPage {
  messages: TranscriptMessage[]
  revision: number
  detailRevision: number
  total: number
  approximateBytes: number
  nextCursor?: string
  hasMore: boolean
}

export interface TranscriptProtocolError {
  code: TranscriptErrorCode
  message?: string
}
