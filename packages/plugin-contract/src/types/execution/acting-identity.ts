/** ADR-0243 phase 1: recorded identity and authority, not an enforcement surface. */
import type {
  AgentPermissionMode,
  UnattendedPermissionProfileV1,
} from "@cognia/plugin-contract/types/agent-config/index"
import { narrowAuthority } from "@cognia/plugin-contract/types/agent-config/agent-composition"
import { narrowPermissionProfile } from "@cognia/plugin-contract/types/agent-config/unattended-permission"

export type PrincipalRefV1 =
  | { kind: "local-person"; userId?: string; accountId?: string }
  | {
      kind: "platform"
      platform: string
      adapterId: string
      remoteUserId: string
      principalId?: string
      unionId?: string
    }
  | { kind: "service"; ref: string }
  /** An event actor records a trigger only; it never supplies principal authority. */
  | { kind: "event-actor"; source: string; externalId?: string; displayName?: string }

/** Why a tenant token is used; labels never select credentials or grant data access. */
export type TenantTokenPurposeV1 = "transport" | "service-data" | "adapter-admin"

/** `legacy` leaves credential selection entirely with the pre-ADR paths. */
export type CredentialLaneV1 = "delegated" | "service" | "bound-person" | "legacy"
export type RunTriggerV1 = "requester" | "schedule" | "external-event" | "local" | "child"

export interface ActingIdentityV1 {
  schemaVersion: 1
  /** Fixed identity owner. New roots use their run id; children inherit it unchanged.
   * Optional only for phase-1 records written before identity roots were recorded.
   * Child identities are historical snapshots; live revisions belong to this root.
   */
  rootRunId?: string
  lane: CredentialLaneV1
  trigger: RunTriggerV1
  actingPrincipal?: PrincipalRefV1
  authorizingPrincipal?: PrincipalRefV1
  requesters: PrincipalRefV1[]
  eventActors?: PrincipalRefV1[]
  bindingId?: string
  authorityRevision: number
}

/** Recorded personal-data provenance. This mark does not itself grant authority. */
export interface PersonalMarkV1 {
  person: PrincipalRefV1
  source: string
  markedAt: number
}

/** Transport identity is stable across optional platform identity enrichment. */
export function samePerson(a: PrincipalRefV1, b: PrincipalRefV1): boolean {
  return principalKey(a) === principalKey(b)
}

export function mergePersonalMarks(
  ...groups: readonly (readonly PersonalMarkV1[] | undefined)[]
): PersonalMarkV1[] {
  const merged = new Map<string, PersonalMarkV1>()
  for (const marks of groups) {
    for (const mark of marks ?? []) {
      const key = JSON.stringify([principalKey(mark.person), mark.source])
      const previous = merged.get(key)
      if (!previous || mark.markedAt < previous.markedAt) merged.set(key, mark)
    }
  }
  return [...merged.values()]
}

/** Marks are monotonic; an existing row alone owns its legacy-classification version.
 * A new row may carry a version only when its caller supplies trusted copy metadata.
 */
export function preservePersonalMarkMetadata(
  incoming: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  state: { rowExists: boolean }
): Record<string, unknown> | undefined {
  const marks = mergePersonalMarks(
    previous?.personalMarks as PersonalMarkV1[] | undefined,
    incoming?.personalMarks as PersonalMarkV1[] | undefined
  )
  const metadata = { ...incoming }
  if (state.rowExists) {
    delete metadata.personalMarkVersion
    if (previous && Object.prototype.hasOwnProperty.call(previous, "personalMarkVersion"))
      metadata.personalMarkVersion = previous.personalMarkVersion
  }
  if (marks.length) metadata.personalMarks = marks
  return Object.keys(metadata).length ? metadata : undefined
}

export interface RunAuthorityV1 {
  schemaVersion: 1
  permissionMode?: AgentPermissionMode
  tools?: { allow?: string[]; deny?: string[] }
  skills?: { only?: string[] }
  mcpServers?: { only?: string[] }
  subagents?: { only?: string[] }
  permissionProfile?: UnattendedPermissionProfileV1
  maxTurns?: number
  pools?: { rootRunId: string; tokenBudget?: number; costUsd?: number; deadlineMs?: number }
}

function intersect(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a) return b ? [...b] : undefined
  if (!b || (a.length === b.length && a.every((id, index) => id === b[index]))) return [...a]
  return [...new Set(a.filter((id) => b.includes(id)))].sort()
}

function union(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a) return b ? [...b] : undefined
  if (!b || (a.length === b.length && a.every((id, index) => id === b[index]))) return [...a]
  return [...new Set([...a, ...b])].sort()
}

/** Every execution bound narrows. Pools belong to the parent and are never split or reset. */
export function meetRunAuthority(parent: RunAuthorityV1, child: RunAuthorityV1): RunAuthorityV1 {
  const result: RunAuthorityV1 = { schemaVersion: 1 }
  const mode = parent.permissionMode ?? child.permissionMode
  if (mode) result.permissionMode = narrowAuthority(mode, child.permissionMode)
  if (parent.tools || child.tools) {
    result.tools = {}
    const allow = intersect(parent.tools?.allow, child.tools?.allow)
    if (allow !== undefined) result.tools.allow = allow
    const deny = union(parent.tools?.deny, child.tools?.deny)
    if (deny !== undefined) result.tools.deny = deny
  }
  for (const key of ["skills", "mcpServers", "subagents"] as const) {
    if (parent[key] || child[key]) {
      const only = intersect(parent[key]?.only, child[key]?.only)
      result[key] = only === undefined ? {} : { only }
    }
  }
  const profile = narrowPermissionProfile(parent.permissionProfile, child.permissionProfile)
  if (profile) result.permissionProfile = profile
  const turns = [parent.maxTurns, child.maxTurns].filter((n): n is number => n !== undefined)
  if (turns.length) result.maxTurns = Math.min(...turns)
  if (parent.pools) result.pools = parent.pools
  return result
}

function principalKey(principal: PrincipalRefV1): string {
  switch (principal.kind) {
    case "local-person":
      return JSON.stringify([principal.kind, principal.userId ?? null, principal.accountId ?? null])
    case "platform":
      return JSON.stringify([
        principal.kind,
        principal.platform,
        principal.adapterId,
        principal.remoteUserId,
      ])
    case "service":
      return JSON.stringify([principal.kind, principal.ref])
    case "event-actor":
      return JSON.stringify([
        principal.kind,
        principal.source,
        principal.externalId ?? null,
        principal.externalId ? null : (principal.displayName ?? null),
      ])
  }
}

/** Only requester membership and the revision may advance; duplicates retain object identity. */
export function absorbRequester(
  identity: ActingIdentityV1,
  principal: PrincipalRefV1
): ActingIdentityV1 {
  if (principal.kind === "event-actor") return identity
  const key = principalKey(principal)
  if (identity.requesters.some((existing) => principalKey(existing) === key)) return identity
  return {
    ...identity,
    requesters: [...identity.requesters, principal],
    authorityRevision: identity.authorityRevision + 1,
  }
}

export function checkActingAuthority(
  current: ActingIdentityV1 | undefined,
  expectedRevision: number
): { ok: true } | { ok: false; reason: "revision_advanced" | "missing" } {
  if (!current) return { ok: false, reason: "missing" }
  if (current.authorityRevision > expectedRevision)
    return { ok: false, reason: "revision_advanced" }
  return { ok: true }
}
