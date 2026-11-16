/**
 * Lark's per-person authorizations (ADR-0243 phase 4, the delegated lane),
 * behind the vendor seam's `delegatedCredentials` hook (`./contribution.ts`).
 *
 * A person's authorization is the token pair the Host store keeps under their
 * key (`larkUserKey`) and their record in `settings.authorizedUsers`; the
 * connection row each one publishes is `host-auth.ts`'s. A link is an OAuth
 * sign-in issued to exactly that person (`issuedTo`), which the callback
 * refuses to anyone else.
 */

import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type {
  DelegatedAuthorization,
  DelegatedCredentialState,
} from "@/lib/connectors/vendor-contribution"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import {
  connectorOAuthRelayPath,
  resolveConnectorsIngressBase,
  resolveConnectorApiBase,
} from "@/lib/connectors/server-transport"
import { isTauri } from "@/lib/tauri"
import { beginLarkOAuth } from "@/lib/auth-providers/feishu/oauth-begin"
import { reconcileLarkConnection } from "@/lib/auth-providers/feishu/host-auth"
import type { LarkConnectedUser } from "@/lib/auth-providers/feishu/oauth-handler"
import { larkAuthorizedUsers, larkPerson, larkUserKey } from "@/lib/auth-providers/feishu/user-key"

/** The key of a Lark person of this adapter; another adapter's people have none here. */
async function keyOf(row: AdapterInstanceRow, person: PrincipalRefV1): Promise<string> {
  if (person.kind !== "platform" || person.platform !== "lark" || person.adapterId !== row.id)
    throw new Error("lark_person_foreign")
  return larkUserKey(person.remoteUserId)
}

export async function larkDelegatedState(
  row: AdapterInstanceRow,
  person: PrincipalRefV1
): Promise<DelegatedCredentialState> {
  const principal = await keyOf(row, person)
  if (!larkAuthorizedUsers(row.settings)[principal]) return { status: "needs-authorization" }
  const snapshot = await connectorsLarkUserAuth({
    action: "snapshot",
    adapterId: row.id,
    principal,
  })
  return snapshot.configured && snapshot.accessToken
    ? { status: "authorized", epoch: snapshot.authorizationEpoch }
    : { status: "needs-authorization" }
}

/**
 * The relay the console registered: the adapter's saved redirect, else the
 * deployment's own `{ingressBase}{relayPath}` (a self-hosted brain).
 */
function larkRedirectUri(row: AdapterInstanceRow): string {
  const saved = typeof row.settings.redirectUri === "string" ? row.settings.redirectUri.trim() : ""
  if (saved) return saved
  const base = resolveConnectorsIngressBase({
    isDesktop: isTauri(),
    publicBase:
      resolveConnectorApiBase() || (typeof window === "undefined" ? null : window.location.origin),
  })
  if (!base) throw new Error("redirect_uri_unresolved")
  return `${base}${connectorOAuthRelayPath("lark")}`
}

export async function beginLarkDelegatedAuthorization(
  row: AdapterInstanceRow,
  person: PrincipalRefV1
): Promise<string> {
  const begun = await beginLarkOAuth({
    adapterId: row.id,
    issuedTo: await keyOf(row, person),
    redirectUri: larkRedirectUri(row),
    brand: row.settings.brand === "lark" ? "lark" : "feishu",
  })
  return begun.authorizeUrl
}

export async function listLarkDelegatedAuthorizations(
  row: AdapterInstanceRow
): Promise<DelegatedAuthorization[]> {
  return Object.values(larkAuthorizedUsers(row.settings)).map((user) => ({
    person: larkPerson(row.id, user),
    ...(user.name ? { name: user.name } : {}),
    ...(user.authorizedAtMs ? { authorizedAt: user.authorizedAtMs } : {}),
  }))
}

/**
 * Forget one person's authorization: the Host store's epoch moves on (so a
 * parked run re-checks and refuses), their record leaves `authorizedUsers`,
 * their connection row retires, and the owner's also signs the connector out
 * of its user identity. The token names stay in `credentialsRef` so deleting
 * the adapter still purges them.
 */
export async function revokeLarkDelegatedAuthorization(
  row: AdapterInstanceRow,
  person: PrincipalRefV1
): Promise<void> {
  const principal = await keyOf(row, person)
  const snapshot = await connectorsLarkUserAuth({
    action: "snapshot",
    adapterId: row.id,
    principal,
  })
  if (snapshot.configured)
    await connectorsLarkUserAuth({
      action: "disconnect",
      adapterId: row.id,
      principal,
      expectedAuthorizationEpoch: snapshot.authorizationEpoch,
    })
  const current = await getAdapterInstance(row.id)
  if (current) {
    const { [principal]: revoked, ...kept } = larkAuthorizedUsers(current.settings)
    const owner = current.settings.connectedUser as LarkConnectedUser | undefined
    const signsOutOwner = person.kind === "platform" && owner?.openId === person.remoteUserId
    if (revoked || signsOutOwner) {
      const settings: Record<string, unknown> = { ...current.settings, authorizedUsers: kept }
      if (signsOutOwner) {
        delete settings.connectedUser
        delete settings.sendAsUser
      }
      await updateAdapterInstance(row.id, { settings })
    }
  }
  await reconcileLarkConnection(row.id, principal)
}
