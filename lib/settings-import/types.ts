import type { AppSettings } from "@cognia/agent-config-types"
import type { Ruleset } from "@/lib/claude/permissions/ruleset"

export type SettingsSourceId = "claude-code" | "codex" | "opencode" | "pi"
export type SettingsGroup = "model" | "permissions" | "sandbox" | "env" | "hooks" | "ui"
export type SettingsImportTarget =
  | "defaultModel"
  | "defaultEffort"
  | "outputStyle"
  | "permissionMode"
  | "agentPermissions.toolRules"
  | "sandboxDefaultEnabled"
  | "workspaceConfinementEnabled"
  | "claudeHooks"
  | "unsupported"

export interface SettingsImportDraft {
  id: string
  source: SettingsSourceId
  group: SettingsGroup
  key: string
  target: SettingsImportTarget
  current: unknown
  incoming: unknown
  warnings: string[]
  supported: boolean
  /** True when Cognia and the source already read the same underlying file. */
  shared: boolean
}

export type SettingsImportMergeStrategy = "skip" | "overwrite" | "duplicate"
export type SettingsSnapshot = Partial<AppSettings>

const SOURCES = new Set<SettingsSourceId>(["claude-code", "codex", "opencode", "pi"])
const GROUPS = new Set<SettingsGroup>(["model", "permissions", "sandbox", "env", "hooks", "ui"])

export function isSettingsImportDraft(value: unknown): value is SettingsImportDraft {
  if (!value || typeof value !== "object") return false
  const draft = value as Partial<SettingsImportDraft>
  return (
    typeof draft.id === "string" &&
    SOURCES.has(draft.source as SettingsSourceId) &&
    GROUPS.has(draft.group as SettingsGroup) &&
    typeof draft.key === "string" &&
    typeof draft.target === "string" &&
    Array.isArray(draft.warnings) &&
    typeof draft.supported === "boolean" &&
    typeof draft.shared === "boolean"
  )
}

/** Safety checks shared by adapter drafts and the apply boundary. */
export function settingsImportSafetyWarning(
  target: SettingsImportTarget,
  incoming: unknown
): string | undefined {
  if (target === "permissionMode" && incoming === "bypassPermissions") {
    return "Permission bypass was not imported for safety. To enable it, select permission bypass manually in Cognia's agent settings."
  }
  if (target === "sandboxDefaultEnabled" && incoming === false) {
    return "The sandbox-disable policy was not imported for safety. To disable the sandbox, change it manually in Cognia's sandbox settings."
  }
  if (target === "workspaceConfinementEnabled" && incoming === false) {
    return "The workspace-confinement opt-out was not imported for safety. To disable workspace confinement, change it manually in Cognia's sandbox settings."
  }
  return undefined
}

/** Preserve approval/rejection rules while refusing imported automatic approval. */
export function sanitizeImportedToolRules(incoming: unknown): {
  rules: Ruleset
  warnings: string[]
} {
  const entries: Array<[string, Ruleset[string]]> = []
  let removed = 0
  if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
    for (const [tool, rule] of Object.entries(incoming)) {
      if (rule === "allow") {
        removed += 1
      } else if (rule === "ask" || rule === "deny") {
        entries.push([tool, rule])
      } else if (rule && typeof rule === "object" && !Array.isArray(rule)) {
        const nested: Array<[string, "ask" | "deny"]> = []
        for (const [pattern, verdict] of Object.entries(rule)) {
          if (verdict === "allow") removed += 1
          else if (verdict === "ask" || verdict === "deny") nested.push([pattern, verdict])
        }
        if (nested.length > 0) entries.push([tool, Object.fromEntries(nested)])
      }
    }
  }
  return {
    rules: Object.fromEntries(entries),
    warnings:
      removed > 0
        ? [
            `${removed} allow ${removed === 1 ? "rule was" : "rules were"} not imported for safety. To add allow rules, configure tool permissions manually in Cognia's agent settings.`,
          ]
        : [],
  }
}

export function settingsDraft(
  source: SettingsSourceId,
  group: SettingsGroup,
  key: string,
  target: SettingsImportTarget,
  current: unknown,
  incoming: unknown,
  options: Partial<Pick<SettingsImportDraft, "warnings" | "supported" | "shared">> = {}
): SettingsImportDraft {
  const safetyWarning = settingsImportSafetyWarning(target, incoming)
  const toolRules =
    target === "agentPermissions.toolRules" ? sanitizeImportedToolRules(incoming) : undefined
  const unsupported =
    !!safetyWarning || (toolRules !== undefined && Object.keys(toolRules.rules).length === 0)
  return {
    id: `${source}:${key}`,
    source,
    group,
    key,
    target: unsupported ? "unsupported" : target,
    current,
    incoming: toolRules ? toolRules.rules : incoming,
    warnings: [
      ...(options.warnings ?? []),
      ...(safetyWarning ? [safetyWarning] : []),
      ...(toolRules?.warnings ?? []),
    ],
    supported: unsupported ? false : (options.supported ?? true),
    shared: options.shared ?? false,
  }
}
