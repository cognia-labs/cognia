/**
 * CLI agent-mode support — parity with the desktop's custom-mode system.
 *
 * The desktop stores agent modes (built-in + user "custom" modes) in a Zustand
 * store and feeds the active one to `resolveSendOptions` as
 * `BuildOptionsContext.agentMode`. There, a mode's `systemPrompt` appends to the
 * prompt, its `tools` union into the allow-list, its `permissionMode` flows into
 * the SDK permission, and its model override joins the model precedence.
 *
 * The CLI has no Dexie/Zustand, so this module mirrors the same surface from the
 * filesystem + config:
 *   - Built-in modes come from the shared {@link BUILT_IN_AGENT_MODES} catalog
 *     (general / plan / build / code-gen / …) — identical ids to the desktop.
 *   - Custom modes are discovered from `.cognia/modes/*.json` under the cwd +
 *     home roots (mirrors `.cognia/agents/*.md` subagent discovery). The file's
 *     stem is the mode id; first root wins on a collision (project > global).
 *
 * The resolved {@link AgentModeConfig} is threaded into `toBuildContext` so the
 * SAME `resolveSendOptions` applies it — no CLI-specific option assembly.
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { BUILT_IN_AGENT_MODES } from "@/lib/agent/modes/built-ins"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

import { PERMISSION_MODES } from "./schema"

/** A concrete permission-mode value (mirrors `state/types.PermissionMode`). */
type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Minimal fs surface discovery needs (same shape as `discover-agents`). */
export interface ModeFs {
  exists(path: string): Promise<boolean>
  readDir(path: string): Promise<string[]>
  readText(path: string): Promise<string>
}

const defaultFs: ModeFs = {
  async exists(p) {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
  async readDir(p) {
    try {
      return await nodeFs.readdir(p)
    } catch {
      return []
    }
  },
  readText: (p) => nodeFs.readFile(p, "utf8"),
}

/**
 * A custom-mode JSON file. Intentionally a SUBSET of the desktop's
 * `CustomModeConfig` — only the fields `resolveSendOptions` actually consumes.
 * The `id` is the filename stem, so the file never carries one.
 */
export const customModeFileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    icon: z.string().min(1).optional(),
    /** Appended to the system prompt (under the same separator as skills). */
    systemPrompt: z.string().optional(),
    /** Tool names unioned into the allow-list for this mode. */
    tools: z.array(z.string().min(1)).optional(),
    /** SDK permission ruleset this mode enforces (e.g. `"plan"` ⇒ read-only). */
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    /** Model override — joins the model precedence above the app default. */
    model: z.string().min(1).optional(),
    outputFormat: z.enum(["text", "code", "html", "react", "markdown"]).optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
  })
  .strict()

export type CustomModeFile = z.infer<typeof customModeFileSchema>

const SUPPORTED_ENVELOPE_VERSIONS = new Set(["1.0", "1"])

/** GUI-only metadata fields ignored (with diagnostics) when loading in the CLI. */
const GUI_ONLY_MODE_KEYS = [
  "id",
  "type",
  "isBuiltIn",
  "createdAt",
  "updatedAt",
  "usageCount",
  "lastUsedAt",
  "isShared",
  "sharedBy",
  "source",
  "pluginId",
  "category",
  "tags",
  "previewEnabled",
  "customConfig",
  "a2uiEnabled",
  "a2uiTemplate",
  "mcpTools",
] as const

export interface ModeImportDiagnostic {
  file: string
  kind: "invalid" | "ignored_fields"
  message: string
  ignoredFields?: string[]
}

/**
 * Parse either a flat CLI `.cognia/modes/*.json` payload OR a GUI-exported
 * `{ version: "1.0", type: "custom-mode", mode: { ... } }` envelope into the
 * canonical {@link CustomModeFile}, reporting any GUI-only fields ignored by
 * the terminal runtime instead of silently dropping the entire file.
 */
