/**
 * JSON Schemas for the terminal module's four `terminal_dock_*` tools
 * (`./agent-tools.ts`), which the module's manifest declares as its tools
 * contribution (ADR-0250 §14 amendment). They travel to the SDK sidecar on
 * the `pluginTools` wire under `cognia-terminal-builtin`, and the sidecar's
 * `cognia-plugin-tools` MCP server proxies each call back through
 * `plugin_tool_exec` to `./dock-tool-handler.ts`.
 *
 * Wire format: plain JSON Schema objects (not zod). The sidecar's
 * `jsonSchemaToZodShape` (`sidecar/src/tools/plugin/json-schema-zod.ts`)
 * converts each on registration so the MCP tool validates arguments
 * before the proxy roundtrip.
 */

/** The prefix every dock tool's name carries before its action. */
export const TERMINAL_DOCK_TOOL_PREFIX = "terminal_dock_"

export const TERMINAL_DOCK_SPAWN_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "Command to type into the new tab once it is opened. Leave empty for an idle shell.",
    },
    cwd: {
      type: "string",
      description:
        "Working directory for the new tab. Must exist. Defaults to the active project root.",
    },
    shell: {
      type: "string",
      description:
        "Shell binary path or name (bash, zsh, pwsh, fish, nu, …). Defaults to the platform default.",
    },
    projectId: {
      type: "string",
      description: "Bind the tab to this project so it shows under the project's dock filter.",
    },
    timeoutSec: {
      type: "integer",
      minimum: 5,
      maximum: 600,
      description:
        "Maximum wait for command_end after writing `command`. Defaults to the user's runInDockTimeoutSec setting.",
    },
  },
  required: [],
  additionalProperties: false,
} as const

export const TERMINAL_DOCK_WRITE_SCHEMA = {
  type: "object",
  properties: {
    tabId: {
      type: "string",
      description: "Identifier of the dock tab to type into.",
    },
    command: {
      type: "string",
      description:
        "Bytes to write to the PTY's stdin. The renderer appends a carriage return so the shell submits the command.",
    },
    timeoutSec: {
      type: "integer",
      minimum: 5,
      maximum: 600,
      description:
        "Maximum wait for the next command_end OSC 633 D event. Defaults to runInDockTimeoutSec.",
    },
  },
  required: ["tabId", "command"],
  additionalProperties: false,
} as const

export const TERMINAL_DOCK_READ_RECENT_SCHEMA = {
  type: "object",
  properties: {
    tabId: {
      type: "string",
      description: "Identifier of the dock tab to read history from.",
    },
    lineLimit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Maximum number of most-recent command records to return.",
    },
  },
  required: ["tabId"],
  additionalProperties: false,
} as const

export const TERMINAL_DOCK_WAIT_FOR_EXIT_SCHEMA = {
  type: "object",
  properties: {
    tabId: {
      type: "string",
      description: "Identifier of the dock tab to wait on.",
    },
    timeoutSec: {
      type: "integer",
      minimum: 5,
      maximum: 600,
      description:
        "Maximum wait for the in-flight command to complete. Defaults to runInDockTimeoutSec.",
    },
  },
  required: ["tabId"],
  additionalProperties: false,
} as const

/** Enumeration of the 4 supported action names (without the `terminal_dock_` prefix). */
export type TerminalDockAction = "spawn" | "write" | "read_recent" | "wait_for_exit"

export const TERMINAL_DOCK_ACTIONS: ReadonlyArray<TerminalDockAction> = Object.freeze([
  "spawn",
  "write",
  "read_recent",
  "wait_for_exit",
])
