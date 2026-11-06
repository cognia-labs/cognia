/**
 * The issue tracker's side of ADR-0149 §10: every actor written onto the
 * collaboration plane goes through `resolveCollabActor` first.
 *
 * Two writes put an actor there: the assignee of a shared create (the create
 * page) and an assignee patch on a shared row (`collab-source.ts`). Before
 * this module neither narrowed. A create dropped an anonymous "Me" without
 * saying so and filed the issue unassigned; a patch sent `{ kind: "human" }`
 * with no id, which the server's `ActorBody` cannot deserialize, so the queued
 * write was rejected long after the click.
 *
 * "Me" resolves to this profile's bound `User`. Its label is the person's
 * name, never the localized "Me" the picker shows: the label is a snapshot
 * every other member's board renders, and to them "Me" names somebody else.
 */

import type { UserBindingRegistry } from "@/lib/identity/user-binding"
import type { IssueActor } from "@/types/issues"
import {
  resolveCollabActor,
  type CollabActorRefusal,
  type CollabIssueActor,
} from "@/types/issues/collab"

/** Who "Me" is on the collaboration plane: this profile's bound `User`. */
export interface CollabSelf {
  userId: string
  /** The person's name, used as the label other members see. */
  label?: string
}

/** An actor the collaboration plane cannot name. Carries the contract's reason. */
export class CollabActorRefusedError extends Error {
  readonly reason: CollabActorRefusal

  constructor(reason: CollabActorRefusal) {
    super(`issue actor cannot be named on the collaboration plane: ${reason}`)
    this.name = "CollabActorRefusedError"
    this.reason = reason
    Object.setPrototypeOf(this, CollabActorRefusedError.prototype)
  }
}

/** True for the local "Me": a human with no id of its own. */
function isAnonymousHuman(actor: IssueActor): boolean {
  return actor.kind === "human" && !actor.id?.trim()
}

/**
 * True for a human that names a person by id: a shared workspace's member.
 * Only a shared issue can carry one; the local "Me" has no id.
 */
export function namesCollabMember(actor: IssueActor | null | undefined): boolean {
  return actor?.kind === "human" && Boolean(actor.id?.trim())
}

/**
 * Why `actor` cannot be written to a shared issue, or `null` when it can.
 * `null` (unassign) always can. Pure, so a picker or menu can grey the option
 * out before anyone clicks it.
 */
export function collabActorRefusal(
  actor: IssueActor | null,
  selfUserId: string | null | undefined
): CollabActorRefusal | null {
  if (actor === null) return null
  const resolved = resolveCollabActor(actor, selfUserId ?? undefined)
  return resolved.ok ? null : resolved.reason
}

/**
 * Narrow an actor for a write to the collaboration plane, or throw
 * `CollabActorRefusedError`. Never invents an id and never drops the actor.
 */
export function narrowCollabActor(
  actor: IssueActor,
  self: CollabSelf | null | undefined
): CollabIssueActor {
  const resolved = resolveCollabActor(actor, self?.userId)
  if (!resolved.ok) throw new CollabActorRefusedError(resolved.reason)
  if (!isAnonymousHuman(actor)) return resolved.actor
  // The picker's "Me" label is for this screen only.
  return {
    kind: resolved.actor.kind,
    id: resolved.actor.id,
    ...(self?.label ? { label: self.label } : {}),
  }
}

/**
 * The picker key a shared row's assignee should select. A row assigned to the
 * signed-in person carries their `usr_…` id, which the picker knows as "Me"
 * (`human:self`); every other actor keeps its own key.
 */
export function collabAssigneeKey(
  actor: IssueActor | null | undefined,
  selfUserId: string | null | undefined,
  key: (actor: IssueActor | undefined) => string | null
): string | null {
  if (actor && actor.kind === "human" && selfUserId && actor.id === selfUserId) {
    return key({ kind: "human" })
  }
  return key(actor ?? undefined)
}

/**
 * One registry (one connection to the account registry database) for every
 * read: `useCollabSelf` re-runs this inside a live query, and a fresh
 * connection per run would never be closed.
 */
let registryPromise: Promise<Pick<UserBindingRegistry, "get">> | null = null
function defaultRegistry(): Promise<Pick<UserBindingRegistry, "get">> {
  registryPromise ??= import("@/lib/identity/user-binding").then(
    ({ UserBindingRegistry }) => new UserBindingRegistry()
  )
  return registryPromise
}

export interface ReadCollabSelfDeps {
  registry?: Pick<UserBindingRegistry, "get">
  localAccountId?: string
}

/**
 * This profile's bound person, or `null` when nobody is signed in. The account
 * registry is loaded on first use: the gate above is pure and is imported by
 * every issue write path, which should not pull the registry in with it.
 */
export async function readCollabSelf(deps: ReadCollabSelfDeps = {}): Promise<CollabSelf | null> {
  const registry = deps.registry ?? (await defaultRegistry())
  const localAccountId =
    deps.localAccountId ?? (await import("@/lib/accounts/active-account-id")).getActiveAccountId()
  const binding = await registry.get(localAccountId)
  if (!binding?.userId) return null
  const label = binding.displayName?.trim() || binding.email?.trim()
  return { userId: binding.userId, ...(label ? { label } : {}) }
}
