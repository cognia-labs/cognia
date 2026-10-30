/**
 * Who account sync acts for on this profile: the official account's person,
 * their space and the sync Worker to talk to (ADR-0215 phase 2).
 *
 * Only a session of the official issuer counts. A self-hosted deployment's
 * session has no official sync space, and `spaceId` is bound to the issuer
 * string, so staging and production never meet.
 */

import { spaceIdFor } from "@cognia/sync-protocol"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  isOfficialIssuer,
  officialDeployment,
  officialSyncUrl,
  type OfficialDeployment,
} from "@/lib/identity/official-deployment"
import { getActiveLogtoSession } from "@/lib/logto/app-session"
import { readCloudSessionState } from "@/lib/identity/cloud-session"
import type { UserBindingRegistry } from "@/lib/identity/user-binding"
import { decodeJwtPayload, stringClaim } from "@/lib/security/jwt-payload"

export interface SyncSession {
  localAccountId: string
  issuer: string
  /** The person's `usr_` id (the token's `sub`). */
  userId: string
  spaceId: string
  syncUrl: string
  /** A token good right now for this same person, or null once the sign-in lapsed. */
  accessToken(): Promise<string | null>
}

export interface SyncSessionDeps {
  localAccountId?: string
  deployment?: OfficialDeployment | null
  syncUrl?: string
  getSession?: typeof getActiveLogtoSession
  registry?: Pick<UserBindingRegistry, "get">
}

function personOf(accessToken: string): string | null {
  const sub = stringClaim(decodeJwtPayload(accessToken), "sub")
  return sub?.startsWith("usr_") ? sub : null
}

/** The sync session of this profile, or null when it is not signed in to the official account. */
export async function officialSyncSession(deps: SyncSessionDeps = {}): Promise<SyncSession | null> {
  const deployment = deps.deployment === undefined ? officialDeployment() : deps.deployment
  if (!deployment) return null
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  const getSession = deps.getSession ?? getActiveLogtoSession
  const readState = () =>
    readCloudSessionState({
      localAccountId,
      registry: deps.registry,
      resolve: async () => {
        const session = await getSession({ localAccountId })
        return session ? { status: "active" as const, session } : { status: "none" as const }
      },
    })
  const state = await readState()
  if (state.status !== "active" || !isOfficialIssuer(state.session.issuer, deployment)) return null
  const session = state.session
  const userId = personOf(session.accessToken)
  if (!userId) return null
  return {
    localAccountId,
    issuer: deployment.issuer,
    userId,
    spaceId: await spaceIdFor(deployment.issuer, userId),
    syncUrl: deps.syncUrl ?? officialSyncUrl(),
    async accessToken() {
      const latest = await readState()
      if (latest.status !== "active" || !isOfficialIssuer(latest.session.issuer, deployment))
        return null
      const current = latest.session
      // A sign-in as someone else since must not act on this person's space.
      return personOf(current.accessToken) === userId ? current.accessToken : null
    },
  }
}
