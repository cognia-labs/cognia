/**
 * The terminal module's tool family (ADR-0250 §14 amendment): the four
 * `terminal_dock_*` tools through which the agent drives the user's visible
 * dock PTY (open a tab, type into one, read its recent commands, wait for
 * the running one to end). One shell, one cwd, one history for both.
 *
 * Offered only when the person opted in (`settings.terminal.exposeDockToAgents`,
 * off by default), to an agent that keeps plugin tools, and never to a
 * headless host's scratch-workspace session, whose host tools are cut off
 * from the machine. The handler (`./dock-tool-handler.ts`) re-reads the
 * setting on every call, so a toggle off mid-conversation denies the next
 * one even though the tools are already on the model's list.
 */

import type {
  ModuleToolEntry,
  ModuleToolFamily,
  ToolSurfaceContext,
} from "@/lib/modules/manifest-types"
import {
  TERMINAL_DOCK_ACTIONS,
  TERMINAL_DOCK_READ_RECENT_SCHEMA,
  TERMINAL_DOCK_SPAWN_SCHEMA,
  TERMINAL_DOCK_TOOL_PREFIX,
  TERMINAL_DOCK_WAIT_FOR_EXIT_SCHEMA,
  TERMINAL_DOCK_WRITE_SCHEMA,
  type TerminalDockAction,
} from "./dock-tool-schemas"

/** The four tool names, in the order the model is offered them. */
export const TERMINAL_DOCK_TOOL_NAMES: readonly string[] = TERMINAL_DOCK_ACTIONS.map(
  (action) => `${TERMINAL_DOCK_TOOL_PREFIX}${action}`
)

/** The dock tools' manifest entries. */
export function buildTerminalDockToolEntries(): ModuleToolEntry[] {
  return [
    {
      name: "terminal_dock_spawn",
      description:
        "Open a new tab in the user's terminal dock. Optionally type a command, wait for it to finish, and return its exit code and printed output.",
      jsonSchema: TERMINAL_DOCK_SPAWN_SCHEMA,
    },
    {
      name: "terminal_dock_write",
      description:
        "Type input into an existing dock tab (PTY stdin). Waits for the next command_end event, then returns the exit code and the text the command printed.",
      jsonSchema: TERMINAL_DOCK_WRITE_SCHEMA,
    },
    {
      name: "terminal_dock_read_recent",
      description:
        "Return the last N command records (command + exit code + cwd) from a dock tab's OSC 633 ring buffer.",
      jsonSchema: TERMINAL_DOCK_READ_RECENT_SCHEMA,
    },
    {
      name: "terminal_dock_wait_for_exit",
      description:
        "Block until the most-recent command in the named tab emits an OSC 633 D event, then return its exit code, its command line and the output printed while waiting.",
      jsonSchema: TERMINAL_DOCK_WAIT_FOR_EXIT_SCHEMA,
    },
  ]
}

/** Whether a run is offered the dock tools. */
export async function terminalDockToolsOffered(ctx: ToolSurfaceContext): Promise<boolean> {
  if (ctx.settings?.terminal?.exposeDockToAgents !== true) return false
  if (ctx.agent?.disablePluginTools) return false
  if (ctx.host === "brain") {
    const { isSessionScratchWorkspace } = await import("@/lib/task-workspace/managed-workspace")
    if (isSessionScratchWorkspace(ctx.session)) return false
  }
  return true
}

function dockAction(name: string): TerminalDockAction | null {
  if (!name.startsWith(TERMINAL_DOCK_TOOL_PREFIX)) return null
  const action = name.slice(TERMINAL_DOCK_TOOL_PREFIX.length)
  return (TERMINAL_DOCK_ACTIONS as readonly string[]).includes(action)
    ? (action as TerminalDockAction)
    : null
}

export const toolFamily: ModuleToolFamily = {
  async surface(ctx) {
    return (await terminalDockToolsOffered(ctx)) ? { tools: buildTerminalDockToolEntries() } : null
  },
  async run(name, args, call) {
    const action = dockAction(name)
    if (!action) return { ok: false, reason: `unknown terminal dock tool: ${name}` }
    const { runTerminalDockAction } = await import("./dock-tool-handler")
    return runTerminalDockAction({ action, args, chatSessionId: call.sessionId })
  },
}