export function parseInteroperableModeJson(
  rawJson: string
): { ok: true; file: CustomModeFile; ignoredFields: string[] } | { ok: false; error: string } {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawJson)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Malformed JSON" }
  }
  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    return { ok: false, error: "Expected a JSON object" }
  }

  const root = parsedJson as Record<string, unknown>
  let candidate: Record<string, unknown> = root
  const isGuiEnvelope = root.type === "custom-mode"
  if (isGuiEnvelope) {
    if (root.version !== undefined && !SUPPORTED_ENVELOPE_VERSIONS.has(String(root.version))) {
      return {
        ok: false,
        error: `Unsupported custom-mode schema version "${String(root.version)}"`,
      }
    }
    if (!root.mode || typeof root.mode !== "object" || Array.isArray(root.mode)) {
      return { ok: false, error: "GUI custom-mode envelope is missing a valid `mode` object" }
    }
    candidate = root.mode as Record<string, unknown>
  } else {
    if (root.version !== undefined && !SUPPORTED_ENVELOPE_VERSIONS.has(String(root.version))) {
      return { ok: false, error: `Unsupported mode schema version "${String(root.version)}"` }
    }
    // Flat files stay validated against strict `customModeFileSchema` unless
    // they came from a GUI `CustomModeConfig` object (`type: "custom"` or `*Override`).
    const looksLikeGuiRecord =
      root.type === "custom" ||
      "modelOverride" in root ||
      "temperatureOverride" in root ||
      "maxTokensOverride" in root ||
      "isBuiltIn" in root
    if (!looksLikeGuiRecord) {
      const strict = customModeFileSchema.safeParse(root)
      if (!strict.success) {
        return { ok: false, error: strict.error.issues[0]?.message ?? "Invalid mode schema" }
      }
      return { ok: true, file: strict.data, ignoredFields: [] }
    }
  }

  const ignoredFields: string[] = []
  const mapped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(candidate)) {
    if (value === undefined) continue
    if (key === "modelOverride") {
      if (typeof value === "string" && value.trim()) mapped.model ??= value.trim()
      continue
    }
    if (key === "temperatureOverride") {
      if (typeof value === "number") mapped.temperature ??= value
      continue
    }
    if (key === "maxTokensOverride") {
      if (typeof value === "number") mapped.maxTokens ??= value
      continue
    }
    if ((GUI_ONLY_MODE_KEYS as readonly string[]).includes(key)) {
      if (
        (key === "a2uiEnabled" && value === true) ||
        key === "a2uiTemplate" ||
        (key === "previewEnabled" && value === true) ||
        (key === "mcpTools" && Array.isArray(value) && value.length > 0)
      ) {
        ignoredFields.push(key)
      }
      continue
    }
    // Empty strings on GUI exports (`systemPrompt: ""`, `description: ""`) normalize cleanly.
    if (key === "model" && typeof value === "string" && !value.trim()) continue
    mapped[key] = value
  }

  const validated = customModeFileSchema.safeParse(mapped)
  if (!validated.success) {
    return { ok: false, error: validated.error.issues[0]?.message ?? "Invalid mode schema" }
  }
  return { ok: true, file: validated.data, ignoredFields }
}

/**
 * Build a resolved {@link AgentModeConfig} from a validated custom-mode file.
 * The `model` / `temperature` / `maxTokens` map onto the `*Override` fields
 * `buildAgentModeSessionUpdate` reads (`"modelOverride" in agentMode`), so the
 * shared session-update helper picks them up unchanged.
 */
export function customModeToConfig(id: string, file: CustomModeFile): AgentModeConfig {
  return {
    id,
    type: "custom",
    name: file.name,
    description: file.description ?? "",
    icon: file.icon ?? "Bot",
    ...(file.systemPrompt ? { systemPrompt: file.systemPrompt } : {}),
    ...(file.tools ? { tools: file.tools } : {}),
    ...(file.permissionMode ? { permissionMode: file.permissionMode } : {}),
    ...(file.outputFormat ? { outputFormat: file.outputFormat } : {}),
    // Override fields live on the desktop's CustomModeConfig; attach them so the
    // shared `buildAgentModeSessionUpdate` (which checks `"…Override" in mode`)
    // applies them. Cast because the public AgentModeConfig type omits them.
    ...(file.model ? { modelOverride: file.model } : {}),
    ...(file.temperature !== undefined ? { temperatureOverride: file.temperature } : {}),
    ...(file.maxTokens !== undefined ? { maxTokensOverride: file.maxTokens } : {}),
  } as AgentModeConfig
}

