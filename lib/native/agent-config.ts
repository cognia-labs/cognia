/**
 * Host agent-configuration IO: the Claude user config, other agents' MCP
 * config files (read and write with a backup) and a workspace's read-only
 * project `.mcp.json`.
 */
import type { AgentId } from "@cognia/agent-config-types"

import { transport } from "@/lib/tauri"

export async function readClaudeUserConfig(): Promise<unknown> {
  return transport.call<unknown>("read_claude_user_config")
}

// ---- Multi-agent MCP IO (read / write external agents' config files) -----

export interface AgentReadResult {
  /** Resolved path on this OS, or null when the agent isn't supported here. */
  path: string | null
  exists: boolean
  writable: boolean
  format: "json" | "jsonc" | "toml"
  /** Raw file content (or empty string when missing). */
  raw: string
  /** Parsed canonical JSON tree, or `null` when missing / unparseable. */
  parsed: unknown
  /** Set when the file existed but couldn't be parsed. */
  parseError?: string
}

export async function readAgentConfig(agent: AgentId): Promise<AgentReadResult> {
  return transport.call<AgentReadResult>("read_agent_config", { agent })
}

export interface AgentWriteResult {
  path: string
  backupPath?: string
}

export async function writeAgentConfig(agent: AgentId, value: unknown): Promise<AgentWriteResult> {
  return transport.call<AgentWriteResult>("write_agent_config", { agent, value })
}

/**
 * Read a workspace's project-scoped `.mcp.json`. Read-only: that file is
 * normally committed and shared with the user's teammates, so Cognia imports
 * from it but never writes back.
 */
export async function readProjectMcpConfig(cwd: string): Promise<AgentReadResult> {
  return transport.call<AgentReadResult>("read_project_mcp_config", { cwd })
}
