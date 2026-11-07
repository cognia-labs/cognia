/**
 * What an agent's bound knowledge bases add to a run, as the knowledge-base
 * module's context contributions (ADR-0250 §14 `context` amendment).
 *
 * - `reader` adds no text. It captures what the conversation may read this
 *   run (the agent's bases narrowed by the capability grant and the caller's
 *   ceiling) and, while progressive reading is on, the reader over them. The
 *   kernel keeps that as the conversation's session state, which the module's
 *   `knowledge_*` tools (`./agent-tools.ts`), nested dispatch and the plugin
 *   project API read (`./runtime/session-reader.ts`). It always answers, so a
 *   run without bases still replaces a wider capture a previous run left.
 * - `retrieval` is the turn's retrieved excerpts, a turn section in the
 *   `agent-knowledge` slot, with the chunks and citations reported for the UI
 *   under `contextSources["knowledge-base.retrieval"]`. A chunk whose text
 *   leaks PII is left out before budgeting, so the remaining chunks still
 *   reach the prompt; the kernel's PII gate then checks the section as a
 *   whole.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import { applyCapabilityIdDelta } from "@cognia/agent-config-types/agent-capability-grant"
import type { TwinRuntimeDepsForBuild } from "@/lib/claude/build-options"
import type { ContextContribution, ContextTurnContext } from "@/lib/modules/manifest-types"
import type { KnowledgeBaseChunk, KnowledgeBaseSource } from "@/types/knowledge-base"
import {
  getKnowledgeBaseDocumentSnapshot,
  getKnowledgeBaseSourcesByIds,
  listKnowledgeBaseSources,
} from "@/lib/db/knowledge-bases"
import { authorizeKnowledgeSource } from "@/lib/workflow/knowledge/access"
import { applyAgentKnowledgeContextFromDb } from "./runtime/apply-agent-knowledge-context"
import {
  createKnowledgeReader,
  type KnowledgeReader,
  type KnowledgeReadingAccess,
} from "./runtime/progressive-reading"
import { resolveKnowledgeReadingSettings } from "./runtime/reading-settings"
import { retrieveKnowledgeBaseChunks, type KnowledgeBaseRuntimeDeps } from "./runtime/retrieve"
import { captureKnowledgeSessionState } from "./runtime/session-reader"

declare module "@/lib/modules/manifest-types" {
  interface ContextHostDepsMap {
    /** The vector store and embedding the caller resolved for knowledge retrieval. */
    projectKnowledge: TwinRuntimeDepsForBuild
    /** The caller's knowledge ceiling: allowed bases, revisions, entrypoint. */
    knowledgeAccess: KnowledgeReadingAccess
  }
}

/** The run's knowledge scope: bound bases within the grant and the ceiling, and how to read them. */
function resolveScope(ctx: ContextTurnContext) {
  const access = ctx.hostDeps.knowledgeAccess
  const knowledgeBaseIds = applyCapabilityIdDelta(
    ctx.agent?.knowledgeBaseIds ?? [],
    ctx.grant?.knowledgeBases
  ).filter((id) => !access?.allowedKnowledgeBaseIds || access.allowedKnowledgeBaseIds.includes(id))
  const settings = resolveKnowledgeReadingSettings(
    ctx.settings?.knowledgeReading,
    ctx.agent?.knowledgeReading,
    ctx.session?.knowledgeReading
  )
  /** Document-level authorization, applied before any content reaches the run. */
  const authorize = (source: KnowledgeBaseSource | undefined): boolean =>
    Boolean(
      source &&
      knowledgeBaseIds.includes(source.knowledgeBaseId) &&
      authorizeKnowledgeSource({
        source,
        entrypoint: access?.entrypoint,
        triggeredBy: access?.triggeredBy,
      }).allowed
    )
  return { access, knowledgeBaseIds, settings, authorize }
}

