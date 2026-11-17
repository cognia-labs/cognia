/**
 * Project-knowledge read runtime — mirrors `lib/memory/runtime/apply-memory-context.ts`:
 * best-effort, dependency-injected, and **never throws**. Assembles a
 * system-prompt section from the active workspace's retrieved knowledge chunks.
 *
 * The section COEXISTS with (and is appended after) the Twin + Memory sections
 * by `resolveSendOptions` — project knowledge is retrieved factual context, not
 * a persona, so it never replaces the base system prompt.
 */

import type { ProjectKnowledgeExcerpt } from "@/types/project-knowledge"
import {
  retrieveProjectChunks,
  type ProjectKnowledgeRuntimeDeps,
  type RetrievedProjectChunk,
} from "./retrieve"

export interface ApplyProjectKnowledgeContextInput {
  projectId: string
  userMessage: string
  topK: number
  precomputedQueryEmbedding?: number[]
  strategy?: "vector" | "hybrid" | "keyword"
  fileIds?: readonly string[]
  /** Map of `KnowledgeFile.id` → display name, for citations. */
  fileNames?: Record<string, string>
  /** Drops a retrieved chunk before it enters the section (and the reported chunks). */
  keepChunk?: (chunk: AppliedProjectChunk) => boolean
  deps?: ProjectKnowledgeRuntimeDeps
}

/** A retrieved excerpt as the prompt and the turn's citations carry it. */
export type AppliedProjectChunk = ProjectKnowledgeExcerpt

export interface ApplyProjectKnowledgeContextResult {
  /** Section to append to the system prompt, or null when nothing to inject. */
  systemPromptSection: string | null
  retrievedChunks: AppliedProjectChunk[]
  degraded: boolean
}

const HEADING = "## Project knowledge base"
const PREAMBLE =
  "The following excerpts are retrieved from this workspace's knowledge files. " +
  "Use them when they are relevant to the user's request, and cite the source file by name " +
  "and character range."

const EMPTY: ApplyProjectKnowledgeContextResult = {
  systemPromptSection: null,
  retrievedChunks: [],
  degraded: false,
}

export async function applyProjectKnowledgeContext(
  input: ApplyProjectKnowledgeContextInput
): Promise<ApplyProjectKnowledgeContextResult> {
  const query = input.userMessage.trim()
  if (!query || input.topK <= 0) return EMPTY

  try {
    const result = await retrieveProjectChunks({
      projectId: input.projectId,
      userMessage: query,
      topK: input.topK,
      precomputedQueryEmbedding: input.precomputedQueryEmbedding,
      strategy: input.strategy,
      fileIds: input.fileIds,
      deps: input.deps,
    })

    const retrievedChunks: AppliedProjectChunk[] = result.chunks
      .map((rc: RetrievedProjectChunk): AppliedProjectChunk => ({
        projectId: rc.chunk.projectId,
        fileId: rc.chunk.fileId,
        fileName: input.fileNames?.[rc.chunk.fileId],
        chunkId: rc.chunk.id,
        ...(rc.chunk.generationId ? { generationId: rc.chunk.generationId } : {}),
        contentHash: rc.chunk.contentHash,
        charStart: rc.chunk.charStart,
        charEnd: rc.chunk.charEnd,
        content: rc.chunk.content,
        score: rc.score,
      }))
      .filter((chunk) => !input.keepChunk || input.keepChunk(chunk))

    if (retrievedChunks.length === 0) {
      return { systemPromptSection: null, retrievedChunks: [], degraded: result.degraded }
    }

    // Two files may share a name; their excerpts must still read as distinct.
    const fileIdsByName = new Map<string, Set<string>>()
    for (const c of retrievedChunks)
      if (c.fileName)
        fileIdsByName.set(c.fileName, (fileIdsByName.get(c.fileName) ?? new Set()).add(c.fileId))
    const body = retrievedChunks
      .map((c) => {
        const name = c.fileName
          ? (fileIdsByName.get(c.fileName)?.size ?? 0) > 1
            ? `${c.fileName} (file ${c.fileId})`
            : c.fileName
          : `file ${c.fileId}`
        return `[${name}, characters ${c.charStart}–${c.charEnd}]\n${c.content}`
      })
      .join("\n\n")

    return {
      systemPromptSection: `${HEADING}\n${PREAMBLE}\n\n${body}`,
      retrievedChunks,
      degraded: result.degraded,
    }
  } catch {
    return { ...EMPTY, degraded: true }
  }
}
