import { isTauri } from "@/lib/tauri"
import { getPluginManager } from "@/lib/plugin/core/manager"
import type { PluginLifecycleCoordinatorSnapshot } from "@/lib/plugin/core/lifecycle-coordinator"
import { isDeveloperModeEnabled } from "@/lib/plugin/devtools/developer-mode"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { PluginStatus, PluginType } from "@/types/plugin"

const SUPPORTED_PLUGIN_TYPES = new Set<PluginType>([
  "frontend",
  "python",
  "hybrid",
  "wasm",
  "vscode-extension",
])

export type PluginDevReloadMode = "hot" | "restart-required" | "unsupported"
export interface PluginDevCapability {
  reloadMode: PluginDevReloadMode
  logMode: "structured" | "partial" | "unsupported"
  reasonCode?: string
  action?: string
}
export type PluginDevReloadOutcome = "activated" | "restart_required" | "failed"
export type PluginDevReloadStage = "install" | "discover" | "quiesce" | "activate" | "verify"

export interface PluginDevReloadPayload {
  schemaVersion: 1
  sessionId: string
  attempt: number
  pluginId: string
  packageVersion?: string
  artifactRevision: string
  activate: boolean
  phase?: "prepare" | "activate" | "rescan"
  pluginType?: PluginType
  transactionId?: string
}

export interface PluginActivationProof {
  previousGeneration: number
  generation: number
  actualState: "active"
  packageVersion: string
  artifactRevision: string
  reloadMode: "hot"
}

export interface PluginDevReloadError {
  code: string
  message: string
  action: string
  retriable: boolean
}

export interface PluginDevReloadResult {
  schemaVersion: 1
  ok: boolean
  outcome: PluginDevReloadOutcome
  stage: PluginDevReloadStage
  sessionId: string
  attempt: number
  pluginId: string
  pluginType?: PluginType
  activationProof?: PluginActivationProof
  error?: PluginDevReloadError
  runtimeQuiesced?: boolean
  quiescenceProof?: { previousGeneration: number; generation: number }
}

interface ReloadablePlugin {
  status: PluginStatus
  manifest: {
    id: string
    version: string
    type: PluginType
  }
}

interface PluginDevReloadManager {
  scanPlugins(): Promise<unknown>
  reloadPlugin(pluginId: string, reason?: string): Promise<void>
  enablePlugin(pluginId: string, reason?: string): Promise<void>
  disablePlugin(pluginId: string, reason?: string): Promise<void>
  unloadPlugin(pluginId: string): Promise<void>
  hasUnresolvedActivationResources(pluginId: string): boolean
  withPluginPackageMutation<T>(pluginId: string, operation: () => Promise<T>): Promise<T>
  getPluginLifecycleSnapshots(): PluginLifecycleCoordinatorSnapshot[]
}

export interface PluginDevReloadDependencies {
  isDesktop: () => boolean
  isDeveloperModeEnabled: () => boolean
  getPlugin: (pluginId: string) => ReloadablePlugin | undefined
  manager: PluginDevReloadManager | null
  sleep: (milliseconds: number) => Promise<void>
  timeoutMs: number
}

export function resolvePluginDevCapability(
  pluginType: PluginType,
  environment: { desktop: boolean; dirty: boolean }
): PluginDevCapability {
  if (!environment.desktop) {
    return {
      reloadMode: "unsupported",
      logMode: "unsupported",
      reasonCode: "desktop_required",
      action: "Open the project in Cognia Desktop",
    }
  }
  if (environment.dirty) {
    return {
      reloadMode: "restart-required",
      logMode: "structured",
      reasonCode: "runtime_dirty",
      action: "Restart Cognia before retrying the development session",
    }
  }
  if (SUPPORTED_PLUGIN_TYPES.has(pluginType)) {
    return { reloadMode: "hot", logMode: "structured" }
  }
  return {
    reloadMode: "unsupported",
    logMode: "unsupported",
    reasonCode: "unsupported_runtime",
    action: "Restart Cognia after installing this plugin",
  }
}

function productionDependencies(): PluginDevReloadDependencies {
  const desktop = isTauri()
  return {
    isDesktop: () => desktop,
    isDeveloperModeEnabled,
    getPlugin: (pluginId) => usePluginStore.getState().plugins[pluginId],
    manager: desktop ? getPluginManager() : null,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs: 20_000,
  }
}

