// The knowledge-base module's entry in `ContextSourcesMap` (ADR-0250 §14
// `context` amendment). Kept apart from `types/knowledge-base.ts`, which the
// plugin SDK's declarations include: an augmentation of a host module there
// would leak into the published SDK types.

import type { AgentKnowledgeRetrievalSources } from "@/types/knowledge-base"

export type { AgentKnowledgeRetrievalSources }

declare module "@/lib/modules/manifest-types" {
  interface ContextSourcesMap {
    "knowledge-base.retrieval": AgentKnowledgeRetrievalSources
  }
}
