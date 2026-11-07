/**
 * What the slash-commands module contributes to the prompt catalog (ADR-0250
 * §14 prompt contributions): the workflow Copilot turns `/run`, `/debug`,
 * `/refactor` and the subagent delegations send. Each definition stays beside
 * the code that resolves it (`./actions/workflow.ts`).
 */

import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import { WORKFLOW_SLASH_PROMPTS } from "./actions/workflow"

export const prompts: ModulePromptsModule["prompts"] = Object.values(WORKFLOW_SLASH_PROMPTS)