function getSnapshot(
  manager: PluginDevReloadManager,
  pluginId: string
): PluginLifecycleCoordinatorSnapshot | undefined {
  return manager.getPluginLifecycleSnapshots().find((snapshot) => snapshot.pluginId === pluginId)
}

function resultError(
  payload: PluginDevReloadPayload,
  input: {
    outcome?: PluginDevReloadOutcome
    stage: PluginDevReloadStage
    pluginType?: PluginType
    code: string
    message: string
    action: string
    retriable: boolean
  }
): PluginDevReloadResult {
  return {
    schemaVersion: 1,
    ok: false,
    outcome: input.outcome ?? "failed",
    stage: input.stage,
    sessionId: payload.sessionId,
    attempt: payload.attempt,
    pluginId: payload.pluginId,
    ...(input.pluginType ? { pluginType: input.pluginType } : {}),
    error: {
      code: input.code,
      message: input.message,
      action: input.action,
      retriable: input.retriable,
    },
  }
}

async function waitForTerminalSnapshot(
  dependencies: PluginDevReloadDependencies,
  manager: PluginDevReloadManager,
  pluginId: string,
  previousGeneration: number
): Promise<PluginLifecycleCoordinatorSnapshot | undefined> {
  const startedAt = Date.now()
  while (true) {
    const snapshot = getSnapshot(manager, pluginId)
    if (
      snapshot &&
      ((snapshot.actual === "active" &&
        snapshot.generation > previousGeneration &&
        !snapshot.dirty &&
        !snapshot.pendingTransition) ||
        snapshot.actual === "dirty" ||
        snapshot.actual === "error")
    ) {
      return snapshot
    }
    if (Date.now() - startedAt >= dependencies.timeoutMs) return snapshot
    await dependencies.sleep(50)
  }
}

interface PreparedReload {
  payload: PluginDevReloadPayload
  previousGeneration: number
  generation: number
  shouldActivate: boolean
  release?: () => void
  fence?: Promise<void>
  cancelled?: boolean
  preparation: Promise<void>
  completePreparation: () => void
}

// A fence deliberately has no timer: after an ambiguous host timeout only an
// explicit rescan (after discard) or a desktop restart may release package I/O.
const preparedReloads = new WeakMap<PluginDevReloadManager, Map<string, PreparedReload>>()

function isQuiesced(
  deps: PluginDevReloadDependencies,
  manager: PluginDevReloadManager,
  id: string
) {
  const snapshot = getSnapshot(manager, id)
  const plugin = deps.getPlugin(id)
  return (
    !manager.hasUnresolvedActivationResources(id) &&
    (!snapshot
      ? !plugin
      : ["inactive", "error"].includes(snapshot.actual) &&
        !snapshot.dirty &&
        !snapshot.pendingTransition &&
        snapshot.effects.active === 0 &&
        snapshot.effects.pending === 0 &&
        snapshot.effects.failed === 0) &&
    (!plugin || ["installed", "disabled", "error"].includes(plugin.status))
  )
}

async function fencePackage(
  deps: PluginDevReloadDependencies,
  manager: PluginDevReloadManager,
  prepared: PreparedReload
) {
  const id = prepared.payload.pluginId
  await new Promise<void>((resolve, reject) => {
    prepared.fence = manager.withPluginPackageMutation(id, async () => {
      if (prepared.cancelled || !isQuiesced(deps, manager, id))
        throw new Error("Runtime teardown was not confirmed or reload was cancelled")
      prepared.generation = getSnapshot(manager, id)?.generation ?? 0
      await new Promise<void>((release) => {
        prepared.release = release
        resolve()
      })
    })
    void prepared.fence.catch(reject)
  })
}

async function releaseFence(prepared: PreparedReload) {
  prepared.release?.()
  await prepared.fence?.catch(() => undefined)
  prepared.release = undefined
  prepared.fence = undefined
}

