/**
 * What long-term memory adds to a run, as the memory module's context
 * contributions (ADR-0250 §14 `context` amendment, plan §12).
 *
 * - `recall` is the personal memories relevant to the turn plus the learned
 *   procedural block, a turn section in the `memory` slot. It leaves out
 *   what the identity section already retrieved (`ctx.kernelRetrieval.identityTexts`)
 *   and hands its recall budget over to `continuity`.
 * - `continuity` is the claims mined from this workspace's own history, a
 *   turn section in the `continuity` slot. It runs `after` `recall` and
 *   borrows whatever the personal section left unspent; without a handoff
 *   (recall did not run, failed or missed its deadline) it borrows nothing.
 *
 * Both run only when the caller passed memory deps and a memory query
 * (`hostDeps.memory`, `hostDeps.memoryQuery`), and both narrow what they read
 * to the agent's memory policy. Every recalled item is PII-checked by the
 * memory runtime; the kernel gate checks the section again.
 */

import type { ContextContribution, ContextTurnContext } from "@/lib/modules/manifest-types"
import { resolveMemoryConfig } from "@/types/memory/memory"
import type { MemoryRecallSources, ProjectContinuitySources } from "@/types/memory/context-sources"
import { resolveAgentMemoryPolicy } from "./agent-policy"
import { resolveMemoryAgentNamespace } from "./twin-namespace"
import type { ApplyMemoryContextDeps } from "./runtime/apply-memory-context"

declare module "@/lib/modules/manifest-types" {
  interface ContextHostDepsMap {
    /** The memory store and retriever the caller resolved for this turn. */
    memory: ApplyMemoryContextDeps
    /**
     * The turn's text for memory recall. The caller leaves it out when the
     * text may not be embedded, and recall then does not run.
     */
    memoryQuery: string
    /** Which agent namespace, branch and path the turn's memory is read for. */
    memoryScope: { targetAgentId?: string; branch?: string; path?: string }
  }
}

/** What `recall` hands `continuity`: the personal section's budget. */
export interface RecallHandoff {
  limit: number
  used: number
}

const RECALL_DEADLINE_MS = 15_000

/** The run's memory inputs, or `null` when the caller did not ask for memory. */
function memoryInputs(ctx: ContextTurnContext) {
  const deps = ctx.hostDeps.memory
  const query = ctx.hostDeps.memoryQuery
  if (!deps || !query?.trim()) return null
  const config = resolveMemoryConfig(ctx.settings?.memory)
  const policy = resolveAgentMemoryPolicy({
    config,
    session: ctx.session ?? undefined,
    agentPolicy: ctx.agent?.memoryPolicy,
  })
  const scope = ctx.hostDeps.memoryScope ?? {}
  const projectId = ctx.session?.projectId ?? ctx.activeProject?.id
  return { deps, query, config, policy, scope, projectId }
}

