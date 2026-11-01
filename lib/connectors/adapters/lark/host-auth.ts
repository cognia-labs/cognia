/** Lark's Rust credential controller adapted to the Host connection contract (ADR-0246 P5a). */
import { liveQuery } from "dexie"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import {
  getAdapterInstance,
  listAdapterInstancesByType,
  updateAdapterInstance,
} from "@/lib/db/adapter-instances"
import {
  listAuthConnections,
  getAuthConnection,
  findAuthConnection,
  authConnectionIdentityKey,
  type AuthConnectionRow,
} from "@/lib/db/auth-connections"
import {
  registerAuthenticationProvider,
  getProvider,
} from "@/lib/plugin/auth/auth-provider-registry"
import { registerHostAuthProviderService } from "@/lib/plugin/auth/connection-access"
import {
  ConnectionUnavailableError,
  ConnectionIdentityConflict,
  ReconnectIdentityMismatch,
  ConnectionRevisionChanged,
  getConnectionManager,
  getHostConnectionDriver,
  registerHostConnectionDriver,
} from "@/lib/plugin/auth/connection-manager"
import { connectorsKeyringGet, connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { onCredentialsRotated } from "@/lib/connectors/credentials-events"
import { connectorListen, type ConnectorUnlistenFn } from "@/lib/connectors/events"
import { fetchLarkUserInfo, larkDeployment, refreshUserToken } from "./auth"
import type { LarkConnectedUser } from "./oauth-handler"
import { beginLarkOAuth } from "./oauth-begin"
import { CONNECTOR_OAUTH_STATE_KEY } from "@/lib/connectors/oauth-state"
import { LARK_OAUTH_RELAY_PATH } from "@/lib/connectors/server-transport"
import { openUrl } from "@/lib/native/opener"

let disposeRegistration: (() => void) | undefined

/** Lazy registration also covers built-in reads before the integration runtime has booted. */
export function ensureLarkHostProvider(): void {
  if (getProvider("lark")?.pluginId === null && getHostConnectionDriver("lark")) return
  disposeRegistration?.()
  const disposeDriver = registerHostConnectionDriver("lark", {
    publisher: "cognia",
    synchronize: async (row) => {
      await reconcileLarkConnection(row.hostMetadata!.adapterId)
    },
    getCredentials: async (row) => {
      const adapterId = row.hostMetadata!.adapterId
      const adapter = await getAdapterInstance(adapterId)
      if (!adapter?.enabled) throw new ConnectionUnavailableError("adapter-unavailable")
      if (
        row.hostMetadata?.expiresAt &&
        Date.parse(row.hostMetadata.expiresAt) <= Date.now() + 60_000
      ) {
        const [appId, appSecret] = await Promise.all([
          connectorsKeyringGet(adapterId, "appId"),
          connectorsKeyringGet(adapterId, "appSecret"),
        ])
        if (!appId || !appSecret) throw new ConnectionUnavailableError("needs-reauth")
        await refreshUserToken({
          adapterId,
          appId,
          appSecret,
          expectedAuthorizationEpoch: row.hostMetadata.authorizationEpoch,
          brand: adapter.settings.brand === "lark" ? "lark" : "feishu",
        })
      }
      const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId })
      if (
        !snapshot.accessToken ||
        snapshot.authorizationEpoch !== row.hostMetadata!.authorizationEpoch
      )
        throw new ConnectionUnavailableError("needs-reauth")
      return { accessToken: snapshot.accessToken, scopes: [...snapshot.scopes] }
    },
    disconnect: async (row) => {
      const adapterId = row.hostMetadata!.adapterId
      const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId })
      if (!snapshot.accessToken) return
      await connectorsLarkUserAuth({
        action: "disconnect",
        adapterId,
        expectedAuthorizationEpoch: row.hostMetadata!.authorizationEpoch,
      })
    },
    reauthorize: (ref, options) => authorizeLarkConnection(ref, options.ingressBase),
  })
  let disposeProvider: () => void
  try {
    disposeProvider = registerAuthenticationProvider({
      id: "lark",
      label: "Feishu / Lark",
      pluginId: null,
      getSessions: async () => [],
      createSession: async () => {
        throw new ConnectionUnavailableError("adapter-authorization-required")
      },
      removeSession: async () => {
        throw new ConnectionUnavailableError("connection-reference-required")
      },
    })
  } catch (error) {
    disposeDriver()
    throw error
  }
  const disposeService = registerHostAuthProviderService("lark", "auth.feishu")
  disposeRegistration = () => {
    disposeService()
    disposeProvider()
    disposeDriver()
    disposeRegistration = undefined
  }
}

