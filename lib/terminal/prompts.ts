/**
 * What the terminal module contributes to the prompt catalog (ADR-0250 §14
 * prompt contributions): the inline command completion, and the AI shell's
 * plan generator and error advisor. Each definition stays beside the code
 * that resolves it.
 */

import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import { AI_SHELL_ERROR_ADVISOR_PROMPT } from "./ai-shell/error-advisor"
import { AI_SHELL_PLAN_PROMPT } from "./ai-shell/plan-generator"
import { TERMINAL_COMPLETION_PROMPT } from "./completion/prompt"

export const prompts: ModulePromptsModule["prompts"] = [
  TERMINAL_COMPLETION_PROMPT,
  AI_SHELL_PLAN_PROMPT,
  AI_SHELL_ERROR_ADVISOR_PROMPT,
]
