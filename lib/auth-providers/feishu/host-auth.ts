/**
 * Lark's Rust credential controller adapted to the Host connection contract
 * (ADR-0246 P5a). An adapter holds one authorization per person (ADR-0243
 * phase 4): each is its own connection row, `hostMetadata.principal` names
 * the person (`larkUserKey`), and every read names the person it is for.
 */
import { larkDeployment } from "@cognia/feishu-protocol"
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
import { withAuthLock } from "@/lib/plugin/auth/connection-credentials"
import {
  ConnectionUnavailableError,
  ConnectionIdentityConflict,
  ReconnectIdentityMismatch,
  ConnectionRevisionChanged,
  getConnectionManager,
  getHostConnectionDriver,
  registerHostConnectionDriver,
  assertHostConnectionCredentialAuthorization,
} from "@/lib/plugin/auth/connection-manager"
import { connectorsKeyringGet, connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { onCredentialsRotated } from "@/lib/connectors/credentials-events"
import { connectorListen, type ConnectorUnlistenFn } from "@/lib/connectors/events"
import { fetchLarkUserInfo, refreshUserToken } from "./auth"
import type { LarkConnectedUser } from "./oauth-handler"
import { beginLarkOAuth } from "./oauth-begin"
import { CONNECTOR_OAUTH_STATE_KEY } from "@/lib/connectors/oauth-state"
import { LARK_OAUTH_RELAY_PATH } from "@/lib/connectors/server-transport"
import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import { larkAuthorizedUsers, larkPerson, larkUserKey } from "./user-key"
import { openUrl } from "@/lib/native/opener"
import {
  admitPersonalCredential,
  LOCAL_PERSON,
  PersonalCredentialRefusedError,
  type PersonalCredentialContext,
} from "@/lib/execution/personal-credential"

let disposeRegistration: (() => void) | undefined

/** Lazy registration also covers built-in reads before the integration runtime has booted. */
export function ensureLarkHostProvider(): void {
  if (getProvider("lark")?.pluginId === null && getHostConnectionDriver("lark")) return
  disposeRegistration?.()
  const disposeDriver = registerHostConnectionDriver("lark", {
    publisher: "cognia",
    synchronize: async (row) => {
      await reconcileLarkConnection(row.hostMetadata!.adapterId, row.hostMetadata!.principal!)
    },
    getCredentials: async (row, authorization) => {
      const adapterId = row.hostMetadata!.adapterId
      const principal = row.hostMetadata!.principal!
      await assertHostConnectionCredentialAuthorization(authorization, adapterId)
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
          principal,
          appId,
          appSecret,
          expectedAuthorizationEpoch: row.hostMetadata.authorizationEpoch,
          brand: adapter.settings.brand === "lark" ? "lark" : "feishu",
          connectionAuthorization: authorization,
        })
      }
      const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId, principal })
      await assertHostConnectionCredentialAuthorization(authorization, adapterId)
      if (
        !snapshot.accessToken ||
        snapshot.authorizationEpoch !== row.hostMetadata!.authorizationEpoch
      )
        throw new ConnectionUnavailableError("needs-reauth")
      return { accessToken: snapshot.accessToken, scopes: [...snapshot.scopes] }
    },
    disconnect: async (row) => {
      const adapterId = row.hostMetadata!.adapterId
      const principal = row.hostMetadata!.principal!
      const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId, principal })
      if (!snapshot.accessToken) return
      await connectorsLarkUserAuth({
        action: "disconnect",
        adapterId,
        principal,
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

type LarkReconcileOptions = {
  expiresAt?: string
  onlyExisting?: boolean
  credentialContext?: PersonalCredentialContext
}

/** The account the connector is signed in as (the owner): their key and person. */
export async function larkOwner(
  adapterId: string
): Promise<{ key: string; person: PrincipalRefV1 } | undefined> {
  const owner = (await getAdapterInstance(adapterId))?.settings.connectedUser as
    LarkConnectedUser | undefined
  return owner?.openId
    ? { key: await larkUserKey(owner.openId), person: larkPerson(adapterId, owner) }
    : undefined
}

/** The key of the account the connector is signed in as, if any. */
export async function larkOwnerKey(adapterId: string): Promise<string | undefined> {
  return (await larkOwner(adapterId))?.key
}

/** The person whose authorization `principal` is on `adapterId`, if they authorized. */
export async function larkAuthorizedPerson(
  adapterId: string,
  principal: string
): Promise<PrincipalRefV1 | undefined> {
  const user = larkAuthorizedUsers((await getAdapterInstance(adapterId))?.settings ?? {})[principal]
  return user ? larkPerson(adapterId, user) : undefined
}

/**
 * Whose Lark authorization a run uses on `adapterId`: the acting principal of
 * a delegated run, otherwise the local person, whose authorization is the
 * connector's signed-in account (the owner's). `key` is absent when that
 * person has no authorization here; `undefined` when the run acts as a
 * person of another adapter or platform.
 */
export async function larkActingPerson(
  adapterId: string,
  credentialContext: PersonalCredentialContext | undefined
): Promise<{ person: PrincipalRefV1; key?: string } | undefined> {
  if (credentialContext?.sessionId || credentialContext?.executionRunId) {
    const { resolveRunActingIdentity } = await import("@/lib/execution/acting-authority")
    const identity = await resolveRunActingIdentity(
      credentialContext.sessionId,
      credentialContext.executionRunId,
      credentialContext.delivery ? { delivery: true } : undefined
    )
    const acting = identity?.lane === "delegated" ? identity.actingPrincipal : undefined
    if (acting?.kind === "platform")
      return acting.platform === "lark" && acting.adapterId === adapterId
        ? { person: acting, key: await larkUserKey(acting.remoteUserId) }
        : undefined
  }
  // Every other run is the local person's, whose Lark account is the owner's.
  const owner = await larkOwner(adapterId)
  return { person: LOCAL_PERSON, ...(owner ? { key: owner.key } : {}) }
}

/** The key of the authorization `larkActingPerson` names, if it can have one. */
export async function larkActingKey(
  adapterId: string,
  credentialContext: PersonalCredentialContext | undefined
): Promise<string | undefined> {
  return (await larkActingPerson(adapterId, credentialContext))?.key
}

/**
 * Publish one person's authorization as their connection row. The snapshot
 * read and its publication run under one per-person auth lock shared by
 * every window, so a stale "not configured" snapshot read in one window
 * cannot tombstone a reauthorization another window has already published.
 */
export async function reconcileLarkConnection(
  adapterId: string,
  principal: string,
  options: LarkReconcileOptions = {}
): Promise<AuthConnectionRow | undefined> {
  if (options.onlyExisting && !getHostConnectionDriver("lark")) return undefined
  ensureLarkHostProvider()
  return withAuthLock(
    `cognia-auth-provider:lark:reconcile:${adapterId}:${principal}`,
    () => publishLarkSnapshot(adapterId, principal, options),
    "provider-reconcile"
  )
}

/** Every person with an authorization or a connection row on `adapterId`. */
async function larkAdapterPrincipals(adapterId: string): Promise<Set<string>> {
  const adapter = await getAdapterInstance(adapterId)
  const principals = new Set(Object.keys(larkAuthorizedUsers(adapter?.settings ?? {})))
  for (const row of await listAuthConnections("lark"))
    if (row.hostMetadata?.adapterId === adapterId && row.hostMetadata.principal)
      principals.add(row.hostMetadata.principal)
  return principals
}

/** Reconcile every person's authorization on `adapterId`. */
export async function reconcileLarkAdapter(
  adapterId: string,
  options: LarkReconcileOptions = {}
): Promise<void> {
  for (const principal of await larkAdapterPrincipals(adapterId))
    await reconcileLarkConnection(adapterId, principal, options)
}

async function publishLarkSnapshot(
  adapterId: string,
  principal: string,
  options: LarkReconcileOptions
): Promise<AuthConnectionRow | undefined> {
  const manager = getConnectionManager()
  const previous = (await listAuthConnections("lark")).filter(
    (row) => row.hostMetadata?.adapterId === adapterId && row.hostMetadata.principal === principal
  )
  const adapter = await getAdapterInstance(adapterId)
  if (!adapter || adapter.type !== "lark") {
    for (const row of previous) await manager.dropHostConnection(row.id)
    return undefined
  }
  const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId, principal })
  if (!snapshot.configured || !snapshot.accessToken) {
    for (const row of previous) await manager.retireHostConnection(row.id)
    return undefined
  }
  const appId = (await connectorsKeyringGet(adapterId, "appId"))?.trim()
  if (!appId) throw new ConnectionUnavailableError("needs-reauth")
  const authorized = larkAuthorizedUsers(adapter.settings)
  let user = authorized[principal]
  const brand = adapter.settings.brand === "lark" ? "lark" : "feishu"
  if (!user?.openId || !user.tenantKey || user.authorizationEpoch !== snapshot.authorizationEpoch) {
    // Metadata reconciliation must not silently perform a user-authenticated read.
    if (!user?.openId) throw new ConnectionUnavailableError("identity-unavailable")
    const decision = await admitPersonalCredential(options.credentialContext, {
      source: "lark-user",
      person: larkPerson(adapterId, user),
    })
    if (!decision.ok) throw new PersonalCredentialRefusedError(decision)
    const identity = await fetchLarkUserInfo(snapshot.accessToken, brand)
    if (
      !identity.openId ||
      !identity.tenantKey ||
      (await larkUserKey(identity.openId)) !== principal
    )
      throw new ConnectionUnavailableError("identity-unavailable")
    const current = await connectorsLarkUserAuth({ action: "snapshot", adapterId, principal })
    if (current.authorizationEpoch !== snapshot.authorizationEpoch || !current.accessToken)
      throw new ConnectionUnavailableError("authorization-changed")
    user = {
      ...user,
      ...identity,
      authorizationEpoch: snapshot.authorizationEpoch,
      expiresAtMs: user.expiresAtMs ?? 0,
      refreshExpiresAtMs: user.refreshExpiresAtMs ?? 0,
    }
    const owner = adapter.settings.connectedUser as LarkConnectedUser | undefined
    await updateAdapterInstance(adapterId, {
      settings: {
        ...adapter.settings,
        authorizedUsers: { ...authorized, [principal]: user },
        ...(owner?.openId === user.openId ? { connectedUser: user } : {}),
      },
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
      principal,
      person: larkPerson(adapterId, user),
      authorizationEpoch: snapshot.authorizationEpoch,
      credentialVersion: snapshot.refreshRevision ?? undefined,
      bot: snapshot.configured,
      ...(expiresAt ? { expiresAt } : {}),
    },
    adapter.enabled
  )
  return getAuthConnection(ref)
}

/**
 * Stored resources keep their portable adapter id; execution resolves the
 * connection of the person a read is for (`larkActingKey`, `larkOwnerKey`).
 */
export async function resolveLarkConnection(
  adapterId: string,
  principal: string | undefined,
  credentialContext?: PersonalCredentialContext
): Promise<AuthConnectionRow> {
  if (!principal) throw new ConnectionUnavailableError("unavailable")
  const row = await reconcileLarkConnection(adapterId, principal, { credentialContext })
  if (!row) throw new ConnectionUnavailableError("unavailable")
  return getConnectionManager().getConnection(row.id)
}

/** Only the still-current authorization can be marked rejected by a late refresh. */
export async function markLarkNeedsReauth(
  adapterId: string,
  principal: string,
  authorizationEpoch: string,
  refreshRevision?: string | null
): Promise<void> {
  if (!getHostConnectionDriver("lark")) return
  const current = await connectorsLarkUserAuth({ action: "snapshot", adapterId, principal })
  if (
    current.authorizationEpoch !== authorizationEpoch ||
    (refreshRevision !== undefined && current.refreshRevision !== refreshRevision)
  )
    return
  for (const row of await listAuthConnections("lark")) {
    if (
      row.hostMetadata?.adapterId === adapterId &&
      row.hostMetadata.principal === principal &&
      row.hostMetadata.authorizationEpoch === authorizationEpoch
    )
      await getConnectionManager().retireHostConnection(row.id, "needs-reauth")
  }
}

/** UI discovery may supply Host admission; background discovery remains unproven. */
export async function listLarkConnections(
  credentialContext?: PersonalCredentialContext
): Promise<AuthConnectionRow[]> {
  ensureLarkHostProvider()
  for (const adapter of await listAdapterInstancesByType("lark")) {
    try {
      await reconcileLarkAdapter(adapter.id, { credentialContext })
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
    // A reconnect is the same person signing in again.
    ...(row.hostMetadata.principal ? { issuedTo: row.hostMetadata.principal } : {}),
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
            await reconcileLarkAdapter(id)
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
): Promise<{ connection: AuthConnectionRow; adapterId: string; principal: string }> {
  const connection = await getConnectionManager().getConnection(ref as AuthConnectionRef, revision)
  if (
    connection.providerId !== "lark" ||
    connection.ownerPluginId !== null ||
    !connection.hostMetadata?.principal
  )
    throw new ConnectionUnavailableError("provider-mismatch")
  return {
    connection,
    adapterId: connection.hostMetadata.adapterId,
    principal: connection.hostMetadata.principal,
  }
}