export const contributions: readonly ContextContribution[] = [
  {
    id: "recall",
    cache: "turn",
    slot: "memory",
    deadlineMs: RECALL_DEADLINE_MS,
    produce: async (ctx) => {
      const inputs = memoryInputs(ctx)
      if (!inputs) return null
      const { deps, query, config, policy, scope, projectId } = inputs
      await import("@/lib/db/memory-governance")
        .then(({ appendMemoryAuditEvent }) =>
          appendMemoryAuditEvent({
            action: policy.canRecall ? "recall-allowed" : "recall-denied",
            sessionId: ctx.session?.id,
            reason: policy.recallReason,
          })
        )
        .catch(() => undefined)
      if (!policy.canRecall) return null
      const { applyMemoryContext } = await import("./runtime/apply-memory-context")
      const readableScopes = new Set(policy.readableScopes)
      const scopedDeps: ApplyMemoryContextDeps = {
        ...deps,
        loadCandidates: async (reader) =>
          (await deps.loadCandidates(reader)).filter((memory) => readableScopes.has(memory.scope)),
        loadProcedural: async (reader) =>
          (await deps.loadProcedural(reader)).filter((memory) => readableScopes.has(memory.scope)),
      }
      const result = await applyMemoryContext({
        userMessage: query,
        reader: {
          characterId: ctx.agent?.id,
          projectId,
          agentId: resolveMemoryAgentNamespace({
            targetAgentId: scope.targetAgentId,
            twinId: ctx.agent?.twinId,
            characterId: ctx.agent?.id,
          }),
          branch: scope.branch,
          path: scope.path,
        },
        topK: config.retrievalTopK,
        relevanceFloor: config.relevanceFloor,
        maxTokens: config.recallTokenBudget,
        twinChunkTexts: [...ctx.kernelRetrieval.identityTexts],
        enableQueryExpansion: config.enableQueryExpansion,
        recencyHalfLifeDays: config.decayHalfLifeDays,
        // Memory's vector backend shares the twin embedding model, so the
        // turn's query embedding is reused rather than recomputed.
        ...(ctx.query.embedding ? { precomputedQueryEmbedding: [...ctx.query.embedding] } : {}),
        deps: scopedDeps,
      })
      const handoff: RecallHandoff = { limit: result.budget.limit, used: result.budget.used }
      const reported =
        result.retrievedMemories.length > 0 || result.proceduralCount > 0 || result.degraded
      const sources: MemoryRecallSources = {
        retrievedMemories: result.retrievedMemories.map((m) => ({
          id: m.id,
          type: m.type,
          text: m.text,
          score: m.score,
          evidenceState: m.evidenceState,
          reviewStatus: m.reviewStatus,
        })),
        proceduralCount: result.proceduralCount,
        withheldCount: result.withheldCount,
        budget: result.budget,
        degraded: result.degraded,
        // Delivery receipt: the chat hook's sources merge upgrades it to
        // `delivered` as it lands on the assistant message.
        snapshot: result.snapshot,
      }
      return {
        text: result.systemPromptSection ?? "",
        handoff,
        ...(reported ? { sources } : {}),
      }
    },
  },
  {
    id: "continuity",
    cache: "turn",
    slot: "continuity",
    after: "recall",
    deadlineMs: RECALL_DEADLINE_MS,
    produce: async (ctx) => {
      const inputs = memoryInputs(ctx)
      if (!inputs) return null
      const { deps, query, config, policy, scope, projectId } = inputs
      const { evaluateProjectRecallGate } = await import("@cognia/memory/runtime/recall-gate")
      const gate = evaluateProjectRecallGate({
        userMessage: query,
        projectId,
        enableProjectContinuity: config.enableProjectContinuity,
        temporary: config.temporary,
      })
      // Claims live at workspace scope, so an agent that may not read that
      // scope may not read them: the same narrowing recall applies.
      if (!gate.allowed || !policy.canRecall || !policy.readableScopes.includes("workspace"))
        return null
      const [{ applyProjectContinuityContext }, { resolveProjectRecallBudget }] = await Promise.all(
        [
          import("@cognia/memory/runtime/project-continuity-context"),
          import("@cognia/memory/runtime/recall-budget"),
        ]
      )
      const personal = ctx.prior as RecallHandoff | undefined
      const { limit } = resolveProjectRecallBudget({
        personalLimit: personal?.limit ?? config.recallTokenBudget,
        personalUsed: personal?.used ?? config.recallTokenBudget,
        projectBudget: config.projectRecallTokenBudget,
      })
      const result = await applyProjectContinuityContext({
        userMessage: query,
        reader: { projectId, branch: scope.branch, path: scope.path },
        topK: config.projectRecallTopK,
        relevanceFloor: config.relevanceFloor,
        maxTokens: limit,
        enableQueryExpansion: config.enableQueryExpansion,
        recencyHalfLifeDays: config.decayHalfLifeDays,
        ...(ctx.query.embedding ? { precomputedQueryEmbedding: [...ctx.query.embedding] } : {}),
        deps,
      })
      const reported = result.claims.length > 0 || result.degraded
      const sources: ProjectContinuitySources = {
        claims: result.claims,
        withheldCount: result.withheldCount,
        budget: result.budget,
        weak: result.weak,
        degraded: result.degraded,
      }
      return { text: result.systemPromptSection ?? "", ...(reported ? { sources } : {}) }
    },
  },
]