/**
 * Discover custom agent modes together with explicit diagnostics for invalid
 * files or ignored GUI-only fields (`a2uiTemplate`, `previewEnabled`, `mcpTools`).
 */
export async function discoverCustomAgentModesWithDiagnostics(
  roots: string[],
  fs: ModeFs = defaultFs
): Promise<{ modes: AgentModeConfig[]; diagnostics: ModeImportDiagnostic[] }> {
  const byId = new Map<string, AgentModeConfig>()
  const diagnostics: ModeImportDiagnostic[] = []
  for (const root of roots) {
    const dir = path.join(root, ".cognia", "modes")
    if (!(await fs.exists(dir))) continue
    const names = await fs.readDir(dir)
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const id = name.slice(0, -5)
      if (byId.has(id)) continue
      const filePath = path.join(dir, name)
      try {
        const raw = await fs.readText(filePath)
        const parsed = parseInteroperableModeJson(raw)
        if (!parsed.ok) {
          diagnostics.push({ file: filePath, kind: "invalid", message: parsed.error })
          continue
        }
        if (parsed.ignoredFields.length > 0) {
          diagnostics.push({
            file: filePath,
            kind: "ignored_fields",
            message: `Ignored GUI-only fields on CLI: ${parsed.ignoredFields.join(", ")}`,
            ignoredFields: parsed.ignoredFields,
          })
        }
        byId.set(id, customModeToConfig(id, parsed.file))
      } catch (err) {
        diagnostics.push({
          file: filePath,
          kind: "invalid",
          message: err instanceof Error ? err.message : "Unreadable file",
        })
      }
    }
  }
  return { modes: [...byId.values()], diagnostics }
}

/**
 * Discover custom agent modes from each root's `.cognia/modes/*.json`. First
 * root wins on an id collision (project overrides global). Unreadable / invalid
 * files are skipped (best-effort — a bad mode file never breaks chat); callers
 * needing explicit warnings use {@link discoverCustomAgentModesWithDiagnostics}.
 */
export async function discoverCustomAgentModes(
  roots: string[],
  fs: ModeFs = defaultFs
): Promise<AgentModeConfig[]> {
  const { modes } = await discoverCustomAgentModesWithDiagnostics(roots, fs)
  return modes
}

/**
 * The TUI and GUI intentionally share one built-in catalog. Keeping a filtered
 * terminal copy made the active mode differ depending on which surface opened
 * the same session and also caused valid persisted GUI selections to resolve to
 * plain chat in the TUI. Backend capability enforcement remains the tool
 * resolver's responsibility; mode discovery must not silently change identity.
 */
export const CLI_BUILTIN_AGENT_MODES: AgentModeConfig[] = BUILT_IN_AGENT_MODES

/** Every selectable mode: CLI built-ins first, then discovered custom modes. */
export function listAgentModes(customModes: AgentModeConfig[]): AgentModeConfig[] {
  return [...CLI_BUILTIN_AGENT_MODES, ...customModes]
}

/**
 * Resolve an active mode id to its config. CLI built-in ids win over custom ones
 * (a custom file can't shadow `plan`/`build`/…); returns `undefined` for an
 * unknown id or when no mode is selected — both degrade safely to plain chat.
 */
export function resolveAgentMode(
  modeId: string | undefined | null,
  customModes: AgentModeConfig[]
): AgentModeConfig | undefined {
  if (!modeId) return undefined
  return (
    CLI_BUILTIN_AGENT_MODES.find((m) => m.id === modeId) ?? customModes.find((m) => m.id === modeId)
  )
}

/**
 * Plan is a read-only constraint. Other modes inherit explicit user policy;
 * defaulted CLI autonomy yields to the selected mode's policy. The optional
 * provenance flag preserves compatibility for callers with manually built config.
 */
export function effectivePermissionMode(
  configPermissionMode: PermissionMode,
  mode: AgentModeConfig | undefined,
  explicitlyConfigured = configPermissionMode !== "default"
): PermissionMode {
  if (mode?.permissionMode === "plan") return "plan"
  if (explicitlyConfigured) return configPermissionMode
  return mode?.permissionMode ?? configPermissionMode
}
