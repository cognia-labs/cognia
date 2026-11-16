/**
 * Capture contracts of the run-and-capture runner: the result, partial and
 * error shapes a captured turn settles with, the permission and tool-result
 * decisions its callers return, the runner's options and the fusion turn
 * request. Event narrowing, accounting and approval code import this leaf
 * instead of the executing runner.
 */
import type {
  ApprovalDecision,
  PermissionRequestEvent,
  SDKMessage,
} from "@cognia/agent-config-types"
import type { CanonicalAgentEvent } from "@cognia/agent-config-types/agent-execution"
import type { CaptureStreamEvent } from "@cognia/plugin-contract/lib/claude/run-and-capture"

import type { ApproveToolAttribution } from "@/lib/ai/agent/execution/sidecar-client"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { ExecutionLeaseInfo } from "@/lib/execution/types"
import type {
  ExplicitFusionTurnInput,
  FusionActionChoice,
} from "@/lib/router-fusion/gate/explicit-run"
import type { ExternalAgentEvent } from "@/types/agent/external-agent"
import type { A2UISegmentContent } from "@/types/connectors/segment"

export type { CaptureStreamEvent } from "@cognia/plugin-contract/lib/claude/run-and-capture"

export interface RunAndCaptureResult {
  /** The accumulated assistant reply text (concatenated text blocks). */
  text: string
  /** The middleware replaced raw stream text; transcript owners must discard that raw text. */
  textTransformed?: boolean
  /**
   * The SDK assistant message uuid we captured the text from. Used by the
   * caller as a stable idempotency key so retries don't double-send.
   */
  messageId: string
  /**
   * A2UI surfaces created or updated during this turn, keyed by
   * `surfaceId`. The keys mirror the order the assistant emitted them
   * in `a2uiSurfaceOrder`. Populated when the assistant calls the
   * `builtin:a2ui-bridge` MCP tools (`a2ui_create_surface` /
   * `a2ui_update_components` / `a2ui_data_model_update`); empty when the
   * reply is plain text.
   *
   * The connector auto-mode loop reads these to project A2UI segments
   * into the outbound MessageSegment[] via `assistantReplyToSegments`.
   */
  a2uiSurfaces: Record<string, A2UISegmentContent>
  /**
   * Surface ids in the order the assistant first introduced them. Used
   * by `assistantReplyToSegments` to keep delivery order deterministic
   * across retries.
   */
  a2uiSurfaceOrder: string[]
  /**
   * Token/cost usage for this turn, extracted from the SDK result message at
   * `session_ended` (`undefined` when the result carried no usage). Consumed
   * by headless turn-loop drivers (e.g. the scheduled-goal runner) that need
   * a per-turn `tokensDelta` to feed the goal budget exit condition.
   */
  usage?: UsageInfo
  /**
   * The SDK `result` message subtype for this turn (e.g. `"success"`,
   * `"error_max_turns"`, `"error_max_budget_usd"`). Headless turn-loop drivers
   * read this to detect a hard-ceiling stop and exit the goal accordingly.
   * Undefined when no result subtype was seen.
   */
  resultSubtype?: string
  /** Bounded tool evidence for an explicitly requested budget-stop continuation. */
  budgetContinuationContext?: string
  /**
   * The SDK-issued session id emitted during this turn (`sdk_session_id`
   * event), when one was seen. Headless multi-turn drivers persist this onto
   * the `ChatSession` row so the next send resumes the conversation. Undefined
   * on the text channel / when no event arrived.
   */
  sdkSessionId?: string
  /** Provider-neutral durable conversation at the turn boundary. */
  conversationSnapshot?: unknown[]
  /** Parsed SDK structured output when a JSON-schema output format was requested. */
  structuredOutput?: unknown
}

export class RunAndCaptureError extends Error {
  /**
   * HTTP status behind the failure, when the sidecar forwarded one on
   * `session_ended` (`extractHttpErrorMeta` / `sessionEndedFromResult`).
   *
   * Without it a caller can only classify off `code`, which is a CAPTURE-level
   * label, not an errno — so `unified-runtime`'s `errorFrom` read the presence
   * of `code` as "transport failure" and reported every provider error,
   * including a 404, as `transport_error`.
   */
  readonly httpStatus?: number
  /** `Retry-After` in ms, when the provider sent one. */
  readonly retryAfterMs?: number
  /**
   * What an interrupted (`aborted`) turn had produced when it stopped: the
   * streamed text and the sidecar's provider-conversation snapshot of every
   * completed step. A host that keeps durable history saves it, so a later
   * resume continues from the interrupted work instead of losing it.
   */
  readonly partial?: RunAndCapturePartial

