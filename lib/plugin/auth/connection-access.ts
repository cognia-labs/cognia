import type {
  AuthConnectionMetadata,
  AuthConnectionRef,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getPlugin } from "@/lib/db/plugins"
import { getAuthConnection, type AuthConnectionRow } from "@/lib/db/auth-connections"
import { getAuthProviderOwner } from "./auth-provider-registry"
import { ConnectionUnavailableError, getConnectionManager } from "./connection-manager"

/**
 * Host-only registration seam. Intentionally empty until built-in Lark/Google
 * become Host providers (ADR-0246 P5/P6); no provider-name heuristics.
 */
const hostProviderServices = new Map<string, Set<string>>()

export function registerHostAuthProviderService(providerId: string, serviceId: string): () => void {
  const services = hostProviderServices.get(providerId) ?? new Set<string>()
  services.add(serviceId)
  hostProviderServices.set(providerId, services)
  return () => {
    services.delete(serviceId)
    if (!services.size) hostProviderServices.delete(providerId)
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
function serviceIds(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : []
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
        ? [...(hostProviderServices.get(row.providerId) ?? [])]
        : serviceIds((await checked(() => getPlugin(owner)))?.manifest.providesServices)
    if (service !== undefined && !services.includes(service)) return false
    if (owner === pluginId) return true
    const consumer = await checked(() => getPlugin(pluginId))
    const requested = new Set([
      ...serviceIds(consumer?.manifest.requiresServices),
      ...serviceIds(consumer?.manifest.optionalServices),
    ])
    return services.some((id) => (service === undefined || id === service) && requested.has(id))
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
