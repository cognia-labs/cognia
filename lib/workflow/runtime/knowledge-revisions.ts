/**
 * The knowledge base's revision pinning, as the workflow engine reaches it:
 * through the `knowledge-base-revisions` port (ADR-0250 §14), which the
 * knowledge-base module provides, so the engine does not import the knowledge
 * base. A deployment or app that binds a knowledge base must be pinned, so
 * with no provider it fails to resolve instead of running unpinned.
 */

import { loadPort } from "@/lib/modules/ports"
import type { KnowledgeBaseRevisionsPort } from "@/types/modules/ports/knowledge-base-revisions"

export async function knowledgeBaseRevisions(): Promise<KnowledgeBaseRevisionsPort> {
  const port = await loadPort("knowledge-base-revisions")
  if (!port)
    throw new Error(
      "No module provides knowledge-base revisions, and this workflow binds a knowledge base"
    )
  return port
}
