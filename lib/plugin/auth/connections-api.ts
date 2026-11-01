import type { PluginAuthConnectionsAPI } from "@cognia/plugin-contract/lib/plugin/api/auth-api"
import type { AuthConnectionMetadata } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type { PluginIntegrationDef } from "@cognia/plugin-contract/types/plugin/plugin-integration"
import { getAuthConnection, listAuthConnections } from "@/lib/db/auth-connections"
import {
  listConnectionBindings,
  putConnectionBinding,
  removeConnectionBinding,
} from "@/lib/db/connection-bindings"
import { createIntegrationAccount } from "@/lib/db/integrations"
import { listServiceConnections, putCapabilityGrant } from "@/lib/db/external-services"
import { getPlugin } from "@/lib/db/plugins"
import { listRegisteredIntegrations } from "@/lib/integrations/registry"
import { AuthConnectionApiError, connectionAccess, connectionMetadata } from "./connection-access"
import { getConnectionManager } from "./connection-manager"
import { getProvider, listProviders } from "./auth-provider-registry"
import { connectProvider } from "./connect"
import { requestConnectionPrompt, type ConnectionGrantOperation } from "./connection-prompts"

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const HTTP_METHODS = new Set([
  ...READ_METHODS,
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "CONNECT",
  "TRACE",
])

function targetOperations(pluginId: string, providerId: string, operations: string[]) {
  const targets = new Map<PluginIntegrationDef, ConnectionGrantOperation[]>()
  for (const operation of operations) {
    // CapabilityGrant uses pattern syntax. A consumer can approve exact ids
    // only, even when its own manifest attempts to declare a wildcard id.
    if (operation.includes("*"))
      throw new AuthConnectionApiError("unknown-operation", `Operation must be exact: ${operation}`)
    const matches = listRegisteredIntegrations(pluginId).flatMap((definition) => {
      if (!definition.authStrategies.some((strategy) => strategy.providerId === providerId))
        return []
      const actions = definition.actions.filter(
        (candidate) => (candidate.operationId ?? `${definition.id}.${candidate.id}`) === operation
      )
      const method = operation.startsWith(`${definition.id}.request.`)
        ? operation.slice(`${definition.id}.request.`.length)
        : undefined
      const raw = method !== undefined && HTTP_METHODS.has(method)
      return [
        ...actions.map((action) => ({
          definition,
          operation: {
            id: operation,
            label: action.label,
            integrationLabel: definition.label,
            risk: action.risk,
          } satisfies ConnectionGrantOperation,
        })),
        ...(raw
          ? [
              {
                definition,
                operation: {
                  id: operation,
                  label: operation,
                  integrationLabel: definition.label,
                  risk: READ_METHODS.has(method) ? "read" : "write",
                } satisfies ConnectionGrantOperation,
              },
            ]
          : []),
      ]
    })
    // Ambiguous semantic ids must not silently grant more than the user selected.
    if (matches.length !== 1)
      throw new AuthConnectionApiError(
        "unknown-operation",
        `Unknown or ambiguous operation: ${operation}`
      )
    const { definition, operation: item } = matches[0]
    targets.set(definition, [...(targets.get(definition) ?? []), item])
  }
  return targets
}

