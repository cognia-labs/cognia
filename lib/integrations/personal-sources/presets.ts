/**
 * Canonical personal data source presets and MCP provisioning helpers (`F7`).
 *
 * Bridges built-in Lark CLI capabilities (`lark.calendar.*`, `lark.task.*`) and
 * standard stdio MCP servers for Gmail, Google Calendar, and Microsoft 365 /
 * Outlook behind one guided setup contract:
 *  - Secrets are persisted exclusively through `createMcpServer` /
 *    `updateMcpServer` -> `externalizeMcpSecrets` into the OS keyring
 *    (`mcp/<serverId>/env/<KEY>`), never stored as plaintext in Dexie.
 *  - Outbound write tools (`send_email`, `send_mail`, `reply_email`,
 *    `forward_email`, `send_calendar_invite`) are registered in
 *    `lib/policy/risk/outbound-tools.ts` so ADR-0239 recipient enforcement (`F2`)
 *    governs them automatically.
 */

import type { McpConfigValue, McpServer } from "@cognia/agent-config-types"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import {
  createMcpServer,
  listMcpServers,
  reviewMcpServer,
  updateMcpServer,
} from "@/lib/db/mcp-servers"
import { externalizeMcpSecrets, isMcpSecretRef } from "@/lib/mcp/credentials"
import { normalizeMcpNamespace } from "@/lib/mcp/server-definition"

export type PersonalDataSourceId = "lark" | "gmail" | "google-calendar" | "outlook"

export interface PersonalDataSourcePreset {
  id: PersonalDataSourceId
  kind: "builtin-cli" | "mcp-stdio"
  mcpServerName?: string
  defaultCommand: string
  defaultArgs: readonly string[]
  secretEnvKey?: string
  readCapabilities: readonly string[]
  outboundWriteTools: readonly string[]
  docsUrl: string
}

export const PERSONAL_DATA_SOURCE_PRESETS: readonly PersonalDataSourcePreset[] = [
  {
    id: "lark",
    kind: "builtin-cli",
    defaultCommand: "lark-cli",
    defaultArgs: ["auth", "login"],
    readCapabilities: [
      "lark.calendar.agenda_today",
      "lark.calendar.list_events",
      "lark.task.list_my_tasks",
    ],
    outboundWriteTools: ["lark.calendar.create_event", "lark.task.assign"],
    docsUrl: "https://open.feishu.cn/document/home/index",
  },
  {
    id: "gmail",
    kind: "mcp-stdio",
    mcpServerName: "personal-gmail",
    defaultCommand: "npx",
    defaultArgs: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
    secretEnvKey: "GMAIL_CLIENT_SECRET",
    readCapabilities: ["search_emails", "read_email", "list_email_labels"],
    outboundWriteTools: ["send_email", "reply_email", "forward_email"],
    docsUrl: "https://github.com/GongRzhe/Gmail-MCP-Server",
  },
  {
    id: "google-calendar",
    kind: "mcp-stdio",
    mcpServerName: "personal-google-calendar",
    defaultCommand: "npx",
    defaultArgs: ["-y", "@cocal/google-calendar-mcp"],
    secretEnvKey: "GOOGLE_CALENDAR_CLIENT_SECRET",
    readCapabilities: ["list-calendars", "list-events", "get-freebusy"],
    outboundWriteTools: ["send_calendar_invite"],
    docsUrl: "https://github.com/nspady/google-calendar-mcp",
  },
  {
    id: "outlook",
    kind: "mcp-stdio",
    mcpServerName: "personal-outlook",
    defaultCommand: "npx",
    defaultArgs: ["-y", "@softeria/ms-365-mcp-server"],
    secretEnvKey: "MS365_CLIENT_SECRET",
    readCapabilities: ["list-mail-messages", "list-calendar-events", "list-todo-tasks"],
    outboundWriteTools: ["send_mail", "reply_email", "forward_email", "send_calendar_invite"],
    docsUrl: "https://github.com/Softeria/ms-365-mcp-server",
  },
]

export function getPersonalDataSourcePreset(id: PersonalDataSourceId): PersonalDataSourcePreset {
  const found = PERSONAL_DATA_SOURCE_PRESETS.find((preset) => preset.id === id)
  if (!found) {
    throw new Error(`Unknown personal data source preset: ${id}`)
  }
  return found
}

