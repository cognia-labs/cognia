/** Portable contracts for plugin-provided external-agent protocol adapters. */

import { BaseProtocolAdapter as RuntimeProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"

import type {
  AcpAvailableCommand,
  AcpCapabilities,
  AcpElicitationResponse,
  AcpMcpServerConfig,
  AcpPermissionResponse,
  AcpToolInfo,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentProtocol,
  ExternalAgentResult,
  ExternalAgentSession,
} from "@cognia/plugin-contract/types/agent/external-agent"

export { defineExternalAgentAdapter } from "../define/define-external-agent-adapter"

export type { PluginExternalAgentAdapterDef } from "@cognia/plugin-contract/types/plugin/plugin-external-agent-adapter"
export type {
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentCogniaModelBinding,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentMessageDeltaEvent,
  ExternalAgentProtocol,
  ExternalAgentSession,
  ExternalAgentTransport,
} from "@cognia/plugin-contract/types/agent/external-agent"

export interface SessionListOptions {
  cwd?: string
}

export interface SessionCreateOptions {
  cwd?: string
  additionalDirectories?: string[]
  mcpServers?: AcpMcpServerConfig[]
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"
  allowedTools?: string[]
  context?: Record<string, unknown>
  instructionEnvelope?: {
    hash: string
    developerInstructions: string
    customInstructions?: string
    skillsSummary?: string
    sourceFlags?: Record<string, boolean>
    projectContextSummary?: string
  }
  systemPrompt?: string
  briefMode?: boolean
  timeout?: number
  metadata?: Record<string, unknown>
}

export interface ProtocolAdapter {
  readonly protocol: string
  readonly connectionStatus: ExternalAgentConnectionStatus
  readonly capabilities?: AcpCapabilities
  readonly tools?: AcpToolInfo[]
  connect(config: ExternalAgentConfig): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession>
  closeSession(sessionId: string): Promise<void>
  prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent>
  execute(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult>
  respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void>
  respondToElicitation?(response: AcpElicitationResponse): Promise<void>
  cancel(sessionId: string): Promise<void>
  getSession(sessionId: string): ExternalAgentSession | undefined
  getSessions(): ExternalAgentSession[]
  healthCheck(): Promise<boolean>
}

export type ProtocolAdapterFactory = () => ProtocolAdapter

export { foldUsageUpdate, mergeTurnUsage } from "@cognia/agent-runtime-kit/base-adapter"

/**
 * Compatibility surface for plugin authors. Collection, usage, artifacts and
 * session helpers belong to the runtime kit; the SDK keeps its existing
 * create-session options and void cancel contract.
 */
export abstract class BaseProtocolAdapter
  extends RuntimeProtocolAdapter
  implements ProtocolAdapter
{
  abstract createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession>
  abstract cancel(sessionId: string): Promise<void>
}

export const SUPPORTED_EXTERNAL_AGENT_PROTOCOLS = [
  "acp",
  "codex-app-server",
  "dsh-sdk",
  "pi-rpc",
  "opencode",
  "opencode-v2",
  "a2a",
] as const

export interface ExternalAgentExecutionBlockAssessment {
  code: "agent_disabled" | "protocol_unsupported" | "transport_blocked"
  reason: string
  transient?: boolean
}

export function isSupportedExternalAgentProtocol(
  protocol: ExternalAgentProtocol
): protocol is (typeof SUPPORTED_EXTERNAL_AGENT_PROTOCOLS)[number] {
  return SUPPORTED_EXTERNAL_AGENT_PROTOCOLS.includes(
    protocol as (typeof SUPPORTED_EXTERNAL_AGENT_PROTOCOLS)[number]
  )
}

export function getExternalAgentExecutionBlock(
  config: ExternalAgentConfig,
  runtimeSupportsExternalAgents = false
): ExternalAgentExecutionBlockAssessment | null {
  if (!config.enabled) return { code: "agent_disabled", reason: "Agent is disabled." }
  if (!isSupportedExternalAgentProtocol(config.protocol)) {
    return {
      code: "protocol_unsupported",
      reason: config.protocol.includes(":")
        ? `Protocol "${config.protocol}" is provided by a plugin adapter that is not currently registered.`
        : `Protocol "${config.protocol}" is not executable yet.`,
      transient: config.protocol.includes(":"),
    }
  }
  if (config.transport === "stdio" && !runtimeSupportsExternalAgents) {
    return {
      code: "transport_blocked",
      // The desktop app is one runtime that can start a process, not the only
      // one. A browser or phone paired to a Host starts the agent on the Host,
      // so naming Tauri here told an author with a working setup to go get a
      // different app. The host application decides which of the two it is and
      // passes the answer in, so the wording stays runtime neutral.
      reason:
        "The stdio transport needs a runtime that can start a process: the desktop app, or a paired Host.",
    }
  }
  return null
}

export function getExternalAgentExecutionBlockReason(
  config: ExternalAgentConfig,
  runtimeSupportsExternalAgents = false
): string | null {
  return getExternalAgentExecutionBlock(config, runtimeSupportsExternalAgents)?.reason ?? null
}

export type PluginProtocolAdapterMetadata = {
  pluginId: string
  adapterId: string
  protocol: string
}

export type ProtocolAdapterRegistryChange = {
  type: "registered" | "unregistered"
  protocol: string
  pluginId?: string
}

/** Command vocabulary is exposed for adapters that surface provider slash commands. */
export type { AcpAvailableCommand }
