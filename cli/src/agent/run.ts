/**
 * Legacy one-shot entry point — now a pure ADAPTER over the unified runtime.
 *
 * This module used to carry a second, parallel orchestration: its own sidecar
 * bootstrap, its own MCP/skill resolution, its own twin fetch, its own plugin
 * subscription and its own transcript writes, all duplicating what the
 * persistent session already did. The two had drifted — only the persistent
 * path subscribed the plugin-tool dispatcher unconditionally (so a one-shot
 * `ask_user` hung forever), only it honoured the stream-idle watchdog, and only
 * it registered per-turn subagent dispatch — which meant a caller's behaviour
 * depended on which entry point it happened to reach.
 *
 * All of that now lives in `runtime/unified-runtime`. What remains here is
 * parameter mapping and nothing else: **no lifecycle, no context assembly, no
 * persistence, no retry.** It exists so callers that cannot move atomically
 * keep compiling for one migration release. New code should call
 * {@link runUnifiedTurn} directly and consume `AgentRunResultV1`.
 */

import type { AgentWorkspaceCaptureReceipt } from "@cognia/agent-config-types/agent-run-result"

import { captureEventFromCanonical } from "@/lib/ai/agent/execution/event-envelope"
import type { CaptureStreamEvent, RunAndCaptureResult } from "@/lib/claude/run-and-capture"

import type { ResolvedConfig } from "../config/schema"
import type { PermissionResponder } from "./permission-gate"
import type { TranscriptFs } from "./transcript"
import { runUnifiedTurn, type UnifiedTurnParams } from "./runtime/unified-runtime"

/** Mint a session id matching the desktop's `s_<base36ts><rand>` convention. */
export function mintSessionId(now: number = Date.now(), rand: number = Math.random()): string {
  return `s_${now.toString(36)}${rand.toString(36).slice(2, 8)}`
}

export interface RunHeadlessParams {
  config: ResolvedConfig
  prompt: string
  /** Reuse an existing session id (resume/handoff); minted when omitted. */
  sessionId?: string
  persist?: boolean
  /** Permission responder (from `createPermissionGate`). */
  gate: PermissionResponder
  /** Incremental stream events for rendering. */
  onEvent?: (event: CaptureStreamEvent) => void
  signal?: AbortSignal
  timeoutMs?: number
  /** Agentic step budget for this turn ({@link UnifiedTurnParams.maxSteps}). */
  maxSteps?: number
  home?: string
  /** Narrow this turn's resolved options (tool-less text generation only). */
  resolveOptions?: UnifiedTurnParams["resolveOptions"]
  onAttachments?: UnifiedTurnParams["onAttachments"]
  transcriptFs?: TranscriptFs
  now?: number
}

export interface RunHeadlessResult {
  sessionId: string
  text: string
  usage?: RunAndCaptureResult["usage"]
  sdkSessionId?: string
  workspaceCapture?: AgentWorkspaceCaptureReceipt
}

export class RunHeadlessError extends Error {
  constructor(
    code: string,
    message: string,
    readonly workspaceCapture?: AgentWorkspaceCaptureReceipt
  ) {
    super(message)
    this.name = code
  }
}

/**
 * Run one headless turn and return its captured reply.
 *
 * Preserves the old THROWING contract: callers here catch and map to their own
 * exit codes. `runUnifiedTurn` returns failures as data instead, which is what
 * new callers should use.
 */
export async function runHeadlessTurn(params: RunHeadlessParams): Promise<RunHeadlessResult> {
  const { result } = await runUnifiedTurn({
    config: params.config,
    prompt: params.prompt,
    gate: params.gate,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.persist !== undefined ? { persist: params.persist } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.maxSteps !== undefined ? { maxSteps: params.maxSteps } : {}),
    ...(params.home ? { home: params.home } : {}),
    ...(params.resolveOptions ? { resolveOptions: params.resolveOptions } : {}),
    ...(params.onAttachments ? { onAttachments: params.onAttachments } : {}),
    ...(params.transcriptFs ? { transcriptFs: params.transcriptFs } : {}),
    ...(params.now !== undefined ? { now: () => params.now as number } : {}),
    ...(params.onEvent
      ? {
          onEnvelope: (envelope) => {
            // The legacy callback speaks the capture union; kinds with no
            // capture representation (lifecycle, retry, resource…) are
            // envelope-only and simply do not reach it.
            const event = captureEventFromCanonical(envelope.event)
            if (event) params.onEvent?.(event)
          },
        }
      : {}),
  })

  if (result.error) {
    throw new RunHeadlessError(result.error.code, result.error.message, result.workspaceCapture)
  }

  return {
    sessionId: result.sessionId,
    text: result.text,
    ...(result.usage ? { usage: result.usage as RunAndCaptureResult["usage"] } : {}),
    ...(result.nativeSessionId ? { sdkSessionId: result.nativeSessionId } : {}),
    ...(result.workspaceCapture ? { workspaceCapture: result.workspaceCapture } : {}),
  }
}
