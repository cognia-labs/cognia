export * from "@cognia/plugin-contract/types/sandbox/runtime"

export type { SandboxResourcePolicy } from "@cognia/agent-config-types"
export type { E2BBackend, WorkspaceHandle } from "@cognia/plugin-contract/lib/github/workspace"

/** Runtime operations are mounted on `ctx.sandbox` for ownership and permission governance. */
export type { PluginSandboxAPI } from "@cognia/plugin-contract/lib/plugin/api/sandbox-api"
