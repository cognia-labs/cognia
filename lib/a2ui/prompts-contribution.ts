import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import { EXECUTION_ENHANCE_PROMPT } from "./from-execution/enhance"
import { A2UI_CREATE_APP_PROMPT, A2UI_EDIT_APP_PROMPT } from "./generate-prompts"
import { A2UI_PROTOCOL_PROMPT } from "./prompts"

export const prompts: ModulePromptsModule["prompts"] = [
  A2UI_PROTOCOL_PROMPT,
  A2UI_CREATE_APP_PROMPT,
  A2UI_EDIT_APP_PROMPT,
  EXECUTION_ENHANCE_PROMPT,
]
