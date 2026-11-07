/**
 * What the memory module contributes to the prompt catalog (ADR-0250 §14
 * prompt contributions): episodic distillation, fact extraction and
 * consolidation, project mining and recall reranking. Each definition stays
 * beside the code that resolves it.
 */

import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import { MEMORY_RERANK_PROMPT } from "./runtime/rerank-prompt"
import {
  EPISODIC_DISTILL_REQUEST_PROMPT,
  EPISODIC_DISTILL_SYSTEM_PROMPT,
} from "./write/run-episodic-distill"
import { MEMORY_CONSOLIDATE_PROMPT, MEMORY_EXTRACT_PROMPT } from "./write/run-memory-extraction"
import { MEMORY_PROJECT_EXTRACT_PROMPT } from "./write/run-project-mining"

export const prompts: ModulePromptsModule["prompts"] = [
  EPISODIC_DISTILL_SYSTEM_PROMPT,
  EPISODIC_DISTILL_REQUEST_PROMPT,
  MEMORY_EXTRACT_PROMPT,
  MEMORY_PROJECT_EXTRACT_PROMPT,
  MEMORY_CONSOLIDATE_PROMPT,
  MEMORY_RERANK_PROMPT,
]
