/**
 * The workspace knowledge base's excerpts for a run, as the project-knowledge
 * module's context contribution (ADR-0250 §14 `context` amendment).
 *
 * `retrieval` is a turn section in the `project-knowledge` slot: the chunks of
 * the run's workspace knowledge files most relevant to the turn's query, with
 * the excerpts reported for the UI under
 * `contextSources["project-knowledge.retrieval"]`. A chunk whose text or file
 * name leaks PII is left out, so the remaining chunks still reach the prompt;
 * the kernel's PII gate then checks the section as a whole.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import type { TwinRuntimeDepsForBuild } from "@/lib/claude/build-options"
import type { ContextContribution } from "@/lib/modules/manifest-types"
import { resolveProjectKnowledgeSettings } from "@/types/project-knowledge"
import {
  applyProjectKnowledgeContext,
  type AppliedProjectChunk,
} from "./runtime/apply-project-context"
import type { ProjectKnowledgeRuntimeDeps } from "./runtime/retrieve"

declare module "@/lib/modules/manifest-types" {
  interface ContextHostDepsMap {
    /**
     * The vector store and embedding the caller resolved for knowledge
     * retrieval; the workspace knowledge base and the agent's bound knowledge
     * bases both retrieve through it.
     */
    projectKnowledge: TwinRuntimeDepsForBuild
  }
}

/** A chunk may enter the prompt only when neither its file name nor its text leaks PII. */
function chunkIsClean(chunk: AppliedProjectChunk): boolean {
  return hasNoLeakingPii(`${chunk.fileName ?? ""}\n${chunk.content}`)
}

export const contributions: readonly ContextContribution[] = [
  {
    id: "retrieval",
    cache: "turn",
    slot: "project-knowledge",
    // The query is embedded before the workspace collection is searched.
    deadlineMs: 15_000,
    produce: async (ctx) => {
      const project = ctx.activeProject
      const files = project?.knowledgeBase ?? []
      const query = ctx.query.text?.trim()
      const runtimeDeps = ctx.hostDeps.projectKnowledge
      const settings = resolveProjectKnowledgeSettings(project?.knowledgeSettings)
      if (
        !project ||
        files.length === 0 ||
        !query ||
        !settings.enableProjectRag ||
        !(runtimeDeps || settings.retrievalStrategy === "keyword")
      )
        return null
      const result = await applyProjectKnowledgeContext({
        projectId: project.id,
        userMessage: ctx.query.text ?? query,
        topK: settings.ragTopK,
        strategy: settings.retrievalStrategy,
        fileIds: files.map((file) => file.id),
        ...(ctx.query.embedding ? { precomputedQueryEmbedding: [...ctx.query.embedding] } : {}),
        fileNames: Object.fromEntries(files.map((file) => [file.id, file.name])),
        keepChunk: chunkIsClean,
        deps: runtimeDeps as ProjectKnowledgeRuntimeDeps | undefined,
      })
      const reported = result.retrievedChunks.length > 0 || result.degraded
      return {
        text: result.systemPromptSection ?? "",
        ...(reported
          ? { sources: { retrievedChunks: result.retrievedChunks, degraded: result.degraded } }
          : {}),
      }
    },
  },
]
