/** ADR-0243 recorded authority and identity resolution. */
import {
  checkActingAuthority,
  meetRunAuthority,
  inheritableRunAuthority,
  type ActingIdentityV1,
  type ExecutionRun,
  type PrincipalRefV1,
  type RunAuthorityV1,
  type RunTriggerV1,
} from "@cognia/plugin-contract/types/execution/run"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { readResolvedPrincipal } from "./resolved-principal"
import {
  absorbRequester,
  mergePersonalMarks,
  samePerson,
  type CredentialLaneV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import { getDb } from "@/lib/db/schema"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { SessionImAuthority } from "@cognia/plugin-contract/types/connectors/binding"
import { isTerminalRunStatus } from "@/types/execution/run"

/** Missing automated provenance must never masquerade as a local person. */
export function runTriggerFromOrigin(origin: { source: string } | undefined): RunTriggerV1 {
  switch (origin?.source) {
    case "schedule":
      return "schedule"
    case "im":
      return "requester"
    default:
      return "external-event"
  }
}

/** Origin labels are caller data. Only a host UI admission may supply this symbol. */
export const LOCAL_PERSON_RUN = Symbol("host-local-person-run")
export type LocalPersonRun = typeof LOCAL_PERSON_RUN

/** Reserved turn ids remain reader provenance, never a missing claimed parent. */
export async function authorityParentRunId(
  context:
    | { executionRunId?: string; executionRunReserved?: true; executionRunParentId?: string }
    | undefined
): Promise<string | undefined> {
  const id = context?.executionRunId || undefined
  if (context?.executionRunReserved && (!id || !(await getDb().executionRuns.get(id)))) {
    const parent = context.executionRunParentId || undefined
    // A captured coordinator that no longer exists keeps the observed-root
    // exception every other launch path applies; it is never a refused parent.
    return parent && (await getDb().executionRuns.get(parent)) ? parent : undefined
  }
  return id
}

/** Host-owned enqueue context. Automation can only narrow personal authority. */
export interface JobExecutionContext {
  sessionId?: string
  executionRunId?: string
  localAuthorization?: LocalPersonRun
  automation?: "schedule" | "service"
}

const activeToolRuns = new Map<string, string>()
const toolCallRuns = new Map<string, string>()
const builtinToolRuns = new Set<string>()
const toolRunKey = (sessionId: string, runId: string) =>
  JSON.stringify([getDb().name, sessionId, runId])
/** Ephemeral Host transport proof; persisted runtime labels cannot recreate it. */
export const isBuiltinToolExecutionRun = (sessionId: string, runId: string) =>
  builtinToolRuns.has(toolRunKey(sessionId, runId))
const toolCallKey = (sessionId: string, turnId: string, attemptId?: string) =>
  JSON.stringify([sessionId, turnId, attemptId ?? null])
export const activeToolExecutionRunId = (sessionId: string) => activeToolRuns.get(sessionId)

/** Bound by the host send, before the sidecar can emit a tool call. Never read from tool args. */
export function bindToolCallRun(
  sessionId: string,
  turnId: string | undefined,
  runId: string | undefined,
  attemptId?: string,
  hostDispatch?: { builtinRuntime: true }
): void {
  if (!turnId) return
  const key = toolCallKey(sessionId, turnId, attemptId)
  const existing = toolCallRuns.get(key)
  toolCallRuns.set(key, existing !== undefined && existing !== runId ? "" : (runId ?? ""))
  if (toolCallRuns.size > 4096) toolCallRuns.delete(toolCallRuns.keys().next().value!)
  if (runId && hostDispatch?.builtinRuntime === true) {
    builtinToolRuns.add(toolRunKey(sessionId, runId))
    if (builtinToolRuns.size > 4096) builtinToolRuns.delete(builtinToolRuns.values().next().value!)
  }
}

/** A correlated but unknown turn must not fall back to a newer active run. */
export function toolCallExecutionRunId(
  sessionId: string,
  turnId?: string,
  attemptId?: string
): string | undefined {
  if (!turnId) return attemptId === undefined ? undefined : ""
  return toolCallRuns.get(toolCallKey(sessionId, turnId, attemptId)) ?? ""
}

/** A correlated lookup failure is distinct from a content-free background call. */
export function toolCallEgressRunId(
  sessionId: string,
  turnId?: string,
  attemptId?: string
): string | undefined {
  const runId = toolCallExecutionRunId(sessionId, turnId, attemptId)
  return runId === "" ? "unresolved-tool-producer" : runId
}

/** Minimal entry record for host skill/member paths without a chat journal. */
export async function startToolExecutionRun(
  sessionId: string | undefined,
  options: {
    runId?: string
    parentRunId?: string
    authority?: RunAuthorityV1
    /** Persisted Host ceiling of the recovered journal attempt, not run options. */
    recoveryAuthority?: RunAuthorityV1
    localAuthorization?: LocalPersonRun
    automation?: JobExecutionContext["automation"]
    /** Host-authorized confirmation, anchored to the run that issued the card. */
    confirmedSkill?: { originRunId?: string; requester: PrincipalRefV1; rootSessionId: string }
    title?: string
    /**
     * The writer of a child run's row, recorded on its opening event (ids and
     * codes only) so boot reconciliation can tell the launcher's children from
     * scheduled and Host jobs that share the `execution:job:` id space.
     */
    launchedBy?: "child-run"
  } = {}
): Promise<ExecutionRun> {
  const db = getDb()
  const { appendRunEventInsideTransaction, semanticRunEvent, appendRunObservation } =
    await import("@/lib/db/execution-runs")
  const { resolveRunAuthority } = await import("./run-authority")
  if (getDb() !== db) throw new Error("Tool execution database changed")
  const id = options.runId ?? `execution:tool:${crypto.randomUUID()}`
  const local =
    options.parentRunId === undefined &&
    !options.automation &&
    options.localAuthorization === LOCAL_PERSON_RUN
  const now = Date.now()
  const job = id.startsWith("execution:job:")
  const run = await db.transaction(
    "rw",
    db.executionRuns,
    db.executionRunEvents,
    db.notificationProjectionWork,
    async () => {
      const existing = await db.executionRuns.get(id)
      const resolved = await resolveRunAuthority({
        ...(existing ? { runId: existing.id } : {}),
        ...(!existing && options.parentRunId ? { parentRunId: options.parentRunId } : {}),
        ...(!existing && options.authority ? { requested: options.authority } : {}),
        ...(!existing && options.recoveryAuthority
          ? { recoveryAuthority: options.recoveryAuthority }
          : {}),
      })
      if (existing) {
        if (options.parentRunId && existing.parentRunId !== options.parentRunId)
          await appendRunObservation(existing.id, {
            operation: "existing-run-parent",
            parentRunId: existing.parentRunId,
            observedParentRunId: options.parentRunId,
          })
        return existing
      }
      const parent = options.parentRunId
        ? await db.executionRuns.get(options.parentRunId)
        : undefined
      const confirmation = options.confirmedSkill
      const origin = confirmation?.originRunId
        ? await db.executionRuns.get(confirmation.originRunId)
        : undefined
      const originRoot = await identityRoot(db, origin)
      // A click confirms an operation, not a change of personal/service lane.
      // Missing provenance stays external and cannot acquire personal access.
      const requesterReplay =
        confirmation &&
        originRoot?.actingIdentity &&
        (originRoot.actingIdentity.trigger === "requester" ||
          originRoot.actingIdentity.trigger === "local") &&
        originRoot.actingIdentity.lane !== "service" &&
        (origin?.sessionId === sessionId || origin?.sessionId === confirmation.rootSessionId)
      // A delegated origin stays delegated only when its own person confirms.
      const originActing =
        originRoot?.actingIdentity?.lane === "delegated"
          ? originRoot.actingIdentity.actingPrincipal
          : undefined
      const delegatedAs =
        confirmation && originActing && samePerson(originActing, confirmation.requester)
          ? originActing
          : undefined
      const metadata = confirmation
        ? requesterReplay
          ? recordedRunMetadata("requester", {
              runId: id,
              requesters: [confirmation.requester],
              ...(delegatedAs ? { lane: "delegated" as const, actingPrincipal: delegatedAs } : {}),
              authority: inheritableRunAuthority(origin?.authority),
            })
          : recordedRunMetadata("external-event", {
              runId: id,
              ...(originRoot?.actingIdentity?.lane === "service" ||
              (originRoot?.actingIdentity?.trigger !== "requester" &&
                originRoot?.actingIdentity?.trigger !== "local")
                ? {
                    parent: originRoot && {
                      ...originRoot,
                      authority: inheritableRunAuthority(origin?.authority),
                    },
                  }
                : {}),
            })
        : recordedRunMetadata(
            options.parentRunId
              ? "child"
              : local
                ? "local"
                : options.automation === "schedule"
                  ? "schedule"
                  : "external-event",
            {
              runId: id,
              parent,
              ...(local
                ? {
                    authorizingPrincipal: { kind: "local-person" },
                    requesters: [{ kind: "local-person" }],
                  }
                : {}),
            }
          )
      if (!confirmation) {
        if (resolved.authority) metadata.authority = resolved.authority
        if (resolved.actingIdentity) metadata.actingIdentity = resolved.actingIdentity
      }
      if (!parent && options.automation === "service" && metadata.actingIdentity) {
        metadata.actingIdentity.lane = "service"
        metadata.actingIdentity.actingPrincipal = { kind: "service", ref: id }
      }
      if (requesterReplay && metadata.actingIdentity && originRoot?.actingIdentity)
        metadata.actingIdentity = {
          ...metadata.actingIdentity,
          lane: originRoot.actingIdentity.lane,
        }
      if (confirmation) {
        // Approval changes who may execute, never whose content the approved
        // arguments contain. A new identity root must retain its source taint.
        metadata.personalMarks = mergePersonalMarks(
          metadata.personalMarks,
          origin?.personalMarks,
          originRoot?.personalMarks,
          originRoot
            ? []
            : [
                {
                  person: { kind: "service", ref: "unverified-personal-history" },
                  source: "unverified-confirmation-origin",
                  markedAt: now,
                },
              ]
        )
      }
      await db.executionRuns.add({
        id,
        sessionId,
        kind: job ? "job" : "agent-turn",
        sourceId: job ? id.slice("execution:job:".length) : id,
        title: options.title ?? "Tool execution",
        status: "running",
        currentRevision: 0,
        startedAt: now,
        updatedAt: now,
        ...(options.recoveryAuthority
          ? { recoveryAuthority: inheritableRunAuthority(options.recoveryAuthority) }
          : {}),
        ...(confirmation && origin
          ? { parentRunId: origin.id }
          : options.parentRunId
            ? { parentRunId: options.parentRunId }
            : {}),
        ...metadata,
      })
      await appendRunEventInsideTransaction(
        db,
        id,
        semanticRunEvent(
          "run.started",
          options.launchedBy ? { launchedBy: options.launchedBy } : {},
          { ts: now, sourceEventId: `tool-entry:${id}` }
        )
      )
      const admitted = await db.executionRuns.get(id)
      if (!admitted || getDb() !== db) throw new Error("Tool execution database changed")
      return admitted
    }
  )
  if (!job && sessionId) activeToolRuns.set(sessionId, id)
  const { personalEgressFenced } = await import("./personal-egress")
  await personalEgressFenced({ executionRunId: run.id })
  return run
}

/** Host enqueue only: a job keeps the exact live identity root across waits/retries.
 * The job id is Host-owned, never an outbound request or plugin argument.
 */
export async function startJobExecutionRun(
  jobId: string,
  context?: JobExecutionContext,
  options?: { delivery?: boolean }
): Promise<ExecutionRun> {
  const existing = await getDb().executionRuns.get(`execution:job:${jobId}`)
  if (existing)
    return startToolExecutionRun(existing.sessionId, {
      runId: existing.id,
      parentRunId: context?.executionRunId,
    })
  const parent =
    context?.executionRunId !== undefined
      ? await resolveExecutingRun(context.sessionId, context.executionRunId, options)
      : undefined
  if (context?.executionRunId !== undefined && !parent)
    throw new Error("Job execution parent unavailable")
  return startToolExecutionRun(parent?.sessionId ?? context?.sessionId, {
    runId: `execution:job:${jobId}`,
    // An invalid explicit run cannot fall through to the direct UI admission.
    ...(context?.executionRunId !== undefined
      ? { parentRunId: parent?.id ?? "" }
      : { localAuthorization: context?.localAuthorization, automation: context?.automation }),
  })
}

export async function finishToolExecutionRun(
  runId: string,
  failed: boolean | "cancelled" = false
): Promise<void> {
  const { getExecutionRun, runEventJournal, semanticRunEvent } =
    await import("@/lib/db/execution-runs")
  try {
    const run = await getExecutionRun(runId)
    if (!run) return
    if (isTerminalRunStatus(run.status)) return
    await runEventJournal.append(
      runId,
      semanticRunEvent(
        failed === "cancelled" ? "run.cancelled" : failed ? "run.failed" : "run.completed",
        {},
        { sourceEventId: `tool-entry:${runId}:finished` }
      )
    )
  } finally {
    for (const [sessionId, activeRunId] of activeToolRuns) {
      if (activeRunId === runId) activeToolRuns.delete(sessionId)
    }
  }
}

/** Resolve the executing run, never choose the newest of several candidates. */
export async function resolveRunActingIdentity(
  sessionId: string | undefined,
  runId?: string,
  options?: { delivery?: boolean }
) {
  const db = getDb()
  const run = await resolveExecutingRun(sessionId, runId, options)
  if (getDb() !== db || !run?.actingIdentity) return undefined
  const root = await identityRoot(db, run)
  return getDb() === db ? root?.actingIdentity : undefined
}

export async function resolveExecutingRun(
  sessionId: string | undefined,
  runId?: string,
  options?: { delivery?: boolean }
) {
  const db = getDb()
  const { getExecutionRun, listExecutionRuns } = await import("@/lib/db/execution-runs")
  const candidates =
    runId !== undefined
      ? [await getExecutionRun(runId)]
      : sessionId
        ? await listExecutionRuns({
            sessionId,
            statuses: ["queued", "running", "waiting", "paused"],
            limit: 2,
          })
        : []
  if (candidates.length !== 1 || !candidates[0]) return undefined
  const run = candidates[0]
  if ((sessionId !== undefined && run.sessionId !== sessionId) || !run.actingIdentity)
    return undefined
  if (
    !["queued", "running", "waiting", "paused"].includes(run.status) &&
    !(options?.delivery && runId && isTerminalRunStatus(run.status))
  )
    return undefined
  if (getDb() !== db) return undefined
  return run
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
    parent?: Pick<ExecutionRun, "actingIdentity" | "authority" | "personalMarks"> &
      Partial<Pick<ExecutionRun, "id">>
    requesters?: PrincipalRefV1[]
    /**
     * A root's credential lane, fixed at admission (ADR-0243 §3). The
     * `delegated` lane acts as `actingPrincipal`; absent is `legacy`.
     */
    lane?: Exclude<CredentialLaneV1, "legacy" | "bound-person">
    actingPrincipal?: PrincipalRefV1
    authorizingPrincipal?: PrincipalRefV1
    eventActors?: PrincipalRefV1[]
    authority?: RunAuthorityV1
  } = {}
): Pick<ExecutionRun, "actingIdentity" | "authority" | "personalMarks"> {
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
        lane: options.lane ?? "legacy",
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
  const inherited = inheritableRunAuthority(parent?.authority)
  const own = options.authority ? { ...options.authority, caps: "explicit-v1" as const } : undefined
  const authority = parent
    ? inherited && own
      ? meetRunAuthority(inherited, own)
      : (inherited ?? (own ? meetRunAuthority({ schemaVersion: 1 }, own) : undefined))
    : own
  return {
    actingIdentity,
    ...(authority ? { authority: { ...authority, caps: "explicit-v1" } } : {}),
    ...(parent?.personalMarks?.length ? { personalMarks: [...parent.personalMarks] } : {}),
  }
}

