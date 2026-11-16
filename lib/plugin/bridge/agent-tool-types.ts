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
  remoteExecutionContext?: RemoteExecutionContext
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
