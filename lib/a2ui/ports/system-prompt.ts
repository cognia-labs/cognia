import type { A2UISystemPromptPort } from "@/types/modules/ports/a2ui-system-prompt"
import { buildAgentA2UICatalogSection } from "../agent-catalog-prompt"
import { A2UI_SYSTEM_PROMPT } from "../prompts"

export const port: A2UISystemPromptPort = {
  // The agent's own catalog (`Character.a2uiCatalogId`) can add component
  // types; name them so the model can use them.
  systemSection: ({ catalogId }) =>
    [A2UI_SYSTEM_PROMPT, buildAgentA2UICatalogSection(catalogId)].filter(Boolean).join("\n\n"),
}
