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
 * (same lookup `enqueueOutbound` uses). Desktop sessions come back with just
 * `sessionId` — the desktop HITL path handles those.
 */

import type {
  BuiltInSkillActingSender,
  BuiltInSkillActingSenders,
  BuiltInSkillContext,
} from "./types"
import type { PlatformIdentity } from "@/types/connectors/event"
import { primaryRootOf } from "@/lib/workspace/roots"

export async function resolveBuiltInSkillContext(sessionId: string): Promise<BuiltInSkillContext> {
  const ctx: BuiltInSkillContext = { sessionId }
  try {
    const { getDb } = await import("@/lib/db/schema")
    const db = getDb()
    const session = await db.sessions.get(sessionId)
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
    const binding = session?.platformBinding
    if (!binding?.conversationKey) return ctx
    ctx.imBinding = {
      adapterId: binding.adapterId,
      platform: binding.platform,
      conversationKey: binding.conversationKey,
    }
    ctx.actingSenders = (
      await resolveBuiltInSkillTurnActors(binding.conversationKey, binding.adapterId, sessionId)
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
  } catch {
    // Keep failed identity lookup explicit. The Lark owner gate re-reads the
    // session and refuses rather than treating this as a local invocation.
    ctx.actingSenders = "unknown"
    return ctx
  }
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
