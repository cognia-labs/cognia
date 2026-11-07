// Browser Companion's code-owned prompts (ADR-0236), as its manifest
// contributes them to the prompt catalog (ADR-0250 §14, M3): the agent-mode
// instruction and the browser-context preambles. Each stays with the code
// that resolves it; this file only lists them.

import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import { BROWSER_COMPANION_AGENT_PROMPT } from "./agent-grant"
import {
  BROWSER_CONTEXT_MULTI_PAGE_PREAMBLE_PROMPT,
  BROWSER_CONTEXT_PREAMBLE_PROMPT,
} from "./build-prompt"

export const prompts: ModulePromptsModule["prompts"] = [
  BROWSER_COMPANION_AGENT_PROMPT,
  BROWSER_CONTEXT_PREAMBLE_PROMPT,
  BROWSER_CONTEXT_MULTI_PAGE_PREAMBLE_PROMPT,
]
