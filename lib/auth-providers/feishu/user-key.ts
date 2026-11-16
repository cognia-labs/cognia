/**
 * ADR-0243 phase 4: a Lark adapter holds one user authorization per person.
 * The Host names a person's tokens, epoch and pending sign-ins by the hex
 * SHA-256 of their app-scoped `open_id` (the adapter already fixes the app),
 * matching `lark_user_credential` in `crates/cognia-connectors/src/keyring.rs`.
 */
import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import { sha256Hex } from "@/lib/data/crypto"
import type { LarkConnectedUser } from "./oauth-handler"

/** The key of the person whose `open_id` this is. */
export function larkUserKey(openId: string): Promise<string> {
  return sha256Hex(openId)
}

/**
 * The store credentials one person's authorization occupies on an adapter,
 * all listed in `credentialsRef` so deleting the adapter purges them.
 */
export function larkUserCredentials(key: string): string[] {
  return [`user_token.${key}`, `user_refresh_token.${key}`, `user_authorization_epoch.${key}`]
}

/** The store credential of the pending sign-in whose OAuth `state` is `state`. */
export async function larkPendingCredential(state: string): Promise<string> {
  return `oauth_pending.${await sha256Hex(state)}`
}

/**
 * Everyone who authorized this adapter, by `larkUserKey`: the display record
 * of each person's authorization (`settings.authorizedUsers`). The tokens
 * stay in the Host store; `settings.connectedUser` names which of them the
 * connector is signed in as (the owner).
 */
export function larkAuthorizedUsers(
  settings: Record<string, unknown>
): Record<string, LarkConnectedUser> {
  const users = settings.authorizedUsers
  if (!users || typeof users !== "object" || Array.isArray(users)) return {}
  return Object.fromEntries(
    Object.entries(users as Record<string, unknown>).filter(
      (entry): entry is [string, LarkConnectedUser] =>
        /^[0-9a-f]{64}$/.test(entry[0]) &&
        !!entry[1] &&
        typeof (entry[1] as LarkConnectedUser).openId === "string"
    )
  )
}

/** The person `user` is on this adapter, as acting identities and marks name them. */
export function larkPerson(
  adapterId: string,
  user: { openId: string; unionId?: string }
): PrincipalRefV1 {
  return {
    kind: "platform",
    platform: "lark",
    adapterId,
    remoteUserId: user.openId,
    ...(user.unionId ? { unionId: user.unionId } : {}),
  }
}
