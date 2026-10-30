/**
 * Writing a signed-in identity into the local projection (ADR-0149).
 *
 * This is the concrete half of `IdentityProjectionWriter`, the seam
 * `bindSignedInIdentity` writes through. It lives here rather than inside
 * sign-in because ADR-0149 §6 makes the collaboration server authoritative for
 * these rows: the writer is a cache-fill, and keeping it behind the seam is
 * what lets Batch 3 replace it with "ask the server, then mirror the answer"
 * without touching the sign-in flow.
 *
 * The Org membership written here is derived from the token's
 * `organization_roles` and is therefore a GUESS at what the server will say —
 * good enough to render a badge, never good enough to authorize anything. When
 * the server arrives it overwrites this row; the row's shape does not change.
 */

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import {
  externalIdentityId,
  orgMembershipId,
  type ExternalIdentity,
  type OrgMembership,
} from "@/types/identity"

import type { IdentityProjectionWriter, SignedInIdentity } from "./sign-in"

/**
 * Mirror one signed-in identity into `users` / `orgs` / `orgMemberships` /
 * `externalIdentities`.
 *
 * Sequenced rather than parallel: the membership row names a user and an org,
 * and a reader that arrives between two parallel writes would see a membership
 * pointing at rows that are not there yet.
 */
export async function writeIdentityProjection(
  identity: SignedInIdentity,
  assertAuthCurrent?: () => void
): Promise<void> {
  const { user, org, orgRole, binding } = identity
  const db = getDb()
  const assertCurrent = () => {
    assertAuthCurrent?.()
    if (!db.isOpen() || getDb() !== db || getActiveAccountId() !== binding.localAccountId) {
      throw new Error("The local profile changed while projecting its identity.")
    }
  }
  assertCurrent()

  const external: ExternalIdentity = {
    id: externalIdentityId("logto", binding.logtoSubject, binding.logtoIssuer),
    userId: user.id,
    provider: "logto",
    subject: binding.logtoSubject,
    linkedAt: binding.updatedAt,
  }
  if (binding.logtoIssuer) external.tenant = binding.logtoIssuer
  if (user.displayName) external.label = user.displayName

  // A captured database and one transaction prevent a profile switch between
  // awaits from redirecting later writes into a different person's database.
  await db.transaction(
    "rw",
    [db.users, db.orgs, db.orgMemberships, db.externalIdentities],
    async () => {
      assertCurrent()
      await db.users.put(user)
      assertCurrent()
      if (org) {
        await db.orgs.put(org)
        assertCurrent()
        if (orgRole) {
          const id = orgMembershipId(org.id, user.id)
          const existing = await db.orgMemberships.get(id)
          assertCurrent()
          const membership: OrgMembership = {
            id,
            orgId: org.id,
            userId: user.id,
            role: orgRole,
            createdAt: existing?.createdAt ?? binding.updatedAt,
            updatedAt: binding.updatedAt,
          }
          await db.orgMemberships.put(membership)
          assertCurrent()
        }
      }
      await db.externalIdentities.put(external)
      assertCurrent()
    }
  )
}

export const identityProjection: IdentityProjectionWriter = {
  upsert: writeIdentityProjection,
}
