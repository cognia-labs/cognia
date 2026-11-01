import type {
  AuthConnectionMetadata,
  AuthConnectionRef,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getPlugin } from "@/lib/db/plugins"
import { getAuthConnection, type AuthConnectionRow } from "@/lib/db/auth-connections"
import { getAuthProviderOwner } from "./auth-provider-registry"
import { ConnectionUnavailableError, getConnectionManager } from "./connection-manager"
import type { IntegrationAuthStrategy } from "@cognia/plugin-contract/types/plugin/plugin-integration"
import { satisfiesConstraint } from "@/lib/plugin/package/dependency-resolver"

/** Host-only service inventory, also projected into each manager's service registry. */
const hostProviderServices = new Map<string, Map<string, string>>()
const hostServiceListeners = new Set<() => void>()

export function hostAuthProviderServices(): Array<{
  providerId: string
  services: Record<string, string>
}> {
  return [...hostProviderServices].map(([providerId, services]) => ({
    providerId,
    services: Object.fromEntries(services),
  }))
}

export function subscribeHostAuthProviderServices(listener: () => void): () => void {
  hostServiceListeners.add(listener)
  return () => {
    hostServiceListeners.delete(listener)
  }
}

export function registerHostAuthProviderService(
  providerId: string,
  serviceId: string,
  version = "1.0.0"
): () => void {
  if (!satisfiesConstraint(version, `=${version}`))
    throw new Error("Host services require an exact semver version")
  const services = hostProviderServices.get(providerId) ?? new Map<string, string>()
  if (services.has(serviceId))
    throw new Error(`Host service ${serviceId} already registered by ${providerId}`)
  services.set(serviceId, version)
  hostProviderServices.set(providerId, services)
  for (const listener of hostServiceListeners) listener()
  let active = true
  return () => {
    if (!active) return
    active = false
    services.delete(serviceId)
    if (!services.size && hostProviderServices.get(providerId) === services)
      hostProviderServices.delete(providerId)
    for (const listener of hostServiceListeners) listener()
  }
}

export class AuthConnectionApiError extends Error {
  constructor(
    readonly code:
      | "connection-unavailable"
      | "provider-mismatch"
      | "integration-unregistered"
      | "unknown-operation"
      | "invalid-request"
      | "projection-unavailable",
    message: string
  ) {
    super(message)
    this.name = "AuthConnectionApiError"
  }
}

/** Explicit allowlist, including fresh copies of arrays; no identity or secret fields. */
export function connectionMetadata(row: AuthConnectionRow): AuthConnectionMetadata {
  return {
    ref: row.id,
    providerId: row.providerId,
    accountLabel: row.accountLabel,
    principalKind: row.principalKind,
    issuer: row.issuer,
    ...(row.tenantLabel !== undefined ? { tenantLabel: row.tenantLabel } : {}),
    scopes: [...row.scopes],
    status: row.status,
    revision: row.revision,
  }
}

/** Installed rows retain a raw manifest; only object service maps name services. */
function serviceMap(value: unknown): Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {}
}

function acceptsService(
  manifest: { requiresServices?: unknown; optionalServices?: unknown } | undefined,
  id: string,
  version: string
): boolean {
  return [
    serviceMap(manifest?.requiresServices)[id],
    serviceMap(manifest?.optionalServices)[id],
  ].some((constraint) => constraint !== undefined && satisfiesConstraint(version, constraint))
}

export async function authStrategyMatchesProvider(
  strategy: IntegrationAuthStrategy,
  providerId: string,
  consumerPluginId: string
): Promise<boolean> {
  if (strategy.type !== "connection") return strategy.providerId === providerId
  if (!strategy.service) return false
  const owner = getAuthProviderOwner(providerId)
  if (owner === undefined) return false
  const services =
    owner === null
      ? Object.fromEntries(hostProviderServices.get(providerId) ?? [])
      : serviceMap((await getPlugin(owner))?.manifest.providesServices)
  const version = services[strategy.service]
  return (
    version !== undefined &&
    acceptsService((await getPlugin(consumerPluginId))?.manifest, strategy.service, version)
  )
}

/** Each public API supplies its permission fence, also across manifest lookups. */
export function connectionAccess(pluginId: string, check: () => void) {
  async function checked<T>(task: () => Promise<T>): Promise<T> {
    check()
    try {
      return await task()
    } finally {
      check()
    }
  }

  async function visible(
    row: Pick<AuthConnectionRow, "providerId" | "ownerPluginId">,
    service?: string
  ): Promise<boolean> {
    check()
    const owner = getAuthProviderOwner(row.providerId)
    if (owner === undefined || owner !== row.ownerPluginId) return false
    const services =
      owner === null
        ? Object.fromEntries(hostProviderServices.get(row.providerId) ?? [])
        : serviceMap((await checked(() => getPlugin(owner)))?.manifest.providesServices)
    if (service !== undefined && services[service] === undefined) return false
    if (owner === pluginId) return true
    const consumer = await checked(() => getPlugin(pluginId))
    return Object.entries(services).some(
      ([id, version]) =>
        (service === undefined || id === service) && acceptsService(consumer?.manifest, id, version)
    )
  }

  async function connected(ref: AuthConnectionRef): Promise<AuthConnectionRow | undefined> {
    const row = await checked(() => getAuthConnection(ref))
    if (!row || !(await visible(row)) || row.status !== "connected") return undefined
    try {
      return await checked(() => getConnectionManager().getConnection(ref))
    } catch (error) {
      if (error instanceof ConnectionUnavailableError) return undefined
      throw error
    }
  }

  return { checked, visible, connected }
}