/** Identity is fetched only for legacy metadata; all token lineage checks remain Rust-owned. */
export async function reconcileLarkConnection(
  adapterId: string,
  options: { expiresAt?: string; onlyExisting?: boolean } = {}
): Promise<AuthConnectionRow | undefined> {
  if (options.onlyExisting && !getHostConnectionDriver("lark")) return undefined
  ensureLarkHostProvider()
  const manager = getConnectionManager()
  const previous = (await listAuthConnections("lark")).filter(
    (row) => row.hostMetadata?.adapterId === adapterId
  )
  const adapter = await getAdapterInstance(adapterId)
  if (!adapter || adapter.type !== "lark") {
    for (const row of previous) await manager.dropHostConnection(row.id)
    return undefined
  }
  const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId })
  if (!snapshot.configured || !snapshot.accessToken) {
    for (const row of previous) await manager.retireHostConnection(row.id)
    return undefined
  }
  const appId = (await connectorsKeyringGet(adapterId, "appId"))?.trim()
  if (!appId) throw new ConnectionUnavailableError("needs-reauth")
  let user = adapter.settings.connectedUser as LarkConnectedUser | undefined
  const brand = adapter.settings.brand === "lark" ? "lark" : "feishu"
  if (!user?.openId || !user.tenantKey || user.authorizationEpoch !== snapshot.authorizationEpoch) {
    const identity = await fetchLarkUserInfo(snapshot.accessToken, brand)
    if (!identity.openId || !identity.tenantKey)
      throw new ConnectionUnavailableError("identity-unavailable")
    const current = await connectorsLarkUserAuth({ action: "snapshot", adapterId })
    if (current.authorizationEpoch !== snapshot.authorizationEpoch || !current.accessToken)
      throw new ConnectionUnavailableError("authorization-changed")
    user = {
      ...user,
      ...identity,
      authorizationEpoch: snapshot.authorizationEpoch,
      expiresAtMs: user?.expiresAtMs ?? 0,
      refreshExpiresAtMs: user?.refreshExpiresAtMs ?? 0,
    }
    await updateAdapterInstance(adapterId, {
      settings: { ...adapter.settings, connectedUser: user },
    })
  }
  const prior = previous.find(
    (row) => row.hostMetadata?.authorizationEpoch === snapshot.authorizationEpoch
  )
  const expiresAt =
    options.expiresAt ??
    prior?.hostMetadata?.expiresAt ??
    (user.expiresAtMs > 0 ? new Date(user.expiresAtMs).toISOString() : undefined)
  const ref = await manager.reconcileHostConnection(
    "lark",
    {
      issuer: larkDeployment(brand).issuer,
      clientId: appId,
      tenantId: user.tenantKey,
      principal: { id: user.openId, kind: "user" },
      accountLabel: snapshot.accountLabel || user.name || user.openId,
      scopes: snapshot.scopes,
    },
    {
      adapterId,
      authorizationEpoch: snapshot.authorizationEpoch,
      credentialVersion: snapshot.refreshRevision ?? undefined,
      bot: snapshot.configured,
      ...(expiresAt ? { expiresAt } : {}),
    },
    adapter.enabled
  )
  return getAuthConnection(ref)
}

/** Stored resources keep their portable adapter id; execution resolves the local connection. */
export async function resolveLarkConnection(
  adapterId: string,
  expectedRevision?: number
): Promise<AuthConnectionRow> {
  const row = await reconcileLarkConnection(adapterId)
  if (!row) throw new ConnectionUnavailableError("unavailable")
  return getConnectionManager().getConnection(row.id, expectedRevision)
}

/** Only the still-current authorization can be marked rejected by a late refresh. */
export async function markLarkNeedsReauth(
  adapterId: string,
  authorizationEpoch: string,
  refreshRevision?: string | null
): Promise<void> {
  if (!getHostConnectionDriver("lark")) return
  const current = await connectorsLarkUserAuth({ action: "snapshot", adapterId })
  if (
    current.authorizationEpoch !== authorizationEpoch ||
    (refreshRevision !== undefined && current.refreshRevision !== refreshRevision)
  )
    return
  for (const row of await listAuthConnections("lark")) {
    if (
      row.hostMetadata?.adapterId === adapterId &&
      row.hostMetadata.authorizationEpoch === authorizationEpoch
    )
      await getConnectionManager().retireHostConnection(row.id, "needs-reauth")
  }
}

export async function listLarkConnections(): Promise<AuthConnectionRow[]> {
  ensureLarkHostProvider()
  for (const adapter of await listAdapterInstancesByType("lark")) {
    try {
      await reconcileLarkConnection(adapter.id)
    } catch {
      console.warn("Lark Host authorization reconciliation pending")
    }
  }
  return listAuthConnections("lark")
}

