// The `identity-principal-links` capability port (ADR-0149 §3, ADR-0215 §9,
// ADR-0250 §14): the platform principals a person already holds learn about
// their sign-in, and lose what a profile binding admitted when it goes away.
// It is a collection port: every module that keeps a principal registry adds a
// member (the connectors' covers each IM vendor that contributes one). The
// identity plane asks through `lib/identity/principal-links.ts` and never
// imports a registry.

import type { ExternalIdentity } from "@/types/identity"

export interface PrincipalSignInAttachInput {
  /** Throws once the local profile changed under the call. */
  assertCurrent?: () => void
  /** The signed-in person. */
  userId: string
  /** Their Logto subject, from the user binding. */
  logtoSubject: string
  /** The external identities the sign-in just linked onto `userId`. */
  identities: readonly ExternalIdentity[]
  now?: number
}

export interface PrincipalSignInAttachReport {
  /** Principals that now carry the login's subject. */
  attached: string[]
  /** Principals the sign-in matched that belong to another person: reported, never taken over. */
  foreign: string[]
}

export interface PrincipalSelfBoundUnlinkInput {
  /** Throws once the local profile changed under the call. */
  assertCurrent?: () => void
  localAccountId: string
  /** The person the profile was bound to before the sign-out or takeover. */
  userId: string
  now?: number
}

export interface IdentityPrincipalLinks {
  /** Record the login's subject on the principals that already belong to the signed-in person. */
  attachSignIn(input: PrincipalSignInAttachInput): Promise<PrincipalSignInAttachReport>
  /**
   * Unlink every principal admitted for the person only because the profile
   * was bound to them. Returns the unlinked principal ids.
   */
  unlinkSelfBound(input: PrincipalSelfBoundUnlinkInput): Promise<string[]>
}

declare module "@/lib/modules/ports" {
  interface PortCollectionMap {
    "identity-principal-links": IdentityPrincipalLinks
  }
}
