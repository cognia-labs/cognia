import type { StoreApi } from "zustand"
import { nanoid } from "nanoid"
import { loggers } from "@cognia/logging"
import { type CustomModeConfig } from "../definitions"
import { analyzeModeDescription } from "../helpers"
import { initialState } from "../initial-state"
import type { CustomModeState } from "../types"

const customModeLogger = loggers.agent.child("custom-mode-store")
const SUPPORTED_MODE_SCHEMA_VERSIONS = new Set(["1.0", "1"])
const VALID_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
])
type AgentModePermission = NonNullable<CustomModeConfig["permissionMode"]>
const VALID_OUTPUT_FORMATS: ReadonlySet<string> = new Set([
  "text",
  "code",
  "html",
  "react",
  "markdown",
])

/**
 * Normalize either a GUI `{ version, type: "custom-mode", mode }` envelope or a
 * flat CLI `.cognia/modes/*.json` payload (`model` / `temperature` / `maxTokens`)
 * into `Partial<CustomModeConfig>`. Rejects unknown envelope versions or missing
 * `name` so incompatible records fail closed instead of silently misimporting.
 */
function normalizeImportedModeRecord(raw: unknown): Partial<CustomModeConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid custom mode payload: expected an object")
  }
  const obj = raw as Record<string, unknown>
  let source: Record<string, unknown>
  if ("type" in obj && obj.type === "custom-mode") {
    if (obj.version !== undefined && !SUPPORTED_MODE_SCHEMA_VERSIONS.has(String(obj.version))) {
      throw new Error(`Unsupported custom mode schema version: ${String(obj.version)}`)
    }
    if (!obj.mode || typeof obj.mode !== "object" || Array.isArray(obj.mode)) {
      throw new Error("Invalid mode export format")
    }
    source = obj.mode as Record<string, unknown>
  } else if ("type" in obj && obj.type !== "custom") {
    throw new Error("Invalid mode export format")
  } else {
    if (obj.version !== undefined && !SUPPORTED_MODE_SCHEMA_VERSIONS.has(String(obj.version))) {
      throw new Error(`Unsupported custom mode schema version: ${String(obj.version)}`)
    }
    source = obj
  }

  if (typeof source.name !== "string" || source.name.trim().length === 0) {
    throw new Error("Invalid mode export format: name is required")
  }
  if (
    source.permissionMode !== undefined &&
    (typeof source.permissionMode !== "string" ||
      !VALID_PERMISSION_MODES.has(source.permissionMode))
  ) {
    throw new Error(`Invalid permissionMode: ${String(source.permissionMode)}`)
  }
  if (
    source.outputFormat !== undefined &&
    (typeof source.outputFormat !== "string" || !VALID_OUTPUT_FORMATS.has(source.outputFormat))
  ) {
    throw new Error(`Invalid outputFormat: ${String(source.outputFormat)}`)
  }

  const modelOverride =
    typeof source.modelOverride === "string" && source.modelOverride.trim()
      ? source.modelOverride.trim()
      : typeof source.model === "string" && source.model.trim()
        ? source.model.trim()
        : undefined
  const temperatureOverride =
    typeof source.temperatureOverride === "number"
      ? source.temperatureOverride
      : typeof source.temperature === "number"
        ? source.temperature
        : undefined
  const maxTokensOverride =
    typeof source.maxTokensOverride === "number"
      ? source.maxTokensOverride
      : typeof source.maxTokens === "number"
        ? source.maxTokens
        : undefined

  return {
    ...(source as Partial<CustomModeConfig>),
    name: source.name.trim(),
    ...(source.permissionMode
      ? { permissionMode: source.permissionMode as AgentModePermission }
      : {}),
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(temperatureOverride !== undefined ? { temperatureOverride } : {}),
    ...(maxTokensOverride !== undefined ? { maxTokensOverride } : {}),
  }
}

type CustomModeStoreSet = StoreApi<CustomModeState>["setState"]
type CustomModeStoreGet = StoreApi<CustomModeState>["getState"]

type CustomModeActions = Omit<CustomModeState, keyof typeof initialState>