/** Reject a conflicting provider before publishing a fresh native authorization. */
export async function assertLarkIdentityAvailable(
  adapterId: string,
  appId: string,
  user: { openId: string; tenantKey?: string },
  brand: "feishu" | "lark",
  reconnect?: { ref: string; revision: number }
): Promise<void> {
  if (!user.openId || !user.tenantKey) throw new ConnectionUnavailableError("identity-unavailable")
  const identityKey = authConnectionIdentityKey({
    issuer: larkDeployment(brand).issuer,
    clientId: appId,
    principal: { id: user.openId, kind: "user" },
  })
  if (reconnect) {
    const original = await getAuthConnection(reconnect.ref)
    if (original?.revision !== reconnect.revision)
      throw new ConnectionRevisionChanged(reconnect.ref, reconnect.revision, original?.revision)
    if (
      authConnectionIdentityKey({
        issuer: original.issuer,
        clientId: original.clientId,
        principal: { id: original.principalId, kind: original.principalKind },
      }) !== identityKey ||
      original.tenantId !== user.tenantKey
    )
      throw new ReconnectIdentityMismatch()
  }
  const row = await findAuthConnection(identityKey)
  if (
    row &&
    (row.providerId !== "lark" ||
      row.ownerPluginId !== null ||
      row.publisher !== "cognia" ||
      row.hostMetadata?.adapterId !== adapterId ||
      row.tenantId !== user.tenantKey)
  )
    throw new ConnectionIdentityConflict()
}

/** The settings panel reuses the adapter's PKCE flow and existing relay configuration. */
export async function authorizeLarkConnection(
  ref: string,
  ingressBase?: string | null
): Promise<void> {
  const row = await getAuthConnection(ref)
  if (row?.providerId !== "lark" || row.ownerPluginId !== null || !row.hostMetadata)
    throw new ConnectionUnavailableError("provider-mismatch")
  const adapter = await getAdapterInstance(row.hostMetadata.adapterId)
  if (!adapter || !adapter.enabled) throw new ConnectionUnavailableError("adapter-unavailable")
  const redirectUri =
    typeof adapter.settings.redirectUri === "string" ? adapter.settings.redirectUri.trim() : ""
  const effectiveRedirect =
    redirectUri || (ingressBase ? `${ingressBase}${LARK_OAUTH_RELAY_PATH}` : "")
  if (!effectiveRedirect) throw new ConnectionUnavailableError("redirect-uri-required")
  const begun = await beginLarkOAuth({
    adapterId: adapter.id,
    redirectUri: effectiveRedirect,
    extraScopes: row.scopes.join(" "),
    brand: adapter.settings.brand === "lark" ? "lark" : "feishu",
    connection: { ref: row.id, revision: row.revision },
  })
  if (typeof sessionStorage !== "undefined")
    sessionStorage.setItem(CONNECTOR_OAUTH_STATE_KEY, begun.state)
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(CONNECTOR_OAUTH_STATE_KEY, begun.state)
  } catch {
    /* Rust pending state is authoritative. */
  }
  await openUrl(begun.authorizeUrl)
}

/** Boot + active Host events + adapter deletion. No schema-upgrade backfill. */
export function startLarkHostAuth(): () => void {
  ensureLarkHostProvider()
  let stopped = false
  let queue = Promise.resolve()
  const reconcile = () => {
    queue = queue
      .then(async () => {
        if (stopped) return
        const ids = new Set((await listAdapterInstancesByType("lark")).map((row) => row.id))
        for (const row of await listAuthConnections("lark"))
          if (row.hostMetadata) ids.add(row.hostMetadata.adapterId)
        for (const id of ids) {
          if (stopped) return
          try {
            await reconcileLarkConnection(id)
          } catch {
            console.warn("Lark Host authorization reconciliation pending")
          }
        }
      })
      .catch(() => {
        console.warn("Lark Host authorization reconciliation pending")
      })
  }
  const subscription = liveQuery(() => listAdapterInstancesByType("lark")).subscribe({
    next: reconcile,
    error: () => reconcile(),
  })
  let stopNative: ConnectorUnlistenFn | undefined
  void connectorListen("lark-user-authorization-changed", reconcile)
    .then((unlisten) => {
      if (stopped) unlisten()
      else stopNative = unlisten
    })
    .catch(() => {
      // Web-only hosts have no native listener; lazy reads still reconcile.
    })
  const stopCredentials = onCredentialsRotated(reconcile)
  reconcile()
  return () => {
    stopped = true
    subscription.unsubscribe()
    stopNative?.()
    stopCredentials()
  }
}

/** Host-only adapter lookup; this binding is never projected through ctx.auth.connections. */
export async function larkConnectionAdapter(
  ref: string,
  revision?: number
): Promise<{ connection: AuthConnectionRow; adapterId: string }> {
  const connection = await getConnectionManager().getConnection(ref as AuthConnectionRef, revision)
  if (
    connection.providerId !== "lark" ||
    connection.ownerPluginId !== null ||
    !connection.hostMetadata
  )
    throw new ConnectionUnavailableError("provider-mismatch")
  return { connection, adapterId: connection.hostMetadata.adapterId }
}
