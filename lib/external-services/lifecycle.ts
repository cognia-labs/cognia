import type { McpServer } from "@cognia/agent-config-types"

import { deleteBrowserProfile } from "@/lib/db/browser-profiles"
import {
  getServiceConnection,
  invalidateCapabilityGrants,
  putServiceConnection,
  removePluginExternalServiceState,
  resumePluginServiceConnections,
  suspendPluginServiceConnections,
} from "@/lib/db/external-services"
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServersByPlugin,
  updateMcpServer,
} from "@/lib/db/mcp-servers"
import { deleteIntegrationAccount } from "@/lib/integrations/ingress-client"
import { getDb } from "@/lib/db/schema"
import { revokeConsumerAccess } from "@/lib/plugin/auth/revoke-consumer-access"
import { queueAccessTeardown, runAccessTeardown } from "./access-teardown"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { deleteMcpCredentials } from "@/lib/mcp/credentials"
import { sha256Hex } from "@/lib/share/hash"
import type { ServiceConnection } from "@/types/external-service"
import type { PluginManifest, PluginMcpServerPresetDef } from "@/types/plugin"

interface ExternalServiceLifecycleDeps {
  listMcpServersByPlugin: typeof listMcpServersByPlugin
  createMcpServer: typeof createMcpServer
  updateMcpServer: typeof updateMcpServer
  getMcpServer: typeof getMcpServer
  getServiceConnection: typeof getServiceConnection
  putServiceConnection: typeof putServiceConnection
  invalidateCapabilityGrants: typeof invalidateCapabilityGrants
  resumePluginServiceConnections: typeof resumePluginServiceConnections
}

const defaultDeps: ExternalServiceLifecycleDeps = {
  listMcpServersByPlugin,
  createMcpServer,
  updateMcpServer,
  getMcpServer,
  getServiceConnection,
  putServiceConnection,
  invalidateCapabilityGrants,
  resumePluginServiceConnections,
}

