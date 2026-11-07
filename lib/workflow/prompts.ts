/**
 * What the workflow module contributes to the prompt catalog (ADR-0250 §14
 * prompt contributions): the AI nodes' ensemble, classify, extract,
 * structured-output and schema-repair prompts, and the editor Copilot's
 * identity, quick actions and slash-command turns. Each definition stays
 * beside the code that resolves it.
 */

import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import { WORKFLOW_COPILOT_PROMPT } from "./editor/copilot-prompts"
import { WORKFLOW_SLASH_PROMPTS } from "./editor/copilot-slash-commands"
import { WORKFLOW_QUICK_ACTION_PROMPTS } from "./editor/quick-action-prompts"
import {
  ENSEMBLE_SYNTHESIZER_PROMPT,
  ENSEMBLE_SYNTHESIZER_REQUEST_PROMPT,
} from "./nodes/ai/ai-ensemble"
import { CLASSIFY_NODE_PROMPT, EXTRACT_NODE_PROMPT } from "./nodes/ai/executors"
import { SCHEMA_REPAIR_PROMPT } from "./nodes/ai/schema-validate"
import { JSON_OUTPUT_PROMPT, JSON_OUTPUT_SHAPE_PROMPT } from "./nodes/ai/structured"

export const prompts: ModulePromptsModule["prompts"] = [
  ENSEMBLE_SYNTHESIZER_PROMPT,
  ENSEMBLE_SYNTHESIZER_REQUEST_PROMPT,
  CLASSIFY_NODE_PROMPT,
  EXTRACT_NODE_PROMPT,
  JSON_OUTPUT_PROMPT,
  JSON_OUTPUT_SHAPE_PROMPT,
  SCHEMA_REPAIR_PROMPT,
  WORKFLOW_COPILOT_PROMPT,
  ...Object.values(WORKFLOW_QUICK_ACTION_PROMPTS),
  ...Object.values(WORKFLOW_SLASH_PROMPTS),
]
