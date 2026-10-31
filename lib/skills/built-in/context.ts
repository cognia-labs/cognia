/**
 * Built-in-skill context hydration (W2 — closes an ADR-0026 trust-model gap).
 *
 * The sidecar tool-exec IPC path (`lib/claude/plugin-tool-ipc.ts`) used to
 * call `runBuiltInSkill(id, args, { sessionId })` with a BARE context: no
 * `imBinding`, no `imOverrideRow`. Since every dispatcher gate keys off
 * `ctx.imBinding` (imAccess tier, per-chat allowlist, HITL), tool-call
 * invocations from IM-bound sessions silently bypassed the entire pipeline —
 * write skills executed without confirm cards.
 *
 * `resolveBuiltInSkillContext` loads the session, and when it carries a
 * `platformBinding`, populates `imBinding` + the conversation's override row
 * (same lookup `enqueueOutbound` uses). Unbound sessions carry a separate
 * personal-lane proof; absence of IM gates never grants personal credentials.
 */

import type {
  BuiltInSkillActingSender,
  BuiltInSkillActingSenders,
  BuiltInSkillContext,
} from "./types"
import type { PlatformIdentity } from "@/types/connectors/event"
import { primaryRootOf } from "@/lib/workspace/roots"
import { getTeamDispatchContext } from "@/lib/claude/agents/dispatch-context-registry"
import { decodeSubSession } from "@/lib/claude/team-session-id"
import { getSubagentApprovalRoute } from "@/lib/claude/agents/subagent-approval-routes"

const MAX_SESSION_PARENT_DEPTH = 32

/**
 * Resolve IM authority from the root, never a child's copied binding. A broken
 * lineage must throw: returning a bare context would grant desktop skill rules.
 * Row-less callers may still have host-registered parents. Session-less runs
 * retain non-personal skills, but cannot prove a local personal lane.
 */
export async function resolveBuiltInSkillSessionBinding(sessionId: string) {
  const { getDb } = await import("@/lib/db/schema")
  let db: ReturnType<typeof getDb>
  try {
    db = getDb()
  } catch (error) {
    // Non-renderer callers can have no session store at all. Only an
    // unlinked id retains the legacy non-personal lane in that runtime.
    if (
      typeof window === "undefined" &&
      typeof indexedDB === "undefined" &&
      !getSubagentApprovalRoute(sessionId) &&
      !getTeamDispatchContext(sessionId) &&
      !decodeSubSession(sessionId)
    )
      return {
        session: undefined,
        rootSessionId: sessionId,
        binding: undefined,
        personalLane: "unverified" as const,
      }
    throw error
  }
  const session = await db.sessions.get(sessionId)
  let current = session
  let currentId = sessionId
  let personalLineageVerified = true
  const seen = new Set<string>()
  for (let depth = 0; depth <= MAX_SESSION_PARENT_DEPTH; depth += 1) {
    if (seen.has(currentId)) throw new Error("Built-in skill session parent cycle")
    seen.add(currentId)
    const parents = [
      current?.parentSessionId,
      current?.attachedChild?.parentSessionId,
      current?.surfaceBinding?.kind === "session" ? current.surfaceBinding.sessionId : undefined,
      decodeSubSession(currentId)?.teamSessionId,
      getSubagentApprovalRoute(currentId)?.parentSessionId,
    ].filter((id): id is string => id !== undefined)
    // Tool-enabled teammates have a durable row but register their lineage in
    // the host runtime. Squad runs themselves are ExecutionRuns, not sessions.
    const team = getTeamDispatchContext(currentId)
    let sessionlessTeam = false
    if (team) {
      const { agentTeamExecutionRunId } = await import("@/lib/execution/agent-team-bridge")
      const [execution, run] = await Promise.all([
        team.runId ? db.executionRuns.get(agentTeamExecutionRunId(team.runId)) : undefined,
        team.runId ? db.agentTeamRuns.get(team.runId) : undefined,
      ])
      // The team template's sessionId names its creator, not this run's chat.
      const runParents = [
        execution?.sessionId,
        run?.executionConstraints?.sessionId,
        run?.executionConstraints?.triggeredFrom?.sessionId,
      ].filter((id): id is string => id !== undefined)
      sessionlessTeam = !runParents.length
      if (sessionlessTeam) personalLineageVerified = false
      parents.push(...runParents)
    }
    const uniqueParents = [...new Set(parents)]
    if (uniqueParents.length > 1 || uniqueParents.some((id) => !id.trim()))
      throw new Error("Built-in skill session parent ambiguous")
    const parentId = uniqueParents[0]
    if (!parentId) {
      return {
        session: session ?? current,
        rootSessionId: currentId,
        binding: sessionlessTeam ? undefined : current?.platformBinding,
        // Phase 3 of ADR-0243 will restore personal access for locally started
        // Squads through persisted run identity. Origin/source/parentRunId are
        // launch metadata, never proof that a run acts for the desktop owner.
        personalLane:
          personalLineageVerified &&
          current &&
          !current.platformBinding &&
          !current.agentTurnOwner &&
          current.programmaticCreator === undefined &&
          !current.origin &&
          !current.integrationBinding &&
          !current.collaboration &&
          !["Plugin Agent", "Plugin Agent Session"].includes(current.title) &&
          !current.attachedChild &&
          current.kind !== "subagent" &&
          current.projectRole !== "thread"
            ? ("local-session" as const)
            : ("unverified" as const),
      }
    }
    if (depth === MAX_SESSION_PARENT_DEPTH)
      throw new Error("Built-in skill session parent depth exceeded")
    const parent = await db.sessions.get(parentId)
    if (!parent) throw new Error("Built-in skill session parent missing")
    current = parent
    currentId = parentId
  }
  throw new Error("Built-in skill session parent depth exceeded")
}