  constructor(
    message: string,
    readonly code:
      | "session_error"
      | "policy_refused"
      | "no_assistant_text"
      | "aborted"
      | "send_failed"
      | "control_lost"
      | "sidecar_exited",
    meta?: { httpStatus?: number; retryAfterMs?: number; partial?: RunAndCapturePartial }
  ) {
    super(message)
    this.name = "RunAndCaptureError"
    if (typeof meta?.httpStatus === "number") this.httpStatus = meta.httpStatus
    if (typeof meta?.retryAfterMs === "number") this.retryAfterMs = meta.retryAfterMs
    if (meta?.partial) this.partial = meta.partial
  }
}

/** See {@link RunAndCaptureError.partial}. */
export interface RunAndCapturePartial {
  text: string
  /** Bounded observed tool evidence/checkpoint for explicit interrupted-child resume. */
  continuationContext?: string
  conversationSnapshot?: unknown[]
  sdkSessionId?: string
}

/**
 * Read a `compact_boundary` system message into the typed {@link CaptureStreamEvent}
 * `compact` shape, or return `null` when `inner` is not a compaction boundary.
 * Shared by the in-stream capture loop and the CLI's between-turn manual-compact
 * runner so both agree on the wire shape (`sidecar/dispatch/ai-sdk.mjs` emits it).
 */
export function compactBoundaryFromInner(
  inner: unknown
): Extract<CaptureStreamEvent, { type: "compact" }> | null {
  const ev = inner as {
    type?: string
    subtype?: string
    compact_metadata?: { trigger?: string; pre_tokens?: unknown; post_tokens?: unknown }
  } | null
  if (!ev || ev.type !== "system" || ev.subtype !== "compact_boundary") return null
  const meta = ev.compact_metadata ?? {}
  const toNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return {
    type: "compact",
    trigger: meta.trigger === "manual" ? "manual" : "auto",
    preTokens: toNum(meta.pre_tokens),
    postTokens: toNum(meta.post_tokens),
  }
}

/**
 * Read an `api_retry` system message into the typed {@link CaptureStreamEvent}
 * `retry` shape, or return `null` when `inner` is not one.
 *
 * The Agent SDK announces every backoff step this way (`sidecar/dispatch/
 * sdk-canonical-events.mjs` maps the same frame onto the canonical `retry`
 * event). `error_status` is `null` on a transport-level failure — the SDK has
 * no HTTP response to report — so it is only forwarded when it is a number.
 */
export function retryFromInner(
  inner: unknown
): Extract<CaptureStreamEvent, { type: "retry" }> | null {
  const ev = inner as {
    type?: string
    subtype?: string
    attempt?: unknown
    max_retries?: unknown
    retry_delay_ms?: unknown
    error_status?: unknown
    error?: unknown
  } | null
  if (!ev || ev.type !== "system" || ev.subtype !== "api_retry") return null
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined
  return {
    type: "retry",
    phase: "scheduled",
    attempt: num(ev.attempt) ?? 0,
    maxRetries: num(ev.max_retries) ?? 0,
    code: "api_retry",
    ...(num(ev.retry_delay_ms) !== undefined ? { delayMs: num(ev.retry_delay_ms) } : {}),
    ...(num(ev.error_status) !== undefined ? { status: num(ev.error_status) } : {}),
    // The SDK reports `"unknown"` for a transport failure it could not
    // classify; carrying it is still better than an unexplained silence.
    ...(typeof ev.error === "string" && ev.error ? { message: ev.error } : {}),
  }
}

/** Decision returned by a {@link RunAndCaptureOptions.onPermissionRequest} responder. */
export interface CapturePermissionDecision {
  decision: ApprovalDecision
  message?: string
  updatedInput?: unknown
  /** Explicit provenance supplied by a responder that knows who decided. */
  attribution?: ApproveToolAttribution
  /**
   * An allow on an outbound ask (ADR-0239, `PermissionRequestEvent.outbound`):
   * the person allowed these recipients for the rest of the request. The
   * outbound policy turns it into {@link grant}.
   */
  forRequest?: boolean
  /** The grant an allowed outbound ask rests on, set by the outbound policy. */
  grant?: import("@cognia/agent-config-types/action-review").ActionReviewGrant
}

/** Tool result + correlated call passed to an {@link RunAndCaptureOptions.onToolResultReview} responder. */
export interface CaptureToolResult {
  toolName: string
  input: Record<string, unknown>
  result: unknown
  isError: boolean
}

