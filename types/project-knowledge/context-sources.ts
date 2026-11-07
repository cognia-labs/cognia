// The project-knowledge module's entry in `ContextSourcesMap` (ADR-0250 §14
// `context` amendment). Kept apart from `types/project-knowledge/index.ts`,
// which shared and SDK-facing types import: an augmentation of a host module
// there would leak into published declarations.

import type { ProjectKnowledgeRetrievalSources } from "@/types/project-knowledge"

export type { ProjectKnowledgeRetrievalSources }

declare module "@/lib/modules/manifest-types" {
  interface ContextSourcesMap {
    "project-knowledge.retrieval": ProjectKnowledgeRetrievalSources
  }
}