function hasExternalServicePersistence(): boolean {
  return typeof indexedDB !== "undefined"
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

export async function managedMcpPresetFingerprint(input: {
  pluginId: string
  pluginVersion: string
  serviceId: string
  providerId: string
  preset: PluginMcpServerPresetDef
}): Promise<string> {
  return sha256Hex(
    JSON.stringify(
      canonicalize({
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        serviceId: input.serviceId,
        providerId: input.providerId,
        contributionId: input.preset.id,
        transport: input.preset.transport,
        config: input.preset.config,
        fields: input.preset.fields,
        toolRiskRules: input.preset.toolRiskRules,
      })
    )
  )
}

function managedServerName(pluginId: string, serviceId: string, providerId: string): string {
  return `${pluginId}-${serviceId}-${providerId}`
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

function connectionId(pluginId: string, serviceId: string, providerId: string): string {
  return `plugin:${pluginId}:${serviceId}:${providerId}:account`
}

/** Install/update managed MCP definitions without connecting to the service. */
export async function reconcilePluginExternalServiceConnections(
  pluginId: string,
  manifest: PluginManifest,
  deps: ExternalServiceLifecycleDeps = defaultDeps
): Promise<number> {
  const existingServers = await deps.listMcpServersByPlugin(pluginId)
  let reconciled = 0
  for (const service of manifest.services ?? []) {
    for (const provider of service.providers.filter((entry) => entry.kind === "mcp")) {
      const preset = manifest.mcpServerPresets?.find(
        (entry) => entry.id === provider.contributionId
      )
      if (!preset) continue
      const specFingerprint = await managedMcpPresetFingerprint({
        pluginId,
        pluginVersion: manifest.version,
        serviceId: service.id,
        providerId: provider.id,
        preset,
      })
      const managedBy = {
        pluginId,
        serviceId: service.id,
        providerId: provider.id,
        contributionId: provider.contributionId,
        sourceVersion: manifest.version,
        specFingerprint,
      }
      let server = existingServers.find(
        (candidate) =>
          candidate.managedBy?.serviceId === service.id &&
          candidate.managedBy.providerId === provider.id
      )
      const changed = Boolean(server && server.managedBy?.specFingerprint !== specFingerprint)
      if (!server) {
        server = await deps.createMcpServer({
          name: managedServerName(pluginId, service.id, provider.id),
          displayName: preset.name,
          transport: preset.transport,
          config: preset.config as McpServer["config"],
          enabled: false,
          origin: "plugin",
          pluginId,
          trust: { state: "pending" },
          managedBy,
          toolRiskRules: preset.toolRiskRules,
          disallowedTools: preset.defaultDisallowedTools,
        })
      } else if (changed) {
        await deps.updateMcpServer(server.id, {
          displayName: preset.name,
          transport: preset.transport,
          config: preset.config as McpServer["config"],
          enabled: false,
          trust: { state: "pending" },
          origin: "plugin",
          pluginId,
          managedBy,
          toolRiskRules: preset.toolRiskRules,
        })
        server = (await deps.getMcpServer(server.id)) ?? server
      }

      const id = connectionId(pluginId, service.id, provider.id)
      const existing = await deps.getServiceConnection(id)
      const now = new Date().toISOString()
      const row: ServiceConnection = {
        id,
        pluginId,
        serviceId: service.id,
        providerId: provider.id,
        runtimeTargetId: "local",
        accountLabel: preset.name,
        status: changed
          ? "pending"
          : existing?.status === "suspended"
            ? (existing.suspendedFromStatus ?? "pending")
            : (existing?.status ?? "pending"),
        providerFingerprint: specFingerprint,
        providerRef: { kind: "mcp", serverId: server.id },
        enabledSurfaces: existing?.enabledSurfaces ?? provider.surfaces,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await deps.putServiceConnection(row)
      if (changed) await deps.invalidateCapabilityGrants(id, specFingerprint)
      reconciled += 1
    }
  }
  await deps.resumePluginServiceConnections(pluginId)
  return reconciled
}

export async function suspendPluginExternalServices(pluginId: string): Promise<number> {
  if (!hasExternalServicePersistence()) return 0
  return suspendPluginServiceConnections(pluginId)
}

/** Revoke a consumer, never its shared Host connections. Runs before runtime teardown. */
export async function removePluginConnectionAccess(
  pluginId: string,
  purgeData = false
): Promise<void> {
  if (!hasExternalServicePersistence()) return
  const db = getDb()
  const refs = new Set<AuthConnectionRef>()
  for (const account of await db.integrationAccounts.where("pluginId").equals(pluginId).toArray())
    if (account.connectionId) refs.add(account.connectionId as AuthConnectionRef)
  for (const binding of await db.connectionBindings
    .filter((row) => row.consumerPluginId === pluginId)
    .toArray())
    refs.add(binding.connectionRef)
  for (const ref of refs) await revokeConsumerAccess(ref, pluginId, { removeAccounts: true })
  await db.transaction("rw", db.connectionBindings, db.capabilityGrants, async () => {
    await db.connectionBindings.filter((row) => row.consumerPluginId === pluginId).delete()
    await db.capabilityGrants.filter((row) => row.consumerPluginId === pluginId).delete()
  })
  if (purgeData) {
    const target = { kind: "plugin-data" as const, pluginId }
    await queueAccessTeardown(target)
    await runAccessTeardown(target)
  }
}

/** Terminal lifecycle cleanup including provider-owned credentials and profiles. */
export async function purgePluginExternalServices(pluginId: string): Promise<void> {
  if (!hasExternalServicePersistence()) return
  const target = { kind: "plugin-data" as const, pluginId }
  await queueAccessTeardown(target)
  await runAccessTeardown(target)
  const removed = await removePluginExternalServiceState(pluginId)
  for (const serverId of removed.mcpServerIds) {
    const server = await getMcpServer(serverId)
    if (server) await deleteMcpCredentials(server)
    await deleteMcpServer(serverId)
  }
  for (const accountId of removed.integrationAccountIds) {
    // Keep the account/route identity while a best-effort purger still owes
    // work. A startup retry can then find data beyond the dead-letter window.
    const account = await getDb().integrationAccounts.get(accountId)
    if (
      account?.connectionId &&
      (await getDb()
        .integrationAudit.where("kind")
        .equals("access.cleanup.pending")
        .filter((row) => {
          const target = row.detail?.target as
            | { kind?: string; ref?: string; consumerPluginId?: string; pluginId?: string }
            | undefined
          return target?.kind === "plugin-data"
            ? target.pluginId === pluginId
            : target !== undefined &&
                target.ref === account.connectionId &&
                (target.kind === "connection" || target.consumerPluginId === pluginId)
        })
        .count())
    )
      continue
    await deleteIntegrationAccount(pluginId, accountId)
  }
  for (const profileId of removed.browserProfileIds) {
    await deleteBrowserProfile(profileId)
  }
}
