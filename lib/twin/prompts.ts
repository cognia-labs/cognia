/**
 * What the twin module contributes to the prompt catalog (ADR-0250 §14
 * prompt contributions): the distillation agents, the retrieval reranker and
 * the twin system prompt templates. Each definition stays beside the code
 * that resolves it.
 */

import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import {
  ENTITY_MERGE_AGENT_PROMPT,
  EVALUATOR_PROMPT,
  KNOWLEDGE_AGENT_PROMPT,
  PLAYBOOK_AGENT_PROMPT,
  STYLE_AGENT_PROMPT,
  SYNTHESIZER_PROMPT,
} from "./distill/prompts"
import { LLM_RERANK_REQUEST_PROMPT, LLM_RERANK_SYSTEM_PROMPT } from "./runtime/reranker"
import { TWIN_SYSTEM_TEMPLATE_PROMPTS } from "./runtime/system-prompt-template"

export const prompts: ModulePromptsModule["prompts"] = [
  STYLE_AGENT_PROMPT,
  PLAYBOOK_AGENT_PROMPT,
  KNOWLEDGE_AGENT_PROMPT,
  SYNTHESIZER_PROMPT,
  EVALUATOR_PROMPT,
  ENTITY_MERGE_AGENT_PROMPT,
  LLM_RERANK_SYSTEM_PROMPT,
  LLM_RERANK_REQUEST_PROMPT,
  ...Object.values(TWIN_SYSTEM_TEMPLATE_PROMPTS),
]
