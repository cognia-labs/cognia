/** ADR-0243 recording adapters. No result from this module grants or refuses execution. */
import {
  checkActingAuthority,
  meetRunAuthority,
  type ActingIdentityV1,
  type ExecutionRun,
  type PrincipalRefV1,
  type RunAuthorityV1,
  type RunTriggerV1,
} from "@cognia/plugin-contract/types/execution/run"
import type { ExternalSessionPermissionSpec } from "@/lib/ai/agent/external/policy/permission-cascade"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { readResolvedPrincipal } from "@/lib/connectors/principal/resolve"
import { absorbRequester } from "@cognia/plugin-contract/types/execution/acting-identity"
import { getDb } from "@/lib/db/schema"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { canonicalJson } from "@cognia/agent"

/** Missing automated provenance must never masquerade as a local person. */
export function runTriggerFromOrigin(origin: { source: string } | undefined): RunTriggerV1 {
  switch (origin?.source) {
    case "schedule":
      return "schedule"
    case "im":
      return "requester"
    case "ui":
    case "chat":
    case "desktop":
      return "local"
    default:
      return "external-event"
  }
}

/** Explicit roots are one hop; bounded parent traversal supports earlier phase-1 rows. */
async function identityRoot(
  db: ReturnType<typeof getDb>,
  run: ExecutionRun | undefined
): Promise<ExecutionRun | undefined> {
  const visited = new Set<string>()
  for (let depth = 0; run && depth < 32; depth++) {
    if (visited.has(run.id)) return undefined
    visited.add(run.id)
    const rootId = run.actingIdentity?.rootRunId
    if (rootId === run.id) return run
    const nextId = rootId ?? run.parentRunId
    if (!nextId) return run
    run = await db.executionRuns.get(nextId)
  }
  return undefined
}

/** Reuse provenance already carried through workflow/team dispatch, without a sender lookup. */
export function requestersFromRunOrigin(
  origin: WorkflowTriggeredFrom | undefined
): PrincipalRefV1[] {
  const platform = origin?.deliveryTarget?.address.platform
  if (origin?.source !== "im" || !platform || !origin.adapterId || !origin.initiator?.remoteUserId)
    return []
  return [
    {
      kind: "platform",
      platform,
      adapterId: origin.adapterId,
      remoteUserId: origin.initiator.remoteUserId,
      ...(origin.initiator.principalId ? { principalId: origin.initiator.principalId } : {}),
    },
  ]
}

/** Same inbound sender/enrichment consumed by resolveBuiltInSkillTurnActors; no identity lookup. */
export function connectorRequester(event: NormalizedInboundEvent): PrincipalRefV1 {
  const scope = event.channelData?.identityScope as { unionId?: unknown } | undefined
  const principalId = readResolvedPrincipal(event.channelData)?.principalId
  return {
    kind: "platform",
    platform: event.platform,
    adapterId: event.adapterId,
    remoteUserId: event.sender.remoteUserId,
    ...(principalId ? { principalId } : {}),
    ...(typeof scope?.unionId === "string" ? { unionId: scope.unionId } : {}),
  }
}

export async function recordAbsorbedRequester(
  runId: string,
  principal: PrincipalRefV1
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.executionRuns, async () => {
    const run = await identityRoot(db, await db.executionRuns.get(runId))
    if (!run?.actingIdentity) return
    const identity = absorbRequester(run.actingIdentity, principal)
    if (identity === run.actingIdentity) return
    // Metadata rides the next real run update to other devices in phase 1.
    // Keep updatedAt (ordering, live-query and sync cursor) untouched.
    await db.executionRuns.update(run.id, {
      actingIdentity: identity,
    })
  })
}

/** Shared by entry points; no equivalent persisted identity adapter preceded ADR-0243. */
export function recordedRunMetadata(
  trigger: RunTriggerV1,
  options: {
    runId?: string
    parent?: Pick<ExecutionRun, "actingIdentity" | "authority"> & Partial<Pick<ExecutionRun, "id">>
    requesters?: PrincipalRefV1[]
    actingPrincipal?: PrincipalRefV1
    authorizingPrincipal?: PrincipalRefV1
    eventActors?: PrincipalRefV1[]
    authority?: RunAuthorityV1
  } = {}
): Pick<ExecutionRun, "actingIdentity" | "authority"> {
  const { parent } = options
  const parentIdentity = parent?.actingIdentity
  // Older parents have no explicit root. Anchor new copies to that parent so
  // even children without a structural parentRunId can follow its live identity.
  const actingIdentity: ActingIdentityV1 = parentIdentity
    ? !parentIdentity.rootRunId && options.runId && parent?.id
      ? { ...parentIdentity, rootRunId: parent.id }
      : parentIdentity
    : {
        schemaVersion: 1,
        ...(options.runId ? { rootRunId: options.runId } : {}),
        lane: "legacy",
        trigger,
        requesters: options.requesters ?? [],
        authorityRevision: 0,
        ...(options.actingPrincipal ? { actingPrincipal: options.actingPrincipal } : {}),
        ...(options.authorizingPrincipal
          ? { authorizingPrincipal: options.authorizingPrincipal }
          : {}),
        ...(options.eventActors ? { eventActors: options.eventActors } : {}),
      }
  // A child's pool always remains its parent's, including an absent pool.
  const authority = parent
    ? parent.authority && options.authority
      ? meetRunAuthority(parent.authority, options.authority)
      : parent.authority
    : options.authority
  return { actingIdentity, ...(authority ? { authority } : {}) }
}