export async function resolveBuiltInSkillContext(sessionId: string): Promise<BuiltInSkillContext> {
  const { session, rootSessionId, binding, personalLane } =
    await resolveBuiltInSkillSessionBinding(sessionId)
  const ctx: BuiltInSkillContext = { sessionId }
  // Keep generic row-less callers' bare shape; neither an omitted hint nor a
  // supplied one grants authority. Team callers explicitly expose the refusal.
  if (session || getTeamDispatchContext(sessionId)) ctx.personalLane = personalLane
  if (!session) return ctx
  const { getDb } = await import("@/lib/db/schema")
  const db = getDb()
  const sessionRoot = session?.workingDir?.trim()
  if (sessionRoot) {
    ctx.workspaceRoot = sessionRoot
  } else if (session?.projectId) {
    try {
      const project = await db.projects.get(session.projectId)
      const projectRoot = project ? primaryRootOf(project)?.path.trim() : undefined
      if (projectRoot) ctx.workspaceRoot = projectRoot
    } catch {
      // A missing project row leaves the skill unavailable; connector
      // binding hydration below must still proceed.
    }
  }
  if (!binding) return ctx
  if (!binding.conversationKey || !binding.adapterId || !binding.platform)
    throw new Error("Built-in skill IM binding incomplete")
  ctx.imBinding = {
    adapterId: binding.adapterId,
    platform: binding.platform,
    conversationKey: binding.conversationKey,
  }
  ctx.actingSenders = (
    await resolveBuiltInSkillTurnActors(binding.conversationKey, binding.adapterId, rootSessionId)
  ).actingSenders
  try {
    const { readForResolution } = await import("@/lib/db/conversation-overrides")
    ctx.imOverrideRow = (await readForResolution(binding.conversationKey)) ?? undefined
  } catch {
    // Missing override row is the common case; a failed read must not
    // block the invocation — the dispatcher treats undefined as
    // "no per-chat config" (default gates still apply).
  }
  try {
    const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
    ctx.imAdapterRow = await getAdapterInstance(binding.adapterId)
  } catch {
    // The dispatcher keeps the legacy no-ceiling + secure HITL defaults.
  }
  return ctx
}

function builtInSkillActingSender(
  sender: PlatformIdentity,
  scope?: { tenantKey?: string; appId?: string; unionId?: string },
  principalId?: string
): BuiltInSkillActingSender | undefined {
  if (!sender.remoteUserId?.trim() || (sender.kind && sender.kind !== "human")) return undefined
  return {
    remoteUserId: sender.remoteUserId,
    ...(principalId ? { principalId } : {}),
    ...(typeof scope?.unionId === "string" && scope.unionId.trim()
      ? { unionId: scope.unionId }
      : {}),
  }
}

/** Shared with confirm-card actor scoping: never infer actors from chat history. */
export async function resolveBuiltInSkillTurnActors(
  conversationKey: string,
  adapterId?: string,
  sessionId?: string
): Promise<{ actingSenders: BuiltInSkillActingSenders; initiatorUserId?: string }> {
  try {
    const { getDb } = await import("@/lib/db/schema")
    const db = getDb()
    const jobs = await db.connectorInboundJobs
      .where("conversationKey")
      .equals(conversationKey)
      .toArray()
    const running = jobs
      .filter((job) => job.status === "running" && (!adapterId || job.adapterId === adapterId))
      .sort((a, b) => b.receivedAt - a.receivedAt)
    const current = running[0]
    const initiatorUserId = current?.event.sender.remoteUserId
    const unknown = { actingSenders: "unknown" as const, initiatorUserId }
    if (!current?.executionRunId || !sessionId) return unknown
    const run = await db.executionRuns.get(current.executionRunId)
    if (!run || run.sessionId !== sessionId) return unknown
    // Custom live-steer handlers may acknowledge input without returning a run
    // id. A completed steer without attribution cannot safely be left out.
    // Only a message that arrived after this run's own can have been steered
    // into it; an older one belongs to an earlier turn.
    if (
      jobs.some(
        (job) =>
          job !== current &&
          job.status === "completed" &&
          job.dispatchMode === "steer" &&
          !job.executionRunId &&
          (!Number.isFinite(job.createdAt) ||
            !Number.isFinite(current.createdAt) ||
            job.createdAt >= current.createdAt)
      )
    )
      return unknown
    // Only a live handoff is uncertain. Queued input and a refused handoff
    // marked steer-replay wait for the next turn, so neither contributes here.
    if (
      jobs.some(
        (job) =>
          job.status === "steering" && job.event.channelData?.dispatchIntent !== "steer-replay"
      )
    )
      return unknown
    if (
      running.some(
        (job) =>
          job !== current &&
          (!current.executionRunId || job.executionRunId !== current.executionRunId)
      )
    )
      return unknown
    const contributors = jobs.filter(
      (job) =>
        running.includes(job) ||
        (current.executionRunId &&
          job.executionRunId === current.executionRunId &&
          job.status === "completed")
    )
    const senders = new Map<string, BuiltInSkillActingSender>()
    for (const job of contributors) {
      if (adapterId && job.adapterId !== adapterId) return unknown
      const scope = job.event.channelData?.identityScope as { unionId?: string } | undefined
      const sender = builtInSkillActingSender(job.event.sender, scope, job.principalId)
      if (!sender) return unknown
      // Retain conflicting union identities rather than hiding one with deduplication.
      senders.set(JSON.stringify(sender), sender)
    }
    return { actingSenders: [...senders.values()], initiatorUserId }
  } catch {
    return { actingSenders: "unknown" }
  }
}