function createReader(
  ctx: ContextTurnContext,
  scope: ReturnType<typeof resolveScope>
): KnowledgeReader {
  const { access, knowledgeBaseIds, settings, authorize } = scope
  const runtimeDeps = ctx.hostDeps.projectKnowledge
  return createKnowledgeReader({
    knowledgeBaseIds,
    ...access,
    settings,
    deps: {
      listSources: listKnowledgeBaseSources,
      getSources: getKnowledgeBaseSourcesByIds,
      getSnapshot: getKnowledgeBaseDocumentSnapshot,
      retrieveCandidates: async (query, strategy) => {
        const results = await Promise.all(
          knowledgeBaseIds.map((knowledgeBaseId) =>
            retrieveKnowledgeBaseChunks({
              knowledgeBaseId,
              userMessage: query,
              topK: settings.topKPerBase,
              tokenBudget: settings.ragTokenBudget,
              strategy,
              generationIds: access?.revisionBindings?.[knowledgeBaseId],
              authorizeChunk: async (chunk) =>
                authorize((await getKnowledgeBaseSourcesByIds([chunk.sourceId]))[0]),
              deps: runtimeDeps as KnowledgeBaseRuntimeDeps | undefined,
            })
          )
        )
        return results.flatMap((result) =>
          result.chunks.map(({ chunk, score }) => ({
            knowledgeBaseId: chunk.knowledgeBaseId,
            sourceId: chunk.sourceId,
            score,
          }))
        )
      },
    },
  })
}

/** A chunk may enter the prompt only when neither its document title nor its text leaks PII. */
function chunkIsClean(chunk: KnowledgeBaseChunk, source: KnowledgeBaseSource | undefined): boolean {
  return hasNoLeakingPii(`${source?.title ?? ""}\n${chunk.content}`)
}

export const contributions: readonly ContextContribution[] = [
  {
    id: "reader",
    cache: "turn",
    produce: (ctx) => {
      const scope = resolveScope(ctx)
      const reader =
        scope.settings.enabled && scope.knowledgeBaseIds.length > 0
          ? createReader(ctx, scope)
          : undefined
      return {
        text: "",
        sessionState: captureKnowledgeSessionState({
          knowledgeBaseIds: scope.knowledgeBaseIds,
          knowledgeAccess: scope.access,
          reader,
        }),
      }
    },
  },
  {
    id: "retrieval",
    cache: "turn",
    slot: "agent-knowledge",
    // Bound libraries are queried in parallel, each embedding the query.
    deadlineMs: 15_000,
    produce: async (ctx) => {
      const scope = resolveScope(ctx)
      const query = ctx.query.text?.trim()
      const runtimeDeps = ctx.hostDeps.projectKnowledge
      if (
        scope.knowledgeBaseIds.length === 0 ||
        !query ||
        !(runtimeDeps?.vectorBackend || scope.settings.retrievalStrategy === "keyword")
      )
        return null
      const result = await applyAgentKnowledgeContextFromDb({
        knowledgeBaseIds: scope.knowledgeBaseIds,
        userMessage: ctx.query.text ?? query,
        topKPerBase: scope.settings.topKPerBase,
        tokenBudget: scope.settings.ragTokenBudget,
        retrievalStrategy: scope.settings.retrievalStrategy,
        revisionBindings: scope.access?.revisionBindings,
        authorizeChunk: ({ chunk, source }) =>
          scope.authorize(source) && chunkIsClean(chunk, source),
        ...(ctx.query.embedding ? { precomputedQueryEmbedding: [...ctx.query.embedding] } : {}),
        runtimeDeps: runtimeDeps as KnowledgeBaseRuntimeDeps | undefined,
      })
      const reported = result.retrievedChunks.length > 0 || result.degraded
      return {
        text: result.systemPromptSection ?? "",
        ...(reported
          ? {
              sources: {
                retrievedChunks: result.retrievedChunks,
                citations: result.citations,
                failures: result.failures,
                budget: result.budget,
                degraded: result.degraded,
              },
            }
          : {}),
      }
    },
  },
]