export function authorityFromPermissionCeiling(
  ceiling: ExternalSessionPermissionSpec | undefined
): RunAuthorityV1 | undefined {
  if (!ceiling) return undefined
  return {
    schemaVersion: 1,
    ...(ceiling.permissionMode ? { permissionMode: ceiling.permissionMode } : {}),
    ...(ceiling.allowedTools || ceiling.disallowedTools
      ? {
          tools: {
            ...(ceiling.allowedTools ? { allow: [...ceiling.allowedTools] } : {}),
            ...(ceiling.disallowedTools ? { deny: [...ceiling.disallowedTools] } : {}),
          },
        }
      : {}),
    ...(ceiling.mcpServers ? { mcpServers: { only: ceiling.mcpServers.map((s) => s.name) } } : {}),
  }
}

export interface ActingAuthoritySnapshot {
  runId: string
  revision: number
}

/** Snapshot earlier than the call being observed, never an admission decision. */
export async function snapshotActingAuthority(
  sessionId: string,
  runId?: string
): Promise<ActingAuthoritySnapshot | undefined> {
  try {
    const db = getDb()
    const { getExecutionRun, listExecutionRuns } = await import("@/lib/db/execution-runs")
    if (getDb() !== db) return undefined
    const run = runId
      ? ((await getExecutionRun(runId)) ?? (await getExecutionRun(`execution:job:${runId}`)))
      : (
          await listExecutionRuns({
            sessionId,
            statuses: ["queued", "running", "waiting", "paused"],
            // Projected jobs also use the caller session id; a sibling is not its parent.
            kinds: ["agent-turn", "workflow", "plan", "goal", "team", "scheduled", "delegation"],
            limit: 1,
          })
        )[0]
    const root = await identityRoot(db, run)
    return run && getDb() === db
      ? { runId: run.id, revision: root?.actingIdentity?.authorityRevision ?? 0 }
      : undefined
  } catch {
    return undefined
  }
}

/** Audit-only, including on storage failure. Callers must never branch on this result. */
export async function observeActingAuthority(
  runId: string,
  expectedRevision: number,
  operation: "lark-personal-token" | "child-launch" | "unattended-resume"
): Promise<ReturnType<typeof checkActingAuthority>> {
  try {
    const db = getDb()
    const { appendRunObservation } = await import("@/lib/db/execution-runs")
    if (getDb() !== db) return { ok: false, reason: "missing" }
    const current = await identityRoot(db, await db.executionRuns.get(runId))
    const result = checkActingAuthority(current?.actingIdentity, expectedRevision)
    if (!result.ok && getDb() === db) {
      await appendRunObservation(runId, {
        mode: "observe",
        operation,
        reason: result.reason,
        expectedRevision,
        ...(current?.actingIdentity
          ? { currentRevision: current.actingIdentity.authorityRevision }
          : {}),
      }).catch(() => undefined)
    }
    return result
  } catch {
    return { ok: false, reason: "missing" }
  }
}

/** Persist resolved metadata without replacing the registry dispatch currently reads. */
export async function recordRunAuthority(
  sessionId: string,
  authority: RunAuthorityV1,
  runId?: string
): Promise<void> {
  try {
    const db = getDb()
    const snapshot = await snapshotActingAuthority(sessionId, runId)
    if (!snapshot || getDb() !== db) return
    await db.transaction("rw", db.executionRuns, async () => {
      const run = await db.executionRuns.get(snapshot.runId)
      if (!run) return
      const resolved = run.authority ? meetRunAuthority(run.authority, authority) : authority
      if (!resolved.pools && authority.pools && !run.parentRunId) resolved.pools = authority.pools
      // A root can record a tighter pool ceiling; a child never splits or resets it.
      if (resolved.pools?.rootRunId === run.id && authority.pools?.rootRunId === run.id) {
        resolved.pools = { ...resolved.pools }
        for (const field of ["tokenBudget", "costUsd", "deadlineMs"] as const) {
          const before = resolved.pools[field]
          const next = authority.pools[field]
          if (next !== undefined)
            resolved.pools[field] = before === undefined ? next : Math.min(before, next)
        }
      }
      if (canonicalJson(run.authority) === canonicalJson(resolved)) return
      // Metadata syncs with the next real run update in phase 1; it must not
      // move updatedAt or reorder runs merely because a ceiling was observed.
      await db.executionRuns.update(run.id, {
        authority: resolved,
      })
    })
  } catch {
    // Observe-only storage must never affect the existing send/dispatch result.
  }
}
