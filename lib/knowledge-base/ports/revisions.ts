// The knowledge-base module's implementation of the `knowledge-base-revisions`
// port (`types/modules/ports/knowledge-base-revisions.ts`, ADR-0250 §14).

import type { KnowledgeBaseRevisionsPort } from "@/types/modules/ports/knowledge-base-revisions"
import {
  assertKnowledgeBaseRevisionBindings,
  resolveCurrentKnowledgeBaseRevisionBindings,
} from "../revisions"

export const port: KnowledgeBaseRevisionsPort = {
  assertBindings: assertKnowledgeBaseRevisionBindings,
  resolveCurrentBindings: resolveCurrentKnowledgeBaseRevisionBindings,
}