export const createCustomModeActionsSlice = (
  set: CustomModeStoreSet,
  get: CustomModeStoreGet
): CustomModeActions => ({
  // =====================================================================
  // CRUD Actions
  // =====================================================================

  createMode: (mode) => {
    const id = mode.id || `custom-${nanoid()}`
    const now = new Date()

    const newMode: CustomModeConfig = {
      id,
      type: "custom",
      isBuiltIn: false,
      name: mode.name || "New Custom Mode",
      description: mode.description || "",
      icon: mode.icon || "Bot",
      systemPrompt: mode.systemPrompt || "",
      tools: mode.tools || [],
      ...(mode.permissionMode !== undefined ? { permissionMode: mode.permissionMode } : {}),
      outputFormat: mode.outputFormat || "text",
      previewEnabled: mode.previewEnabled ?? false,
      customConfig: mode.customConfig || {},
      a2uiEnabled: mode.a2uiEnabled ?? false,
      a2uiTemplate: mode.a2uiTemplate,
      modelOverride: mode.modelOverride,
      temperatureOverride: mode.temperatureOverride,
      maxTokensOverride: mode.maxTokensOverride,
      mcpTools: mode.mcpTools || [],
      category: mode.category || "other",
      tags: mode.tags || [],
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
      // Origin tagging — populated only when callers (the plugin manager)
      // pass them explicitly, so existing user-created modes keep the
      // serialized shape they had pre-port.
      ...(mode.source !== undefined ? { source: mode.source } : {}),
      ...(mode.pluginId !== undefined ? { pluginId: mode.pluginId } : {}),
    }

    set((state) => ({
      customModes: { ...state.customModes, [id]: newMode },
    }))

    return newMode
  },

  updateMode: (id, updates) => {
    set((state) => {
      const mode = state.customModes[id]
      if (!mode) return state

      return {
        customModes: {
          ...state.customModes,
          [id]: {
            ...mode,
            ...updates,
            updatedAt: new Date(),
          },
        },
      }
    })
  },

  deleteMode: (id) => {
    set((state) => {
      const { [id]: _removed, ...rest } = state.customModes
      return {
        customModes: rest,
        activeModeId: state.activeModeId === id ? null : state.activeModeId,
      }
    })
  },

  duplicateMode: (id) => {
    const mode = get().customModes[id]
    if (!mode) return null

    const duplicated = get().createMode({
      ...mode,
      id: undefined, // Generate new ID
      name: `${mode.name} (Copy)`,
      usageCount: 0,
      lastUsedAt: undefined,
    })

    return duplicated
  },

  // =====================================================================
  // Selection Actions
  // =====================================================================

  setActiveMode: (id) => {
    set({ activeModeId: id })
  },

  // =====================================================================
  // Query Actions
  // =====================================================================

  getMode: (id) => {
    return get().customModes[id]
  },

  getModesByCategory: (category) => {
    return Object.values(get().customModes).filter((mode) => mode.category === category)
  },

  getModesByTags: (tags) => {
    return Object.values(get().customModes).filter((mode) =>
      tags.some((tag) => mode.tags?.includes(tag))
    )
  },

  searchModes: (query) => {
    const lowerQuery = query.toLowerCase()
    return Object.values(get().customModes).filter(
      (mode) =>
        mode.name.toLowerCase().includes(lowerQuery) ||
        mode.description.toLowerCase().includes(lowerQuery) ||
        mode.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery))
    )
  },

  getRecentModes: (limit = 5) => {
    return Object.values(get().customModes)
      .filter((mode) => mode.lastUsedAt)
      .sort((a, b) => {
        const aTime = a.lastUsedAt?.getTime() || 0
        const bTime = b.lastUsedAt?.getTime() || 0
        return bTime - aTime
      })
      .slice(0, limit)
  },

  getMostUsedModes: (limit = 5) => {
    return Object.values(get().customModes)
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
      .slice(0, limit)
  },

  // =====================================================================
  // Usage Tracking
  // =====================================================================

  recordModeUsage: (id) => {
    set((state) => {
      const mode = state.customModes[id]
      if (!mode) return state

      return {
        customModes: {
          ...state.customModes,
          [id]: {
            ...mode,
            usageCount: (mode.usageCount || 0) + 1,
            lastUsedAt: new Date(),
          },
        },
      }
    })
  },

  // =====================================================================
  // A2UI Templates
  // =====================================================================

  setModeA2UITemplate: (id, template) => {
    set((state) => {
      const mode = state.customModes[id]
      if (!mode) return state

      return {
        customModes: {
          ...state.customModes,
          [id]: {
            ...mode,
            a2uiTemplate: template,
            a2uiEnabled: !!template,
            updatedAt: new Date(),
          },
        },
      }
    })
  },

  // =====================================================================
  // Import/Export
  // =====================================================================

  exportMode: (id) => {
    const mode = get().customModes[id]
    if (!mode) return null

    const exportData = {
      version: "1.0",
      type: "custom-mode",
      mode: {
        ...mode,
        // Emit CLI-compatible flat aliases alongside GUI `*Override` fields so
        // both desktop and CLI consumers read the exact same effective settings.
        ...(mode.modelOverride ? { model: mode.modelOverride } : {}),
        ...(mode.temperatureOverride !== undefined
          ? { temperature: mode.temperatureOverride }
          : {}),
        ...(mode.maxTokensOverride !== undefined ? { maxTokens: mode.maxTokensOverride } : {}),
        // Reset usage stats for export
        usageCount: 0,
        lastUsedAt: undefined,
      },
    }

    return JSON.stringify(exportData, null, 2)
  },

  importMode: (json) => {
    try {
      const data = JSON.parse(json)
      const normalized = normalizeImportedModeRecord(data)

      const imported = get().createMode({
        ...normalized,
        id: undefined, // Generate new ID
        isShared: true,
        sharedBy: normalized.name,
      })

      return imported
    } catch (error) {
      customModeLogger.warn("Failed to import custom mode JSON", { error })
      return null
    }
  },

  exportAllModes: () => {
    const modes = Object.values(get().customModes).map((mode) => ({
      ...mode,
      ...(mode.modelOverride ? { model: mode.modelOverride } : {}),
      ...(mode.temperatureOverride !== undefined ? { temperature: mode.temperatureOverride } : {}),
      ...(mode.maxTokensOverride !== undefined ? { maxTokens: mode.maxTokensOverride } : {}),
      usageCount: 0,
      lastUsedAt: undefined,
    }))

    const exportData = {
      version: "1.0",
      type: "custom-modes-collection",
      modes,
      exportedAt: new Date().toISOString(),
    }

    return JSON.stringify(exportData, null, 2)
  },

  importModes: (json) => {
    try {
      const data = JSON.parse(json)
      if (!data || typeof data !== "object") {
        throw new Error("Invalid modes collection format")
      }
      if (
        "version" in data &&
        data.version !== undefined &&
        !SUPPORTED_MODE_SCHEMA_VERSIONS.has(String(data.version))
      ) {
        throw new Error(`Unsupported custom modes collection version: ${String(data.version)}`)
      }
      const rawModes =
        data.type === "custom-modes-collection" && Array.isArray(data.modes)
          ? data.modes
          : data.type === "custom-mode" && data.mode
            ? [data.mode]
            : null
      if (!rawModes) {
        throw new Error("Invalid modes collection format")
      }

      let imported = 0
      for (const rawMode of rawModes) {
        const normalized = normalizeImportedModeRecord(rawMode)
        get().createMode({
          ...normalized,
          id: undefined,
          isShared: true,
        })
        imported++
      }

      return imported
    } catch (error) {
      customModeLogger.warn("Failed to import custom modes collection JSON", { error })
      return 0
    }
  },

  // =====================================================================
  // Mode Generation from Natural Language
  // =====================================================================

  generateModeFromDescription: async (request) => {
    set({ isGenerating: true, generationError: null })

    try {
      // Analyze description for patterns
      const result = analyzeModeDescription(request)

      set({ isGenerating: false })
      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Generation failed"
      customModeLogger.error("Custom mode generation failed", { error })
      set({ isGenerating: false, generationError: errorMessage })
      throw error
    }
  },

  setGenerationError: (error) => {
    set({ generationError: error })
  },

  // =====================================================================
  // Reset
  // =====================================================================

  reset: () => {
    set(initialState)
  },
})