function sameAttempt(prepared: PreparedReload, payload: PluginDevReloadPayload) {
  return (
    prepared.payload.sessionId === payload.sessionId &&
    prepared.payload.transactionId === payload.transactionId &&
    prepared.payload.attempt === payload.attempt &&
    prepared.payload.artifactRevision === payload.artifactRevision &&
    prepared.payload.packageVersion === payload.packageVersion &&
    prepared.payload.pluginType === payload.pluginType &&
    prepared.payload.activate === payload.activate
  )
}

export async function pluginDevReload(
  payload: PluginDevReloadPayload,
  dependencies: PluginDevReloadDependencies = productionDependencies()
): Promise<PluginDevReloadResult> {
  const manager = dependencies.manager
  if (!payload.phase || !manager) return reloadPhase(payload, dependencies)
  let pending = preparedReloads.get(manager)
  if (!pending) {
    pending = new Map()
    preparedReloads.set(manager, pending)
  }
  let prepared = pending.get(payload.pluginId)
  if (payload.phase === "rescan") {
    if (prepared && !sameAttempt(prepared, payload)) {
      return resultError(payload, {
        stage: "quiesce",
        code: "prepare_required",
        message: "Another reload owns the package fence",
        action: "Restart Cognia before retrying the development session",
        retriable: false,
      })
    }
    try {
      if (prepared) prepared.cancelled = true
      if (prepared) await prepared.preparation
      // Keep activation fenced until discovery reflects the restored tree.
      await manager.scanPlugins()
      if (prepared) await releaseFence(prepared)
      if (pending.get(payload.pluginId) === prepared) pending.delete(payload.pluginId)
      return {
        schemaVersion: 1,
        ok: true,
        outcome: "activated",
        stage: "discover",
        sessionId: payload.sessionId,
        attempt: payload.attempt,
        pluginId: payload.pluginId,
      }
    } catch (error) {
      return resultError(payload, {
        stage: "discover",
        code: "discovery_failed",
        message: String(error),
        action: "Restart Cognia to refresh plugin discovery",
        retriable: false,
      })
    }
  }
  if (payload.phase === "prepare") {
    if (prepared) {
      return resultError(payload, {
        stage: "quiesce",
        code: "prepare_required",
        message: "A reload is already awaiting activation or recovery",
        action: "Restart Cognia before retrying the development session",
        retriable: false,
      })
    }
    let completePreparation!: () => void
    const preparation = new Promise<void>((resolve) => {
      completePreparation = resolve
    })
    prepared = {
      payload,
      previousGeneration: 0,
      generation: 0,
      shouldActivate: false,
      preparation,
      completePreparation,
    }
    pending.set(payload.pluginId, prepared)
  } else if (!prepared || !prepared.release || !sameAttempt(prepared, payload)) {
    return resultError(payload, {
      stage: "quiesce",
      code: "prepare_required",
      message: "Activation has no matching prepared reload",
      action: "Restart Cognia before retrying the development session",
      retriable: false,
    })
  }

  const result = await reloadPhase(payload, dependencies, prepared)
  if (payload.phase === "prepare") {
    if (!result.ok) {
      await releaseFence(prepared!)
      if (!prepared!.cancelled && pending.get(payload.pluginId) === prepared)
        pending.delete(payload.pluginId)
    }
    prepared!.completePreparation()
    return result
  }
  if (result.ok) {
    pending.delete(payload.pluginId)
    return result
  }

  // A failed activation is rollback-safe only after awaited cleanup AND a
  // stopped-runtime check under the same fence used for commit.
  let clean = false
  try {
    if (!prepared!.release) {
      const plugin = dependencies.getPlugin(payload.pluginId)
      if (plugin?.status === "enabled" || plugin?.status === "suspended") {
        await manager.disablePlugin(payload.pluginId, "cli-dev-rollback")
      }
      await manager.unloadPlugin(payload.pluginId)
      await fencePackage(dependencies, manager, prepared!)
    }
    clean = isQuiesced(dependencies, manager, payload.pluginId)
  } catch {
    // Leave the host transaction unfinalized when teardown cannot be proven.
  }
  return {
    ...result,
    runtimeQuiesced: clean,
    ...(clean
      ? {
          quiescenceProof: {
            previousGeneration: prepared!.previousGeneration,
            generation: prepared!.generation,
          },
        }
      : {
          outcome: "restart_required" as const,
          error: {
            ...result.error!,
            action: "Restart Cognia before retrying the development session",
            retriable: false,
          },
        }),
  }
}

