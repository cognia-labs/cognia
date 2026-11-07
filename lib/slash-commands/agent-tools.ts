/**
 * First-class `SlashCommand` tool, host-routed like the promoted web tools.
 *
 * Claude Code parity: lets the model invoke a registered slash command. The
 * command runs through the live registry (`lib/slash-commands/registry`), so
 * plugin commands and any command with a real handler execute fully.
 *
 * HONEST LIMITATION: the app's built-in UI commands (e.g. /goal, /model,
 * /limits) register renderer-only stub handlers — invoking them through this
 * tool returns their "run it from the chat composer" guidance rather than
 * performing the UI action. This matches Claude Code's SlashCommand semantics
 * (it triggers the command; whether the command can run headless is the
 * command's concern).
 *
 * The slash-commands module's tool family (ADR-0250 §14 amendment):
 * host-routed (renderer + CLI) because the registry and command handlers are
 * TS the sidecar can't import. Offered on every host once the user turned
 * `selfInvokeTools.slashCommand` on, with the registered commands listed in
 * its description.
 */

import type {
  ModuleToolEntry,
  ModuleToolFamily,
  ToolSurfaceContext,
} from "@/lib/modules/manifest-types"
import { withHostCommandExecution } from "@/lib/plugin/core/invocation-identity"

export const SLASH_COMMAND_TOOL_NAME = "SlashCommand"

const SLASH_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "The full slash command line to run, e.g. `/status` or `/deploy staging`. The leading slash is optional.",
    },
  },
  required: ["command"],
} as const

/** A listable command, narrowed to what the manifest description needs. */
export interface SlashCommandSummary {
  name: string
  description?: string
}

/**
 * The SlashCommand tool's entry. When command summaries are supplied, they're
 * embedded in the description so the model can discover what exists;
 * otherwise a generic description is used.
 */
export function buildSlashCommandToolEntries(
  commands: SlashCommandSummary[] = []
): ModuleToolEntry[] {
  const list = commands
    .slice(0, 60)
    .map((c) => `- /${c.name}${c.description ? `: ${c.description}` : ""}`)
    .join("\n")
  const description =
    "Run a registered slash command. Plugin commands and commands with a real handler execute fully; " +
    "the app's built-in UI commands return guidance to run them from the chat composer." +
    (list ? `\nAvailable commands:\n${list}` : "")
  return [
    {
      name: SLASH_COMMAND_TOOL_NAME,
      description,
      jsonSchema: SLASH_SCHEMA as unknown as Record<string, unknown>,
    },
  ]
}

export interface SlashToolRunDeps {
  /** Dispatch a command line through the registry. Returns its result, or null. */
  dispatch?: (
    line: string,
    ctx: { sessionId?: string }
  ) => Promise<{ message?: string; payload?: Record<string, unknown> } | null>
}

/**
 * Execute the SlashCommand tool host-side: normalise the command line and
 * dispatch it through the registry, returning the command's message/payload as
 * text. Returns an error string when the command is unknown or dispatch fails.
 */
export async function runSlashCommandTool(
  name: string,
  args: Record<string, unknown>,
  deps: SlashToolRunDeps,
  ctx: { sessionId?: string } = {}
): Promise<unknown> {
  if (name !== SLASH_COMMAND_TOOL_NAME) return `Error: unknown slash tool: ${name}`
  const raw = String(args?.command ?? "").trim()
  if (!raw) return "Error: the SlashCommand tool requires a `command`."
  const line = raw.startsWith("/") ? raw : `/${raw}`
  if (!deps.dispatch) return "Error: slash commands are not available in this environment."

  const result = await deps.dispatch(line, ctx)
  if (result === null) {
    return `Error: unknown slash command: ${line.split(/\s+/)[0]}`
  }
  if (result.message && result.payload) {
    return `${result.message}\n\n${JSON.stringify(result.payload, null, 2)}`
  }
  if (result.message) return result.message
  if (result.payload) return JSON.stringify(result.payload, null, 2)
  return `Command ${line.split(/\s+/)[0]} ran (no output).`
}

let depsOverride: (() => Promise<SlashToolRunDeps> | SlashToolRunDeps) | null = null

/** Inject SlashCommand-tool deps (tests / CLI host). Pass `null` to restore the default. */
export function __setSlashToolDepsForTesting(
  fn: (() => Promise<SlashToolRunDeps> | SlashToolRunDeps) | null
): void {
  depsOverride = fn
}

async function resolveSlashToolDeps(): Promise<SlashToolRunDeps> {
  if (depsOverride) return depsOverride()
  try {
    const { dispatchSlashCommand } = await import("./registry")
    return { dispatch: (line, ctx) => dispatchSlashCommand(line, ctx) }
  } catch {
    return {}
  }
}

export const toolFamily: ModuleToolFamily = {
  async surface(ctx: ToolSurfaceContext) {
    if (ctx.settings?.selfInvokeTools?.slashCommand !== true) return null
    const { listSlashCommands } = await import("./registry")
    return {
      tools: buildSlashCommandToolEntries(
        listSlashCommands().map((command) => ({
          name: command.name,
          description: command.description,
        }))
      ),
    }
  },
  async run(name, args, call) {
    const context = { sessionId: call.sessionId }
    const deps = await resolveSlashToolDeps()
    // The command runs as a host command of the calling conversation, under
    // the run the tool call belongs to, never one the arguments name.
    return withHostCommandExecution(
      context,
      { sessionId: call.sessionId, executionRunId: call.executionRunId },
      () => runSlashCommandTool(name, args, deps, context)
    )
  },
}
