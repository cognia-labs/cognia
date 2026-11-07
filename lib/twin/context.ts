/**
 * The twin module's context contribution (ADR-0250 §14 `context` amendment,
 * plan §17): `identity`, the section that makes a twin-bound agent speak as
 * the person it was distilled from.
 *
 * It sits in the `identity` slot, so it does not join the prompt but stands
 * in for the agent's base system prompt, and the persona section is left
 * out. Its retrieved chunks and style few-shot are the turn-varying part
 * (`cacheSplit.dynamic`), kept out of the cacheable prefix when cache
 * optimization is on. It runs before every other contribution and hands the
 * redacted text of its chunks over, which memory recall leaves out
 * (`ctx.kernelRetrieval.identityTexts`).
 *
 * It runs only for an agent bound to a twin, with the caller's twin deps and
 * a non-blank query (`hostDeps.twin`, `hostDeps.twinQuery`). The runtime
 * never throws; a prompt that leaks PII is left out here (and the kernel's
 * gate checks again), and a retrieval that takes longer than the deadline
 * counts as a failure. Every run is recorded in the inject log the Settings
 * card reads.
 */

import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { TwinRuntimeDepsForBuild } from "@/lib/claude/build-options"
import type { ContextContribution } from "@/lib/modules/manifest-types"
import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"
import type { TwinIdentitySources } from "@/types/twin/context-sources"

declare module "@/lib/modules/manifest-types" {
  interface ContextHostDepsMap {
    /** The vector store and embedding the caller resolved for twin retrieval. */
    twin: TwinRuntimeDepsForBuild
    /** The turn's text for twin retrieval; the twin does not run without it. */
    twinQuery: string
    /** Who asked, as the inject log names it (chat, team, workflow node, connector). */
    twinInjectSource: string
  }
}

/** How long the twin's retrieval may take; the kernel holds it to the same. */
export const TWIN_IDENTITY_DEADLINE_MS = 15_000
/**
 * The twin gives up a little earlier than the kernel, so the inject log
 * records the timeout rather than a late result the kernel already dropped.
 */
const TWIN_RETRIEVAL_BUDGET_MS = TWIN_IDENTITY_DEADLINE_MS - 1_000

class TwinRetrievalTimeout extends Error {
  constructor() {
    super(`twin retrieval took longer than ${TWIN_RETRIEVAL_BUDGET_MS} ms`)
  }
}

function withinBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TwinRetrievalTimeout()), TWIN_RETRIEVAL_BUDGET_MS)
  })
  return Promise.race([work, budget]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export const contributions: readonly ContextContribution[] = [
  {
    id: "identity",
    cache: "turn",
    slot: "identity",
    deadlineMs: TWIN_IDENTITY_DEADLINE_MS,
    produce: async (ctx) => {
      const character = ctx.agent
      const twinId = character?.twinId
      const deps = ctx.hostDeps.twin
      const query = ctx.hostDeps.twinQuery
      if (!character || !twinId || !deps || !query?.trim()) return null
      const [{ applyTwinContext }, { recordTwinInject }] = await Promise.all([
        import("./runtime/apply-twin-context"),
        import("./runtime/inject-log"),
      ])
      const source = ctx.hostDeps.twinInjectSource ?? "chat"
      const startedAt = Date.now()
      let result: Awaited<ReturnType<typeof applyTwinContext>>
      try {
        result = await withinBudget(
          applyTwinContext({
            character,
            userMessage: query,
            ...(ctx.query.embedding ? { precomputedQueryEmbedding: [...ctx.query.embedding] } : {}),
            deps: deps as Parameters<typeof applyTwinContext>[0]["deps"],
          })
        )
      } catch (error) {
        if (!(error instanceof TwinRetrievalTimeout)) throw error
        // A retrieval past its budget counts as a failure: the base prompt stays.
        await recordTwinInject({
          ts: Date.now(),
          twinId,
          source,
          applied: false,
          degraded: true,
          degradedReason: "timeout",
          chunkCount: 0,
          styleSampleCount: 0,
          tokensApprox: 0,
          durationMs: Date.now() - startedAt,
          ...(ctx.session?.id ? { sessionId: ctx.session.id } : {}),
        })
        return null
      }
      const applied = result.applied
      const blocked = Boolean(
        applied &&
        !hasNoLeakingPiiDeep(applied.cacheSegments ?? { systemPrompt: applied.systemPrompt })
      )
      // Recorded before the section is placed; diagnostic only, so a logging
      // slip never undoes the identity.
      await recordTwinInject({
        ts: Date.now(),
        twinId,
        source,
        applied: Boolean(applied && !blocked),
        degraded: blocked || (result.degraded ?? false),
        degradedReason: blocked ? "prompt-pii-blocked" : (result.degradedReason ?? null),
        chunkCount: result.retrievedChunks?.length ?? 0,
        styleSampleCount: result.selectedStyleSamples?.length ?? 0,
        tokensApprox: applied && !blocked ? estimateFallbackTokens(applied.systemPrompt) : 0,
        durationMs: Date.now() - startedAt,
        chunkIds: result.retrievedChunks.map(({ chunk }) => chunk.id),
        chunkScores: result.retrievedChunks.map((chunk) => chunk.score),
        styleSampleIds: result.selectedStyleSamples.map((sample) => sample.id),
        ...(ctx.session?.id ? { sessionId: ctx.session.id } : {}),
      }).catch(() => undefined)
      // A prompt that leaks PII shapes nothing: no identity, no sources.
      if (blocked) return null
      // Always reported when the runtime ran with something to show (even
      // degraded), so the UI can say the reply skipped retrieval.
      const reported =
        result.retrievedChunks.length > 0 ||
        result.selectedStyleSamples.length > 0 ||
        result.degraded
      const sources: TwinIdentitySources = {
        twinId,
        retrievedChunks: result.retrievedChunks,
        selectedStyleSamples: result.selectedStyleSamples.map((sample) => ({
          id: sample.id,
          contextLabel: sample.contextLabel,
          summary: sample.summary,
          tone: sample.tone,
        })),
        degraded: result.degraded,
        ...(result.citations ? { citations: result.citations } : {}),
      }
      return {
        text: applied?.systemPrompt ?? "",
        ...(applied?.cacheSegments ? { cacheSplit: applied.cacheSegments } : {}),
        handoff: result.retrievedChunks.map(({ chunk }) => chunk.contentRedacted),
        ...(reported ? { sources } : {}),
      }
    },
  },
]
