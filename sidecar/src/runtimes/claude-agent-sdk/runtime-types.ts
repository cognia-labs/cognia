import type { Options, SDKUserMessage, Query } from "@anthropic-ai/claude-agent-sdk"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { InputStream } from "../../shared/input-stream.ts"
import type { HostRpcCaller } from "../../tools/state/host-background-shells.ts"
import type { PendingApproval } from "../../policy/permission/approval.ts"
import type { PendingPluginToolCalls } from "../../tools/plugin/proxy.ts"
import type { PendingPluginHooks } from "../../hooks/kernel/types.ts"
import type { ToolSessionContext } from "../../tools/session.ts"
import type { createDoomLoopGuard } from "../../policy/doom-loop.ts"
import type { createStderrLogSink } from "../../mcp/client/log.ts"
import type { createMcpAutoReconnector } from "../../mcp/client/auto-reconnect.ts"
import type { CallRefusal, createCallLedgerGate } from "../common/call-ledger-gate.ts"
import type { buildToolSurface } from "./tool-surface.ts"
import type { createAnthropicSession } from "./session.ts"
import type { warmPool } from "./warm-pool.ts"

export type Emit = (frame: Record<string, unknown>) => void
export type Log = (level: string, message: string) => void
export interface RuntimeEvent {
  type?: string
  session_id?: string
  [key: string]: unknown
}
export interface RuntimeQuery extends AsyncIterable<RuntimeEvent> {
  interrupt(): unknown
  close?(): void
  waitForProcessExit?(): Promise<void>
  /** Every CLI leader has exited, independent of stop proof. */
  waitForLeaderExit?(): Promise<void>
  reconnectMcpServer?(name: string): Promise<void>
  reloadPlugins?: Query["reloadPlugins"]
}
export interface BaseContext {
  sessionId: string
  sendOptions: SendOptions
  emit: Emit
  log: Log
  hostRpc?: HostRpcCaller | null
}
export interface DispatchParams extends BaseContext {
  firstPrompt: SDKUserMessage["message"]["content"]
}
export interface RuntimeDeps {
  query?: (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => RuntimeQuery
  pool?: Pick<ReturnType<typeof warmPool>, "claim" | "prewarm">
  platform?: NodeJS.Platform
  ensurePolicyCompatibility?(options: Options, signal: AbortSignal): Promise<void>
}
export interface SurfaceContext extends BaseContext {
  toolSession: ToolSessionContext
  pendingPluginToolCalls: PendingPluginToolCalls
}
export type LedgerGate = ReturnType<typeof createCallLedgerGate>
export interface OptionsContext extends BaseContext {
  mcpStderrSink: ReturnType<typeof createStderrLogSink>
  ledgerGate: LedgerGate
  sdkFallbackModel: string | undefined
  sdkMaxBudgetUsd: number | undefined
  toolSession: ToolSessionContext
  pendingApprovals: Map<string, PendingApproval>
  pendingPluginHookCalls: PendingPluginHooks
  doomGuard: ReturnType<typeof createDoomLoopGuard>
  interruptForLedger(refusal?: CallRefusal): void
  surface: ReturnType<typeof buildToolSurface>
}
/**
 * Why this process stopped the turn, when it did: a Stop or teardown
 * (`"interrupted"`), or a stop that is a failure the turn must report — a
 * spent run budget, a worker fence, a ledger refusal. The SDK answers every
 * one of them with the same `aborted_*` result frame, so the pump reads the
 * cause from here to end the turn honestly (`pump.ts`).
 */
export type TurnStopCause =
  | "interrupted"
  | {
      error: string
      code?: string
      routerFusionRefusal?: { code: string; message?: string }
    }

/** Per-query turn state shared by the session, the runtime and the pump. */
export interface AnthropicTurnState {
  outstandingPrompts: number
  stopCause?: TurnStopCause
}

export interface SessionContext {
  q: RuntimeQuery
  inputStream: InputStream<SDKUserMessage>
  doomGuard: ReturnType<typeof createDoomLoopGuard>
  sessionId: string
  emit: Emit
  ledgerGate: LedgerGate
  pendingApprovals: Map<string, PendingApproval>
  pendingPluginToolCalls: PendingPluginToolCalls
  pendingPluginHookCalls: PendingPluginHooks
  sendOptions: SendOptions
  finishRuntime?(): void
}
export interface PumpContext extends BaseContext {
  q: RuntimeQuery
  mcpAutoReconnect: ReturnType<typeof createMcpAutoReconnector>
  pluginToolNameAliases: Map<string, string>
  session: ReturnType<typeof createAnthropicSession>["session"]
  state: AnthropicTurnState
  mcpStderrSink: ReturnType<typeof createStderrLogSink>
  toolSession: ToolSessionContext
  waitForProcessExit(): Promise<void>
  /** Leader lifecycle for turn settlement; falls back to `waitForProcessExit`. */
  waitForLeaderExit?(): Promise<void>
}