export function parseCommandArgsLine(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

export async function findPersonalSourceMcpServer(
  sourceId: PersonalDataSourceId
): Promise<McpServer | undefined> {
  const preset = getPersonalDataSourcePreset(sourceId)
  if (!preset.mcpServerName) return undefined
  const targetNs = normalizeMcpNamespace(preset.mcpServerName)
  const servers = await listMcpServers()
  return servers.find((row) => normalizeMcpNamespace(row.name) === targetNs)
}

export interface UpsertPersonalSourceMcpInput {
  sourceId: Exclude<PersonalDataSourceId, "lark">
  displayName?: string
  command?: string
  args?: readonly string[]
  secretValue?: string
  enabled?: boolean
  credentialStore?: KeyringStore
}

/**
 * Create or update the canonical MCP server row for a personal data source.
 * Any provided `secretValue` is externalized to the keyring store before
 * persisting, leaving only `{ secretRef }` in IndexedDB.
 */
export async function upsertPersonalSourceMcpServer(
  input: UpsertPersonalSourceMcpInput
): Promise<McpServer> {
  const preset = getPersonalDataSourcePreset(input.sourceId)
  if (preset.kind !== "mcp-stdio" || !preset.mcpServerName) {
    throw new Error(`Preset ${input.sourceId} does not use an MCP stdio server`)
  }

  const command = input.command?.trim() || preset.defaultCommand
  const args = input.args && input.args.length > 0 ? [...input.args] : [...preset.defaultArgs]
  const enabled = input.enabled ?? true
  const existing = await findPersonalSourceMcpServer(input.sourceId)

  const existingEnv =
    existing?.config &&
    typeof existing.config === "object" &&
    "env" in existing.config &&
    existing.config.env &&
    typeof existing.config.env === "object"
      ? (existing.config.env as Record<string, McpConfigValue>)
      : {}

  const env: Record<string, McpConfigValue> = { ...existingEnv }
  if (preset.secretEnvKey) {
    const trimmedSecret = input.secretValue?.trim()
    if (trimmedSecret) {
      env[preset.secretEnvKey] = trimmedSecret
    } else if (
      existingEnv[preset.secretEnvKey] &&
      isMcpSecretRef(existingEnv[preset.secretEnvKey])
    ) {
      env[preset.secretEnvKey] = existingEnv[preset.secretEnvKey]
    }
  }

  const baseConfig = {
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  }

  if (!existing) {
    let created = await createMcpServer({
      name: preset.mcpServerName,
      displayName: input.displayName?.trim() || preset.mcpServerName,
      transport: "stdio",
      config: input.credentialStore ? { command, args } : baseConfig,
      enabled,
    })
    if (input.credentialStore && Object.keys(env).length > 0) {
      const migrated = await externalizeMcpSecrets(
        { ...created, config: baseConfig },
        input.credentialStore
      )
      await updateMcpServer(created.id, {
        config: migrated.server.config,
      })
    }
    await reviewMcpServer(created.id, true)
    await updateMcpServer(created.id, { enabled })
    created = (await findPersonalSourceMcpServer(input.sourceId)) ?? created
    return created
  }

  const configForUpdate = input.credentialStore
    ? (await externalizeMcpSecrets({ ...existing, config: baseConfig }, input.credentialStore))
        .server.config
    : baseConfig

  await updateMcpServer(existing.id, {
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
    config: configForUpdate,
  })
  await reviewMcpServer(existing.id, true)
  await updateMcpServer(existing.id, { enabled })
  return (await findPersonalSourceMcpServer(input.sourceId))!
}

export async function setPersonalSourceEnabled(
  sourceId: Exclude<PersonalDataSourceId, "lark">,
  enabled: boolean
): Promise<boolean> {
  const existing = await findPersonalSourceMcpServer(sourceId)
  if (!existing) return false
  if (enabled && existing.trust?.state !== "trusted" && existing.trust?.state !== "legacy") {
    await reviewMcpServer(existing.id, true)
  }
  await updateMcpServer(existing.id, { enabled })
  return true
}
