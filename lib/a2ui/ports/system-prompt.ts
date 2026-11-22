import type { A2UISystemPromptPort } from "@/types/modules/ports/a2ui-system-prompt"
import { buildAgentA2UICatalogSection } from "../agent-catalog-prompt"
import { A2UI_SYSTEM_PROMPT } from "../prompts"
import { resolveA2UICatalogId } from "../runtime-settings"

export const port: A2UISystemPromptPort = {
  // Resolve the effective custom catalog the same way `a2ui-surface.tsx` does:
  // the agent's registered catalog first, then the app's configured default.
  systemSection: ({ catalogId, configuredCatalogId }) =>
    [
      A2UI_SYSTEM_PROMPT,
      buildAgentA2UICatalogSection(resolveA2UICatalogId(undefined, configuredCatalogId, catalogId)),
    ]
      .filter(Boolean)
      .join("\n\n"),
}
