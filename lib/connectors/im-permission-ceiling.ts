import type { Character } from "@cognia/agent-config-types"
import Dexie from "dexie"
import { autonomyAuthorityCap, narrowAuthority } from "@cognia/agent-config-types/agent-composition"

import { COMPUTER_USE_PLUGIN_TOOL_NAMES } from "@/lib/claude/computer-use-tools"
import { effectiveCapabilitiesForRow } from "@/lib/connectors/effective-capabilities"
import { resolveImHostCapabilities } from "@/lib/connectors/permission-resolve"
import { resolveImEffectiveConfig } from "@/lib/connectors/effective-config"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { BuiltInSkill } from "@/lib/skills/built-in/types"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { PlatformKind } from "@/types/connectors/platform-kind"

/** Canonical scheduler tool names; kept outside build-options to avoid runtime cycles. */
export const IM_SCHEDULER_TOOL_NAMES = [
  "mcp__cognia__schedule_task",
  "mcp__cognia__list_scheduled_tasks",
  "mcp__cognia__cancel_scheduled_task",
] as const

export const IM_OCR_TOOL_NAMES = ["ocr.extract", "mcp__cognia-plugin-tools__ocr.extract"] as const

function builtInToolAliases(toolName: string): string[] {
  return [toolName, `mcp__cognia-builtin-skills__${toolName}`]
}

export function deriveImPermissionCeiling(input: {
  adapter: AdapterInstanceRow
  override: ConversationOverrideRow | null
  character?: Pick<Character, "enableComputerUse"> | null
  allBuiltInSkills: readonly Pick<BuiltInSkill, "mcpToolName">[]
  allowedBuiltInToolNames: ReadonlySet<string>
  /** Team/Workflow targets own their Computer Use ability; Character does not modify it. */
  target: "direct" | "team" | "workflow"
  composition?: Pick<ReturnType<typeof resolveImEffectiveConfig>, "authority" | "autonomy">
}): AgentPermissionCeiling {
  const host = resolveImHostCapabilities({
    adapter: input.adapter,
    override: input.override,
    characterComputerUseEnabled:
      input.target === "direct" ? input.character?.enableComputerUse === true : true,
  })
  const denied = new Set<string>()

  for (const skill of input.allBuiltInSkills) {
    if (!input.allowedBuiltInToolNames.has(skill.mcpToolName)) {
      for (const name of builtInToolAliases(skill.mcpToolName)) denied.add(name)
    }
  }
  if (!host.computer_use) {
    for (const name of COMPUTER_USE_PLUGIN_TOOL_NAMES) denied.add(name)
  }
  if (!host.ocr) {
    for (const name of IM_OCR_TOOL_NAMES) denied.add(name)
  }
  if (!host.schedule_tools) {
    for (const name of IM_SCHEDULER_TOOL_NAMES) denied.add(name)
  }

  const composition =
    input.composition ??
    resolveImEffectiveConfig({
      adapter: input.adapter,
      override: input.override,
      rule: null,
      system: { mode: input.adapter.defaultMode },
    })
  const cap = autonomyAuthorityCap(composition.autonomy.effective)
  const authority = composition.authority.effective
  const permissionMode = cap ? narrowAuthority(cap, authority) : authority
  return {
    ...(permissionMode
      ? { permissionMode: permissionMode as NonNullable<AgentPermissionCeiling["permissionMode"]> }
      : {}),
    ...(denied.size > 0 ? { disallowedTools: Array.from(denied) } : {}),
  }
}

/**
 * Build the parent ceiling once per IM turn. Nested targets combine this with
 * their own policy through `deriveExternalSessionPermission`.
 */
export async function buildImPermissionCeiling(input: {
  adapter: AdapterInstanceRow
  override: ConversationOverrideRow | null
  character?: Pick<Character, "enableComputerUse"> | null
  platform: PlatformKind
  target: "direct" | "team" | "workflow"
  composition?: Pick<ReturnType<typeof resolveImEffectiveConfig>, "authority" | "autonomy">
}): Promise<AgentPermissionCeiling> {
  const [{ buildBuiltInSkillManifest }, { getSharedBuiltInSkillRegistry }] =
    await Dexie.ignoreTransaction(async () => {
      await import("@/lib/skills/built-in")
      return Promise.all([
        import("@/lib/skills/built-in/manifest"),
        import("@/lib/skills/built-in/registry"),
      ])
    })
  const manifest = buildBuiltInSkillManifest({
    imBinding: {
      platform: input.platform,
      adapterId: input.adapter.id,
      conversationKey: input.override?.conversationKey ?? "",
    },
    imOverrideRow: input.override ?? undefined,
    imAdapterRow: input.adapter,
    // The ceiling must be derived from what this BOT can do, not what the
    // platform's adapter module implements: a Slack install whose grant lacks
    // `files:write` would otherwise be handed an upload tool that answers
    // `missing_scope`. No scene is passed — the ceiling is per-turn but not
    // per-conversation-scene, and an instance-level projection is the honest
    // answer at this granularity.
    channelCapabilities: effectiveCapabilitiesForRow(input.adapter).capabilities,
  })
  return deriveImPermissionCeiling({
    ...input,
    allBuiltInSkills: getSharedBuiltInSkillRegistry().list(),
    allowedBuiltInToolNames: new Set(manifest.map((entry) => entry.name)),
  })
}