async function reloadPhase(
  payload: PluginDevReloadPayload,
  dependencies: PluginDevReloadDependencies,
  prepared?: PreparedReload
): Promise<PluginDevReloadResult> {
  if (!dependencies.isDesktop()) {
    return resultError(payload, {
      stage: "discover",
      code: "unsupported_runtime",
      message: "Plugin development reload requires the Cognia desktop runtime",
      action: "Open the project in Cognia Desktop",
      retriable: false,
    })
  }
  if (!dependencies.isDeveloperModeEnabled()) {
    return resultError(payload, {
      stage: "discover",
      code: "developer_mode_required",
      message: "Developer Mode is disabled",
      action: "Enable Developer Mode in Settings > Plugins",
      retriable: true,
    })
  }
  const manager = dependencies.manager
  if (!manager) {
    return resultError(payload, {
      stage: "discover",
      code: "runtime_manager_unavailable",
      message: "The desktop plugin runtime manager is not initialized",
      action: "Wait for Cognia to finish starting, then retry",
      retriable: true,
    })
  }

  const before = getSnapshot(manager, payload.pluginId)
  if (
    payload.phase === "activate" &&
    (!isQuiesced(dependencies, manager, payload.pluginId) ||
      (before?.generation ?? 0) !== prepared!.generation)
  ) {
    return resultError(payload, {
      outcome: "restart_required",
      stage: "quiesce",
      code: "runtime_generation_mismatch",
      message: "The runtime changed after reload preparation",
      action: "Restart Cognia before retrying the development session",
      retriable: false,
    })
  }
  if (before?.actual === "dirty" || before?.dirty) {
    const capability = resolvePluginDevCapability("frontend", { desktop: true, dirty: true })
    return resultError(payload, {
      outcome: "restart_required",
      stage: "quiesce",
      code: "runtime_dirty",
      message: before.dirty?.message ?? "The previous plugin runtime did not stop cleanly",
      action: capability.action ?? "Restart Cognia before retrying the development session",
      retriable: false,
    })
  }

  try {
    await manager.scanPlugins()
  } catch (error) {
    return resultError(payload, {
      stage: "discover",
      code: "discovery_failed",
      message: error instanceof Error ? error.message : String(error),
      action: "Inspect plugin discovery diagnostics and retry",
      retriable: true,
    })
  }
  const plugin = dependencies.getPlugin(payload.pluginId)
  if (!plugin && !(payload.phase === "prepare" && payload.pluginType)) {
    return resultError(payload, {
      stage: "discover",
      code: "plugin_not_found",
      message: `Installed plugin was not discovered: ${payload.pluginId}`,
      action: "Verify the bundle manifest and retry",
      retriable: true,
    })
  }
  const pluginType = plugin?.manifest.type ?? payload.pluginType!
  if (
    !SUPPORTED_PLUGIN_TYPES.has(pluginType) ||
    (payload.phase === "prepare" &&
      payload.pluginType &&
      !SUPPORTED_PLUGIN_TYPES.has(payload.pluginType))
  ) {
    const capability = resolvePluginDevCapability(pluginType, {
      desktop: true,
      dirty: false,
    })
    return resultError(payload, {
      stage: "discover",
      pluginType,
      code: "unsupported_runtime",
      message: `Unsupported plugin runtime: ${pluginType}`,
      action: capability.action ?? "Restart Cognia after installing this plugin",
      retriable: false,
    })
  }
  if (payload.phase === "prepare") {
    prepared!.previousGeneration = before?.generation ?? 0
    prepared!.shouldActivate =
      payload.activate || plugin?.status === "enabled" || plugin?.status === "suspended"
    if (!prepared!.shouldActivate) {
      return resultError(payload, {
        stage: "activate",
        code: "activation_not_requested",
        message: "The plugin is installed but activation was not requested",
        action: "Retry with activate=true",
        retriable: true,
      })
    }
    try {
      if (plugin?.status === "enabled" || plugin?.status === "suspended") {
        await manager.disablePlugin(payload.pluginId, "cli-dev")
      }
      await manager.unloadPlugin(payload.pluginId)
      await fencePackage(dependencies, manager, prepared!)
      return {
        schemaVersion: 1,
        ok: true,
        outcome: "activated",
        stage: "quiesce",
        sessionId: payload.sessionId,
        attempt: payload.attempt,
        pluginId: payload.pluginId,
        pluginType: payload.pluginType ?? pluginType,
        runtimeQuiesced: true,
        quiescenceProof: {
          previousGeneration: prepared!.previousGeneration,
          generation: prepared!.generation,
        },
      }
    } catch (error) {
      return resultError(payload, {
        outcome: "restart_required",
        stage: "quiesce",
        code: "runtime_dirty",
        message: error instanceof Error ? error.message : String(error),
        action: "Restart Cognia before retrying the development session",
        retriable: false,
      })
    }
  }
  // Prepare permits a first install; activation and the legacy path require discovery.
  if (!plugin) {
    return resultError(payload, {
      stage: "discover",
      code: "plugin_not_found",
      message: `Installed plugin was not discovered: ${payload.pluginId}`,
      action: "Verify the bundle manifest and retry",
      retriable: true,
    })
  }
  if (payload.packageVersion && plugin.manifest.version !== payload.packageVersion) {
    return resultError(payload, {
      stage: "discover",
      pluginType: plugin.manifest.type,
      code: "plugin_version_mismatch",
      message: `Expected plugin version ${payload.packageVersion}, discovered ${plugin.manifest.version}`,
      action: "Rebuild the plugin bundle and retry",
      retriable: true,
    })
  }

  const previousGeneration = prepared?.previousGeneration ?? before?.generation ?? 0
  try {
    if (payload.phase === "activate") {
      await releaseFence(prepared!)
      await manager.enablePlugin(payload.pluginId, "cli-dev")
    } else if (plugin.status === "enabled" || plugin.status === "suspended") {
      await manager.reloadPlugin(payload.pluginId, "cli-dev")
    } else if (payload.activate) {
      await manager.enablePlugin(payload.pluginId, "cli-dev")
    } else {
      return resultError(payload, {
        stage: "activate",
        pluginType: plugin.manifest.type,
        code: "activation_not_requested",
        message: "The plugin is installed but activation was not requested",
        action: "Retry with activate=true",
        retriable: true,
      })
    }
  } catch (error) {
    const snapshot = getSnapshot(manager, payload.pluginId)
    if (snapshot?.actual === "dirty" || snapshot?.dirty) {
      return resultError(payload, {
        outcome: "restart_required",
        stage: "quiesce",
        pluginType: plugin.manifest.type,
        code: "runtime_dirty",
        message: snapshot.dirty?.message ?? String(error),
        action: "Restart Cognia before retrying the development session",
        retriable: false,
      })
    }
    return resultError(payload, {
      stage: "activate",
      pluginType: plugin.manifest.type,
      code: "activation_failed",
      message: error instanceof Error ? error.message : String(error),
      action: "Inspect the runtime diagnostics and retry after fixing the plugin",
      retriable: true,
    })
  }

  const after = await waitForTerminalSnapshot(
    dependencies,
    manager,
    payload.pluginId,
    previousGeneration
  )
  if (
    !after ||
    after.actual !== "active" ||
    after.generation <= previousGeneration ||
    after.dirty ||
    after.pendingTransition
  ) {
    const failed = after?.actual === "error"
    return resultError(payload, {
      stage: "verify",
      pluginType: plugin.manifest.type,
      code: failed ? "activation_failed" : "activation_timeout",
      message: failed
        ? (after.lastError ?? "Plugin activation failed")
        : "Plugin runtime did not produce a new active lifecycle generation",
      action: failed
        ? "Inspect the runtime diagnostics and retry after fixing the plugin"
        : "Retry the reload or restart Cognia if the runtime remains stuck",
      retriable: true,
    })
  }

  return {
    schemaVersion: 1,
    ok: true,
    outcome: "activated",
    stage: "verify",
    sessionId: payload.sessionId,
    attempt: payload.attempt,
    pluginId: payload.pluginId,
    pluginType: plugin.manifest.type,
    activationProof: {
      previousGeneration,
      generation: after.generation,
      actualState: "active",
      packageVersion: plugin.manifest.version,
      artifactRevision: payload.artifactRevision,
      reloadMode: "hot",
    },
  }
}
