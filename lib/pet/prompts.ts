// The pet's code-owned prompts (ADR-0236), as its manifest contributes them to
// the prompt catalog (ADR-0250 §14, M3): the persona layers, the soul
// generator and the sprite hatch. Each definition stays with the code that
// resolves it; this file only lists them for the Prompt Center and the CLI.

import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import { HATCH_PET_SPRITE_PROMPT } from "./hatch-prompt"
import { PET_PROMPTS } from "./llm/persona"
import { PET_SOUL_REQUEST_PROMPT, PET_SOUL_SYSTEM_PROMPT } from "./soul/generate-soul"

export const prompts: ModulePromptsModule["prompts"] = [
  ...Object.values(PET_PROMPTS),
  PET_SOUL_SYSTEM_PROMPT,
  PET_SOUL_REQUEST_PROMPT,
  HATCH_PET_SPRITE_PROMPT,
]