export async function authorityFromPermissionCeiling(
  ceiling: AgentPermissionCeiling | undefined,
  observationRunId?: string
): Promise<RunAuthorityV1 | undefined> {
  if (!ceiling) return undefined
  // The SDK wire map is keyed by name; persisted authority always names Host ids.
  const servers = ceiling.mcpServers ? await getDb().mcpServers.toArray() : []
  const ids = ceiling.mcpServers?.flatMap((entry) => {
    const server = servers.find((server) => server.name === entry.name || server.id === entry.name)
    return server ? [server.id] : []
  })
  const unmatched = ceiling.mcpServers
    ?.filter(
      (entry) => !servers.some((server) => server.name === entry.name || server.id === entry.name)
    )
    .map((entry) => entry.name)
  if (unmatched?.length && observationRunId) {
    const { appendRunObservation } = await import("@/lib/db/execution-runs")
    await appendRunObservation(observationRunId, {
      operation: "mcp_authority_names_unresolved",
      names: unmatched,
    })
  }
  return {
    schemaVersion: 1,
    caps: "explicit-v1",
    ...(ceiling.permissionMode ? { permissionMode: ceiling.permissionMode } : {}),
    ...(ceiling.allowedTools || ceiling.disallowedTools
      ? {
          tools: {
            ...(ceiling.allowedTools ? { allow: [...ceiling.allowedTools] } : {}),
            ...(ceiling.disallowedTools ? { deny: [...ceiling.disallowedTools] } : {}),
          },
        }
      : {}),
    ...(ceiling.mcpServers && (!ceiling.mcpServers.length || ids?.length)
      ? {
          mcpServers: {
            only: ids ?? [],
          },
        }
      : {}),
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

/** Persist the enforced launch ceiling; storage failures refuse dispatch. */
export async function recordRunAuthority(
  sessionId: string,
  authority: RunAuthorityV1,
  runId?: string
): Promise<RunAuthorityV1 | undefined> {
  const db = getDb()
  const snapshot = await snapshotActingAuthority(sessionId, runId)
  const { persistRunAuthority, RunAuthorityError } = await import("./run-authority")
  if (!snapshot || getDb() !== db) {
    if (runId) throw new RunAuthorityError("authority_unavailable")
    return
  }
  return (await persistRunAuthority(snapshot.runId, authority)).authority
}

/**
 * Detached phase-1B observation: never awaits, gates, or changes a tenant request.
 * Resolve the current run exactly like the authority snapshot; adapter internals
 * without a session are intentionally classified only.
 */
export function observeTenantServiceData(
  sessionId: string | undefined,
  adapterId: string,
  path: string,
  context?: { authoritySessionId?: string; executionRunId?: string }
): void {
  if (!sessionId) return
  void Promise.resolve()
    .then(async () => {
      const db = getDb()
      const session = await db.sessions.get(context?.authoritySessionId ?? sessionId)
      const binding =
        (session as typeof session & SessionImAuthority)?.imAuthorityBinding ??
        session?.platformBinding
      if (!binding || getDb() !== db) return
      const snapshot = await snapshotActingAuthority(sessionId, context?.executionRunId)
      if (!snapshot || getDb() !== db) return
      const { appendRunObservation } = await import("@/lib/db/execution-runs")
      if (getDb() !== db) return
      await appendRunObservation(
        snapshot.runId,
        {
          mode: "observe",
          operation: "tenant-service-data",
          adapterId,
          path,
        },
        { throttleMs: 60_000 }
      )
    })
    .catch(() => undefined)
}