export function createAuthConnectionsAPI(
  pluginId: string,
  hasPermission: (permission: string) => boolean
): PluginAuthConnectionsAPI {
  const check = () => {
    if (!hasPermission("auth:consume"))
      throw new Error(
        'ctx.auth.connections requires the "auth:consume" permission to be granted and not revoked.'
      )
  }
  const { checked, visible, connected } = connectionAccess(pluginId, check)
  const name = async () => {
    const manifest = (await checked(() => getPlugin(pluginId)))?.manifest
    return typeof manifest?.name === "string" ? manifest.name : pluginId
  }

  async function list(filter: { providerId?: string; service?: string } = {}) {
    const rows = await checked(() => listAuthConnections(filter.providerId))
    const result: AuthConnectionMetadata[] = []
    for (const row of rows)
      if (await visible(row, filter.service)) result.push(connectionMetadata(row))
    check()
    return result
  }

  return {
    list,
    async get(request) {
      check()
      request = { ...request, scopes: [...(request.scopes ?? [])] }
      if (Boolean(request.providerId) === Boolean(request.service))
        throw new AuthConnectionApiError(
          "invalid-request",
          "Specify exactly one providerId or service"
        )
      const scopes = [...(request.scopes ?? [])]
      const candidates = (await list(request)).filter(
        (row) => row.status === "connected" && scopes.every((scope) => row.scopes.includes(scope))
      )
      const bindings = await checked(() => listConnectionBindings(pluginId))
      for (const binding of bindings) {
        const row = await checked(() => getAuthConnection(binding.connectionRef))
        if (
          !row ||
          row.status === "revoked" ||
          row.status === "tombstoned" ||
          !(await visible(row)) ||
          row.providerId !== binding.providerId
        ) {
          await checked(() => removeConnectionBinding(pluginId, binding.providerId))
          continue
        }
        const candidate = candidates.find((item) => item.ref === binding.connectionRef)
        if (candidate) {
          const current = await connected(candidate.ref)
          if (current && scopes.every((scope) => current.scopes.includes(scope)))
            return connectionMetadata(current)
        }
      }
      let selected: AuthConnectionMetadata | undefined
      if (candidates.length === 1) selected = candidates[0]
      else if (!candidates.length && request.interactive) {
        const providers = []
        for (const provider of listProviders()) {
          if (request.providerId && provider.id !== request.providerId) continue
          if (
            await visible(
              { providerId: provider.id, ownerPluginId: provider.pluginId },
              request.service
            )
          )
            providers.push(provider)
        }
        if (!providers.length) return undefined
        if (providers.length !== 1)
          throw new AuthConnectionApiError(
            "invalid-request",
            "Specify a provider for an ambiguous service"
          )
        const provider = providers[0]
        const pluginName = await name()
        const decision = await checked(() =>
          requestConnectionPrompt({
            kind: "sign-in",
            pluginId,
            pluginName,
            providerId: provider.id,
            providerLabel: provider.label,
            scopes,
          })
        )
        if (decision.kind !== "sign-in") return undefined
        if (
          getProvider(provider.id) !== provider ||
          !(await visible(
            { providerId: provider.id, ownerPluginId: provider.pluginId },
            request.service
          ))
        )
          return undefined
        const ref = await checked(() => connectProvider({ providerId: provider.id, scopes }))
        const row = await connected(ref)
        if (row) selected = connectionMetadata(row)
      } else if (candidates.length > 1 && request.interactive) {
        const pluginName = await name()
        const decision = await checked(() =>
          requestConnectionPrompt({
            kind: "picker",
            pluginId,
            pluginName,
            candidates,
          })
        )
        if (decision.kind === "selected")
          selected = candidates.find((row) => row.ref === decision.ref)
      }
      if (!selected) return undefined
      const current = await connected(selected.ref)
      if (
        !current ||
        !(await visible(current, request.service)) ||
        !scopes.every((scope) => current.scopes.includes(scope))
      )
        return undefined
      const bound = await checked(() =>
        putConnectionBinding(pluginId, current.providerId, current.id, current.revision)
      )
      if (!bound) return undefined
      return connectionMetadata(current)
    },
    async requestGrant(ref, request) {
      check()
      if (
        !Array.isArray(request.operations) ||
        !request.operations.length ||
        request.operations.some((operation) => typeof operation !== "string" || !operation)
      )
        throw new AuthConnectionApiError("invalid-request", "At least one operation is required")
      const operations = [...new Set(request.operations)]
      const scopes = [...new Set(request.scopes ?? [])]
      const connection = await connected(ref)
      if (!connection) return { granted: false, reason: "connection-unavailable" }
      if (!scopes.every((scope) => connection.scopes.includes(scope)))
        return { granted: false, reason: "scopes-unavailable" }
      const targets = targetOperations(pluginId, connection.providerId, operations)
      const granted = {
        granted: true as const,
        ref,
        connectionRevision: connection.revision,
        operations,
        scopes,
      }
      if (connection.ownerPluginId === pluginId) return granted
      const pluginName = await name()
      const decision = await checked(() =>
        requestConnectionPrompt({
          kind: "grant",
          pluginId,
          pluginName,
          connection: connectionMetadata(connection),
          operations: [...targets.values()].flat(),
          scopes,
        })
      )
      if (decision.kind !== "approved")
        return { granted: false, reason: decision.kind === "denied" ? "denied" : "dismissed" }
      const current = await connected(ref)
      if (!current || current.revision !== connection.revision)
        return { granted: false, reason: "connection-unavailable" }
      const currentTargets = targetOperations(pluginId, current.providerId, operations)
      if (
        [...targets.keys()].some((definition) => !currentTargets.has(definition)) ||
        JSON.stringify([...targets.values()]) !== JSON.stringify([...currentTargets.values()])
      )
        throw new AuthConnectionApiError("unknown-operation", "Integration changed during approval")
      for (const [definition, approved] of targets) {
        const account = await checked(() =>
          createIntegrationAccount(pluginId, {
            integrationId: definition.id,
            providerId: current.providerId,
            connectionId: ref,
            authSessionId: current.legacySessionId ?? ref,
            remoteAccountId: current.principalId,
            label: current.accountLabel,
          })
        )
        const projections = (await checked(() => listServiceConnections({ pluginId }))).filter(
          (row) =>
            row.providerRef.kind === "integration" &&
            row.providerRef.accountId === account.id &&
            row.providerRef.authConnectionRef === ref
        )
        if (!projections.length)
          throw new AuthConnectionApiError(
            "projection-unavailable",
            "Integration has no projected service connection"
          )
        for (const projection of projections) {
          await checked(() =>
            putCapabilityGrant({
              id: crypto.randomUUID(),
              connectionId: projection.id,
              consumerPluginId: pluginId,
              connectionRevision: current.revision,
              providerFingerprint: projection.providerFingerprint,
              accountId: account.id,
              operationPatterns: approved.map((item) => item.id),
              allowDestructive: approved.some((item) => item.risk === "destructive"),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            })
          )
        }
      }
      const final = await connected(ref)
      if (!final || final.revision !== current.revision)
        return { granted: false, reason: "connection-unavailable" }
      return granted
    },
    onDidChange(listener, filter) {
      check()
      let active = true
      let pending = Promise.resolve()
      const unsubscribe = getConnectionManager().onDidChange((event, kind) => {
        if (
          !active ||
          !hasPermission("auth:consume") ||
          (filter?.providerId !== undefined && event.providerId !== filter.providerId)
        )
          return
        // Serialize async manifest checks, preserving the manager's event order.
        pending = pending
          .then(async () => {
            if (!active || !hasPermission("auth:consume")) return
            const row = await checked(() => getAuthConnection(event.ref))
            if (!row || !(await visible(row))) return
            if (!active) return
            check()
            const metadata: AuthConnectionMetadata = {
              ref: event.ref,
              providerId: event.providerId,
              accountLabel: event.accountLabel,
              principalKind: event.principalKind,
              issuer: event.issuer,
              tenantLabel: event.tenantLabel,
              scopes: [...event.scopes],
              status: event.status,
              revision: event.revision,
            }
            listener({
              added: kind === "added" ? [metadata] : [],
              removed: kind === "removed" ? [metadata] : [],
              changed: kind === "changed" ? [metadata] : [],
            })
          })
          .catch(() => {
            // A revoked permission or failed manifest lookup must never emit metadata.
          })
      })
      return () => {
        active = false
        unsubscribe()
      }
    },
  }
}
