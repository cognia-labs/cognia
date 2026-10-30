/**
 * Filesystem authority is narrower than an agent's advertised file tools.
 * This policy lives with capture because runtime installation and UI capability
 * catalogs do not establish that the execution Host observes those files.
 * A remote placement receipt can further restrict an otherwise local adapter.
 */
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

export type WorkspaceCaptureSupport =
  { available: true } | { available: false; reason: "remote-filesystem" | "unsupported-runtime" }

const CWD_PROCESS_PROTOCOLS: ReadonlySet<string> = new Set([
  "acp",
  "codex-app-server",
  "codex-siwc-app-server",
  "pi-rpc",
  "aider-cli",
  "openclaude-cli",
  "continue-cli",
  "dsh-sdk",
  "codebuff-sdk",
])

const OWNED_SERVICE_PROTOCOLS: ReadonlySet<string> = new Set([
  "opencode",
  "opencode-v2",
  "crush-http",
  "rovo-http",
])

/** Unknown/custom adapters must establish a cwd-consuming Host execution rail first. */
export function externalAgentWorkspaceCaptureSupport(
  config:
    | Pick<ExternalAgentConfig, "protocol" | "transport" | "process" | "network" | "metadata">
    | undefined
): WorkspaceCaptureSupport {
  if (!config) return { available: false, reason: "unsupported-runtime" }
  if (config.protocol === "a2a") return { available: false, reason: "remote-filesystem" }
  if (CWD_PROCESS_PROTOCOLS.has(config.protocol) && config.transport === "stdio") {
    return { available: true }
  }
  // Even a loopback endpoint can be a tunnel or another container's filesystem.
  // An explicit endpoint is not a receipt from Cognia's process launcher.
  if (config.network?.endpoint || config.protocol === "acp") {
    return { available: false, reason: "remote-filesystem" }
  }
  if (OWNED_SERVICE_PROTOCOLS.has(config.protocol)) {
    return config.process?.command || config.metadata?.autoSpawnServer === true
      ? { available: true }
      : { available: false, reason: "remote-filesystem" }
  }
  return { available: false, reason: "unsupported-runtime" }
}