/** Decision returned by an {@link RunAndCaptureOptions.onToolResultReview} responder. */
export interface CaptureToolResultDecision {
  /** Rewrite the tool output the model sees. Honored only on the review round-trip. */
  updatedToolOutput?: unknown
}

export interface RunAndCaptureOptions {
  /** Canonical user row, independent of this attempt's wire turnId. */
  currentMessageId?: string
  /** Lossless SDK frames for callers that own transcript persistence. */
  onSdkEvent?: (event: SDKMessage) => void
  /** Lossless external-agent frames for the same transcript owner. */
  onExternalEvent?: (event: ExternalAgentEvent) => void
  /** Validate the accepted source at the actual send boundary, under the transcript lock. */
  beforeSend?: () => Promise<void>
  /**
   * Optional cancellation signal. When the signal aborts, the wrapper
   * detaches its subscription, fires `interruptSession` (best-effort),
   * and rejects with a `RunAndCaptureError({ code: "aborted" })`.
   */
  signal?: AbortSignal
  /**
   * Maximum wall-clock to wait for `session_ended` before rejecting.
   * Defaults to 5 minutes — matches the platform-side default function
   * timeout (Vercel docs note 300s as the default cap). Pass `0` to
   * disable the timeout entirely.
   */
  timeoutMs?: number
  /**
   * Idle (read) timeout in ms. When set > 0, the turn fails if the provider
   * stream goes silent for this long AFTER it has started producing output —
   * the "socket open, no bytes" stall some OpenAI-compatible relays exhibit.
   * Rejects with a `session_error` (recoverable: the session stays alive). The
   * watchdog arms only after the first streamed event and pauses while a
   * permission request is awaiting the user, so slow cold starts and long
   * approvals never trip it. Default `0` (disabled) — independent of the
   * wall-clock {@link timeoutMs}.
   */
  idleTimeoutMs?: number
  /** Retain bounded tool evidence for subagent resume if the turn exhausts its budget. */
  preserveBudgetEvidence?: boolean
  /**
   * Optional incremental-output callback. Fired each time the accumulated
   * assistant text grows (every streamed `assistant` event carries the full
   * text-so-far for our use case, so this receives the running total, not a
   * delta). Used by the connector runtime to drive platform-side streaming
   * replies (WeCom 智能机器人 `aibot_respond_msg` stream frames). Best-effort:
   * a throwing or rejecting callback is swallowed and never affects capture.
   * Default `undefined` → zero behaviour change for chat / non-streaming
   * connectors.
   */
  onPartial?: (accumulatedText: string) => void | Promise<void>
  /**
   * Typed incremental events (text deltas + tool calls) from the assistant
   * stream. Used by the plugin Agent SDK's `runStreamed`. Best-effort: a
   * throwing callback is swallowed. Default `undefined` → no events emitted.
   */
  onEvent?: (event: CaptureStreamEvent) => void
  /**
   * Called at the sidecar send boundary with independent executor stop evidence.
   * Resolves for a disposed runtime session/process, or a
   * rejected send that never handed the turn to the sidecar.
   * Survives capture timeout/abort cleanup; a rejected capture is not stop proof.
   */
  onExecutorStarted?: (stopped: Promise<void>) => void
  /** A send receipt was received; observers may query its owning registry. This is not stop proof. */
  onExecutorAccepted?: (sessionId: string) => void
  /** Lossless canonical stream. Takes precedence over onEvent for canonical
   * delivery; onEvent remains the legacy transport fallback. */
  onCanonicalEvent?: (event: CanonicalAgentEvent) => void
  /** Persist the SDK resume identity as soon as its stream event arrives. */
  onSdkSessionId?: (sdkSessionId: string) => void | Promise<void>
  /**
   * Headless permission responder. When the sidecar emits a
   * `permission_request` (an *ask*-tier tool) for this session, the wrapper
   * calls this and forwards the decision via `approveTool` — including a
   * rewritten `updatedInput`. This is the seam the plugin Agent SDK's
   * `canUseTool` plugs into. When `undefined`, permission requests are left
   * unanswered (legacy behaviour — the turn relies on the chat UI approver or
   * times out). Best-effort: a throwing/rejecting responder denies the call.
   */
  onPermissionRequest?: (
    request: PermissionRequestEvent
  ) => CapturePermissionDecision | Promise<CapturePermissionDecision>
  /**
   * Stop the wall-clock {@link timeoutMs} while a permission request waits for
   * {@link onPermissionRequest}, and resume it with the time that was left
   * once the decision goes out. An unattended turn that parks a request for a
   * person (ADR-0224 A7) sets this: the time a person takes to answer is not
   * the turn running long, and the park bounds that wait on its own. Sidecar
   * turns only; a host-run external agent answers its requests elsewhere.
   */
  pauseTimeoutWhileAwaitingPermission?: boolean
  /**
   * How the outbound policy (ADR-0239) plans this turn's outbound calls ahead
   * of {@link onPermissionRequest}: whether anyone is watching, and the origin
   * of a run that carries its own (a scheduled task, a Bot). Default: an
   * unattended run in its session's origin.
   */
  outboundPolicy?: import("@/lib/policy/action-review/plan-tool-call").OutboundToolPlannerOptions
  /**
   * PostToolUse responder. Called exactly once per tool result: on the ai-sdk
   * channel via the `tool_result_review` round-trip (where a returned
   * `updatedToolOutput` REWRITES what the model sees), and otherwise at
   * observation time (where the return is ignored). The capture loop dedupes so
   * a reviewed tool is never also fired as observation. This is the seam the
   * plugin Agent SDK's `onPostToolUse` hook plugs into. Best-effort: a
   * throwing/rejecting responder leaves the output unchanged.
   */
  onToolResultReview?: (
    request: CaptureToolResult
  ) => CaptureToolResultDecision | void | Promise<CaptureToolResultDecision | void>
  /**
   * Execution-broker admission metadata. This wrapper is the shared chokepoint
   * for every headless leg (connector auto-reply, agent team, scheduled goal,
   * plugin Agent SDK, eval) — none of which went through the foreground chat
   * cap. Admitting here registers the leg with the global {@link
   * getExecutionBroker} so all four subsystems share one ceiling, become
   * observable in one place, and are cancellable as a unit. The broker's
   * `lease.signal` is combined with any {@link signal} above and handed to the
   * underlying capture, so a broker-side cancel actually stops the turn.
   *
   * Defaults: when omitted, the leg is still admitted with kind `"subagent"`
   * and a session-derived label. Set `execution.skip` to bypass admission for a
   * caller that is already governed elsewhere (e.g. a nested re-entry).
   */
  execution?: ExecutionLeaseInfo
  /**
   * Router + Fusion action for this turn (ADR-0188 B5, master plan D3).
   *
   * An agent turn may be run as fusion work instead of as one sidecar turn:
   * `cascade` re-asks a cheap model and escalates, `panel` runs a review board,
   * `delegate` hands the work to a bounded worker graph. `auto` — and omitting
   * the whole object, which is every caller today — is byte-for-byte the
   * existing path, decided by one property read before anything is loaded.
   *
   * The choice runs under the `agentsWorkflows` surface: off, the turn is the
   * sidecar turn it always was; on, the run is routed, reserved and settled
   * through the CallLedger and its verified answer becomes this turn's text.
   */
  fusion?: FusionTurnRequest
  /**
   * Set by a host that keeps its own durable transcript and restores provider
   * history itself (the CLI). The send then skips the app's Dexie transcript
   * preparation, which only knows app sessions. See `sendPrompt` in `@/lib/ai/agent/execution/sidecar-client`.
   */
  transcriptRuntime?: "host-owned"
}

/** What a caller says about this turn's Router + Fusion action. */
export interface FusionTurnRequest {
  /** `auto` (or absent) keeps the existing path untouched. */
  action?: FusionActionChoice
  /** Which run list the turn appears in; `agent` when omitted. */
  origin?: ExplicitFusionTurnInput["origin"]
  /** Stable id of the caller, e.g. `teammate:<id>`. Defaults to the session. */
  featureId?: string
  /** The project the turn belongs to; it may raise the data class (D30). */
  workspaceId?: string | null
  /** The directory the turn works in; a panel may read files there. */
  workspaceRoot?: string | null
  /**
   * The conversation or run whose turns nest (INV-09). Defaults to the chat
   * session id, so an agent turn on a session that is already running a chat
   * fusion turn is refused with `FUSION_RECURSION` rather than nested.
   */
  scopeId?: string | null
  /** Force the ancestor flag; normally derived from {@link scopeId}. */
  hasFusionAncestor?: boolean
  /** The account settings the gate reads; read from this host when omitted. */
  settings?: ExplicitFusionTurnInput["settings"]
  /** Test seam. */
  loadHost?: ExplicitFusionTurnInput["loadHost"]
}
