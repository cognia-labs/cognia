/**
 * Wire types of the plugin-tool exec channel: the sidecar's synthetic
 * `cognia-plugin-tools` MCP server sends a `plugin_tool_exec` request and the
 * Host's dispatcher (`agent-tool-dispatch.ts`) answers with a
 * `plugin_tool_response`. The CLI and headless hosts reuse them.
 */
import type { PluginToolContext } from "@/types/plugin"
import type { RemoteExecutionContext } from "@/lib/ai/agent/execution/remote-execution"

export interface PluginToolExecRequest {
  type: "plugin_tool_exec"
  sessionId: string
  toolUseId: string
  name: string
  args: Record<string, unknown>
  turnId?: string
  runId?: string
  attemptId?: string
  sandboxRuntimeRef?: string
  /** Cooperative cancellation for renderer-hosted calls, including the sidecar bridge. */
  abortSignal?: AbortSignal
  /**
   * How long the asking runtime waits for this call. Past it the runtime has
   * already reported a timeout to the model, so the call is cancelled here as
   * well and its late result never sent. Absent: the runtime waits as long as
   * the call takes.
   */
  timeoutMs?: number
  remoteExecutionContext?: RemoteExecutionContext
}

/**
 * The relay deadline a call gets when its manifest entry names none — the
 * sidecar's own (`DEFAULT_PLUGIN_TOOL_TIMEOUT_MS` in
 * `sidecar/src/tools/plugin/proxy.ts`), so every runtime cuts a call off at
 * the same point.
 */
export const DEFAULT_PLUGIN_TOOL_RELAY_TIMEOUT_MS = 120_000

/**
 * How long a call to a manifest entry declaring `timeoutMs` may run: the
 * entry's own value, the default when it names none, and no deadline for
 * `0` (a tool that blocks on a person or bounds its own long task).
 */
export function pluginToolRelayDeadlineMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return DEFAULT_PLUGIN_TOOL_RELAY_TIMEOUT_MS
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined
}

export interface PluginToolExecResponse {
  type: "plugin_tool_response"
  sessionId: string
  toolUseId: string
  result?: unknown
  error?: string
}

/**
 * Resolver for the live plugin registry. Lifted to a module-level slot so
 * unit tests can swap a mock implementation in without touching the real
 * plugin manager singleton (which throws when uninitialised in jsdom).
 */
export interface PluginToolResolver {
  /**
   * Look up a plugin tool by its bare name. Returns `undefined` when the
   * tool is unknown or its owning plugin is disabled.
   */
  getTool(name: string):
    | {
        pluginId: string
        execute: (args: Record<string, unknown>, context: PluginToolContext) => Promise<unknown>
      }
    | undefined
  /**
   * Per-plugin runtime config snapshot, surfaced inside the
   * {@link PluginToolContext} passed to `execute`. Returning `undefined`
   * is treated as "no config" and the context falls through to `{}`.
   */
  getPluginConfig?: (pluginId: string) => Record<string, unknown> | undefined
}
