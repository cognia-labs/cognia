/**
 * Pure gate for the OCR agent tool (`cognia-ocr` / `ocr.extract`, ADR-0024).
 *
 * Extracted from `build-options.ts` so the verdict is unit-testable without the
 * full send-options pipeline (mirrors the `applyComputerUseTools` split).
 *
 * OCR is low-risk, so unlike Computer Use it defaults to **allowed** in every
 * surface, including IM-bound conversations. It is suppressed only on an
 * explicit opt-out:
 *   - `character.enableOcr === false` (kill switch for a character), or
 *   - for an IM session, the per-conversation `allowOcr === false`.
 */

import type { Character } from "@cognia/agent-config-types"
import type { PluginToolManifestEntry } from "@/lib/plugin/bridge/sidecar-tools-bridge"
import type { SessionImAuthority } from "@cognia/plugin-contract/types/connectors/binding"

export const SCREENSHOT_PLUGIN_ID = "cognia-screenshot"
export const OCR_PLUGIN_ID = "cognia-ocr"

export const SCREENSHOT_TOOL_NAMES = [
  "take_screenshot",
  "extract_screenshot_ocr",
  "list_screenshot_monitors",
] as const
export const OCR_TOOL_NAMES = [
  "ocr.extract",
  "ocr_extract",
  "extract_screenshot_ocr",
  "find_text",
  "click_text",
] as const

export function isOcrPluginTool(tool: Pick<PluginToolManifestEntry, "pluginId" | "name">): boolean {
  return (
    tool.pluginId === OCR_PLUGIN_ID ||
    (tool.pluginId === SCREENSHOT_PLUGIN_ID && tool.name === "extract_screenshot_ocr") ||
    (tool.pluginId === "cognia-computer-use" &&
      (tool.name === "find_text" || tool.name === "click_text"))
  )
}

export function restrictOcrScreenTools(
  manifest: PluginToolManifestEntry[]
): PluginToolManifestEntry[] {
  return manifest
    .filter((tool) => tool.pluginId !== SCREENSHOT_PLUGIN_ID)
    .map((tool) => {
      if (tool.pluginId !== OCR_PLUGIN_ID || tool.name !== "ocr.extract") return tool
      const schema = tool.jsonSchema as {
        properties?: Record<
          string,
          {
            properties?: Record<string, object>
          }
        >
      }
      const source = schema.properties?.source
      return {
        ...tool,
        description: "Extract text from an image or PDF file, or an inline data URL.",
        jsonSchema: {
          ...schema,
          properties: {
            ...schema.properties,
            source: {
              ...source,
              description: "An inline data URL.",
              properties: { ...source?.properties, kind: { type: "string", enum: ["data_url"] } },
            },
          },
        },
      }
    })
}

/** Check live session policy again at execution, after argument rewrites. */
export async function allowsOcrToolCall(
  pluginId: string,
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string
): Promise<boolean> {
  const isOcr = isOcrPluginTool({ pluginId, name: toolName })
  const capturesScreen =
    pluginId === SCREENSHOT_PLUGIN_ID ||
    (pluginId === "cognia-computer-use" && isOcr) ||
    (pluginId === OCR_PLUGIN_ID &&
      (args.source as { kind?: unknown } | undefined)?.kind === "screen")
  if (!sessionId || (!isOcr && !capturesScreen)) return true
  const { getSession } = await import("@/lib/db/sessions")
  const session = await getSession(sessionId)
  if (!session) return false
  const { resolveCharacterById } = await import("@/lib/db/characters")
  const character = session.characterId
    ? await resolveCharacterById(session.characterId)
    : undefined
  if (isOcr && !isOcrToolAllowed({ character })) return false
  const binding =
    (session as typeof session & SessionImAuthority).imAuthorityBinding ?? session.platformBinding
  if (!binding?.adapterId) return true
  const { conversationChannelFor } = await import("@/lib/chat/conversation-channel")
  const channel = await conversationChannelFor(binding)
  if (!channel) return false
  const caps = await channel.hostCapabilities({
    binding,
    characterComputerUseEnabled: character?.enableComputerUse,
  })
  return (!isOcr || caps.ocr) && (!capturesScreen || caps.computer_use)
}

export interface OcrToolGateInput {
  character?: Pick<Character, "enableOcr"> | null
  /** True when the session is bound to an IM platform adapter. */
  imSession?: boolean
  /** `ConversationOverrideRow.allowOcr` for the IM conversation, if any. */
  allowOcrOverride?: boolean
}

/** True when the `ocr.extract` tool should be surfaced to the model. */
export function isOcrToolAllowed(input: OcrToolGateInput): boolean {
  if (input.character?.enableOcr === false) return false
  if (input.imSession && input.allowOcrOverride === false) return false
  return true
}
