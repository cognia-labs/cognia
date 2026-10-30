/**
 * Merging the login person with the people the IM adapters already know.
 *
 * ADR-0149 section 3: the User is the subject and external identities hang
 * off it. A Feishu bot has been filing `lark` subjects (open ids, tenant
 * keys) as principals long before anyone signed in through Feishu, and a
 * GitHub login was an identity nobody recorded at all. This is the join: the
 * collaboration server reads the person's Logto identities (the connector
 * targets and provider ids) and this module writes them onto the canonical
 * `User`, so `resolveExternalPerson` finds the same person whether the door
 * was a chat message or a sign-in.
 *
 * # One-way, and never a silent merge
 *
 * A subject that already points at ANOTHER user is a conflict, not a
 * takeover: two Users may exist for one human (an IM-first principal and a
 * login-first one), and collapsing them is a data migration somebody must
 * confirm. Conflicts are returned to the caller and left as they were.
 */

import { findUserIdByExternalIdentity, linkExternalIdentity } from "@/lib/db/identity"
import { getDb } from "@/lib/db/schema"
import {
  EXTERNAL_IDENTITY_PROVIDERS,
  type ExternalIdentity,
  type ExternalIdentityProvider,
} from "@/types/identity"

import type { CollabExternalIdentity } from "@/lib/collab/client"

/** Logto connector target (or anything a server calls it) to the local vocabulary. */
export function externalProviderFor(target: string): ExternalIdentityProvider | null {
  const normalized = target.trim().toLowerCase()
  if (normalized === "feishu-web" || normalized === "feishu" || normalized === "lark") return "lark"
  if (normalized === "github") return "github"
  return (EXTERNAL_IDENTITY_PROVIDERS as readonly string[]).includes(normalized)
    ? (normalized as ExternalIdentityProvider)
    : null
}

export interface IdentityConflict {
  provider: ExternalIdentityProvider
  subject: string
  tenant?: string
  /** The user the subject already belongs to. Left untouched. */
  existingUserId: string
}

export interface LinkSignedInIdentitiesReport {
  linked: ExternalIdentity[]
  conflicts: IdentityConflict[]
  /** Connector targets this vocabulary has no word for. */
  skipped: string[]
}

export interface LinkSignedInIdentitiesDeps {
  find?: typeof findUserIdByExternalIdentity
  link?: typeof linkExternalIdentity
  now?: () => number
}

export async function linkSignedInIdentities(
  input: {
    userId: string
    identities: readonly CollabExternalIdentity[]
    assertCurrent?: () => void
  },
  deps: LinkSignedInIdentitiesDeps = {}
): Promise<LinkSignedInIdentitiesReport> {
  // The lookup and link belong to one profile lifetime and one transaction.
  // Keep injected adapters independent of the browser database.
  const db = deps.find || deps.link ? undefined : getDb()
  const assertCurrent = () => {
    input.assertCurrent?.()
    if (db && (!db.isOpen() || getDb() !== db)) {
      throw new Error("The local profile changed while linking its identities.")
    }
  }
  const find =
    deps.find ??
    ((provider, subject, tenant) => findUserIdByExternalIdentity(provider, subject, tenant, db))
  const link = deps.link ?? ((input) => linkExternalIdentity(input, db))
  const now = (deps.now ?? Date.now)()
  const linkAll = async () => {
    const report: LinkSignedInIdentitiesReport = { linked: [], conflicts: [], skipped: [] }
    assertCurrent()
    for (const identity of input.identities) {
      const provider = externalProviderFor(identity.provider)
      const subject = identity.subject.trim()
      if (!provider || !subject) {
        report.skipped.push(identity.provider)
        continue
      }
      const tenant = identity.tenant?.trim() || undefined
      const existing = await find(provider, subject, tenant)
      assertCurrent()
      if (existing && existing !== input.userId) {
        report.conflicts.push({
          provider,
          subject,
          ...(tenant ? { tenant } : {}),
          existingUserId: existing,
        })
        continue
      }
      report.linked.push(
        await link({
          userId: input.userId,
          provider,
          subject,
          ...(tenant ? { tenant } : {}),
          ...(identity.label ? { label: identity.label } : {}),
          now,
        })
      )
      assertCurrent()
    }
    return report
  }
  const report = db ? await db.transaction("rw", db.externalIdentities, linkAll) : await linkAll()
  assertCurrent()
  return report
}
