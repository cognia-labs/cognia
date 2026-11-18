/**
 * Plugin Rollback System
 *
 * Moves a plugin back to an earlier package (a backup or a registry release)
 * and, when that crosses a data migration, back to the data snapshot taken
 * before it (ADR-0258).
 */

import { getPluginBackupManager, type PluginBackup } from "./backup"
import { usePluginStore } from "@/stores/plugin-runtime"
import { getPluginMarketplace } from "../package/marketplace"
import { getPluginManager } from "../core/manager"
import type { PluginGraphReservation } from "../core/lifecycle-coordinator"
import { getInstallOrigin } from "@/lib/db/plugin-install-origins"
import { recordInstallOrigin } from "../origin/install-origin"
import { getDb } from "@/lib/db/schema"
import { restorePluginDataSnapshot } from "../dexie/bridge"
import {
  describePluginDataRollback,
  PluginDataRestoreUnconfirmedError,
  type PluginDataRollback,
} from "../dexie/data-rollback"
import { PluginDataVersionError } from "../dexie/migration-runner"
import {
  quiesceRuntime,
  restoreRuntimeState,
  runtimeResumeStateOf,
  type RuntimeResumeState,
} from "./runtime-state"
import type { PluginInstallOriginRecord } from "@/types/plugin/plugin-cogset"

// =============================================================================
// Types
// =============================================================================

export interface RollbackInfo {
  pluginId: string
  currentVersion: string
  availableVersions: VersionInfo[]
  hasBackups: boolean
  lastBackup?: PluginBackup
}

export interface VersionInfo {
  version: string
  source: "backup" | "marketplace" | "local"
  date?: Date
  size?: number
  canRollback: boolean
  reason?: string
  /** What rolling back to this version does to the plugin's data. */
  data: PluginDataRollback
}

export interface RollbackResult {
  success: boolean
  pluginId: string
  fromVersion: string
  toVersion: string
  duration: number
  error?: string
  /** The plugin's data was put back to the snapshot taken before a migration. */
  dataRestored: boolean
  requiresRestart: boolean
  rollback?: { attempted: boolean; succeeded: boolean; error?: string }
}

export interface RollbackOptions {
  /** Restore this exact backup rather than the newest one of the version. */
  backupId?: string
  /**
   * The data snapshot the user agreed to restore, discarding what the plugin
   * saved since. Required when the rollback crosses a data migration.
   */
  confirmedDataSnapshot?: string
}

export interface RollbackConfig {
  createBackupBeforeRollback: boolean
  verifyAfterRollback: boolean
}

const pluginDb = () => getDb()

// =============================================================================
// Plugin Rollback Manager
// =============================================================================

export interface RollbackDeps {
  readOrigin?: (pluginId: string) => Promise<PluginInstallOriginRecord | undefined>
  recordOrigin?: typeof recordInstallOrigin
}

export class PluginRollbackManager {
  private config: RollbackConfig
  private readOrigin: NonNullable<RollbackDeps["readOrigin"]>
  private recordOrigin: typeof recordInstallOrigin

  constructor(config: Partial<RollbackConfig> = {}, deps: RollbackDeps = {}) {
    this.readOrigin = deps.readOrigin ?? getInstallOrigin
    this.recordOrigin = deps.recordOrigin ?? recordInstallOrigin
    this.config = {
      createBackupBeforeRollback: true,
      verifyAfterRollback: true,
      ...config,
    }
  }

  // ===========================================================================
  // Rollback Information
  // ===========================================================================

  async getRollbackInfo(pluginId: string): Promise<RollbackInfo> {
    const backupManager = getPluginBackupManager()
    const backups = backupManager.getBackups(pluginId)

    // Get current version
    const currentVersion = this.getPluginVersion(pluginId) || "unknown"

    // Get available versions
    const availableVersions: VersionInfo[] = []

    // Add versions from backups
    const seenVersions = new Set<string>()
    for (const backup of backups) {
      if (!seenVersions.has(backup.version)) {
        seenVersions.add(backup.version)
        availableVersions.push({
          version: backup.version,
          source: "backup",
          date: backup.createdAt,
          size: backup.size,
          canRollback:
            backup.version !== currentVersion || backup.metadata?.hostStateRestorePending === true,
          data: { kind: "none" },
        })
      }
    }

    // Try to get versions from marketplace
    try {
      const versions = await getPluginMarketplace().getVersions(pluginId)

      for (const v of versions) {
        if (!seenVersions.has(v.version)) {
          seenVersions.add(v.version)
          availableVersions.push({
            version: v.version,
            source: "marketplace",
            date: v.publishedAt,
            canRollback: v.version !== currentVersion,
            data: { kind: "none" },
          })
        }
      }
    } catch {
      // Marketplace not available
    }

    // Sort by version (newest first)
    availableVersions.sort((a, b) => this.compareVersions(b.version, a.version))

    // A version that cannot read the data, with no snapshot to bring it
    // back, is listed but not offered.
    for (const version of availableVersions) {
      version.data = await describePluginDataRollback(pluginDb, pluginId, version.version)
      if (version.data.kind === "unavailable") version.canRollback = false
    }

    return {
      pluginId,
      currentVersion,
      availableVersions,
      hasBackups: backups.length > 0,
      lastBackup: backups[0],
    }
  }

  // ===========================================================================
  // Rollback Execution
  // ===========================================================================

  /** Restore the selected snapshot, including multiple backups of one version. */
  async restoreBackup(
    backupId: string,
    options: Omit<RollbackOptions, "backupId"> = {}
  ): Promise<RollbackResult> {
    const backup = getPluginBackupManager().getBackup(backupId)
    if (!backup) {
      return {
        success: false,
        pluginId: "",
        fromVersion: "",
        toVersion: "",
        duration: 0,
        error: "Backup not found",
        dataRestored: false,
        requiresRestart: false,
      }
    }
    return this.rollback(backup.pluginId, backup.version, { ...options, backupId })
  }

  async rollback(
    pluginId: string,
    targetVersion: string,
    options: RollbackOptions = {}
  ): Promise<RollbackResult> {
    const { backupId } = options
    const startTime = Date.now()
    const info = await this.getRollbackInfo(pluginId)
    const fromVersion = info.currentVersion
    let initialStatus = usePluginStore.getState().plugins[pluginId]?.status
    const lifecycle = getPluginManager()
    let reservation: PluginGraphReservation | undefined
    let dataRestored = false
    let pendingRestore = false
    // Compensation state: what to put back if a step after teardown fails.
    let safetyBackupId: string | undefined
    let resumeState: RuntimeResumeState = "stopped"
    let quiesced = false
    let packageMutated = false
    let originBefore: PluginInstallOriginRecord | undefined

    try {
      // A rollback past a data migration needs the snapshot taken before it,
      // and the user's agreement to lose what the plugin saved since. Both
      // are checked before anything is touched.
      const data = await describePluginDataRollback(pluginDb, pluginId, targetVersion)
      if (data.kind === "unavailable") {
        throw new PluginDataVersionError(pluginId, data.targetDataVersion, data.currentDataVersion)
      }
      if (data.kind === "restore" && options.confirmedDataSnapshot !== data.snapshotId) {
        throw new PluginDataRestoreUnconfirmedError(pluginId, data.snapshotId)
      }

      // Step 1: Create backup if configured
      if (this.config.createBackupBeforeRollback) {
        const backupManager = getPluginBackupManager()
        const backupResult = await backupManager.createBackup(pluginId, {
          reason: "pre-update",
          metadata: { rollbackTo: targetVersion },
          ...(backupId ? { preserveBackupId: backupId } : {}),
        })

        if (!backupResult.success) {
          throw new Error(`Failed to create backup: ${backupResult.error}`)
        }
        // The safety snapshot a failure after the package changed restores.
        safetyBackupId = backupResult.backup?.id
      }
      originBefore = await this.readOrigin(pluginId).catch(() => undefined)

      // The TS manager owns frontend modules, contributions and graph leases.
      // Native status changes alone leave the old UI and commands alive.
      reservation = lifecycle.reservePluginRuntimeGraph(pluginId)
      initialStatus = usePluginStore.getState().plugins[pluginId]?.status
      resumeState = runtimeResumeStateOf(initialStatus)
      quiesced = true
      await quiesceRuntime(lifecycle, pluginId, resumeState, "rollback")
      // A disabled plugin is still loaded; nothing runs, but its module goes.
      if (resumeState === "stopped") await lifecycle.unloadPlugin(pluginId)

      // Step 3: Restore target version
      const versionInfo = backupId
        ? { source: "backup" as const }
        : info.availableVersions.find((v) => v.version === targetVersion)

      const assertStopped = async () => {
        const state = await lifecycle.getPluginLifecycleState(pluginId, {
          ignorePendingUpdateRestore: versionInfo?.source === "backup",
        })
        if (
          lifecycle.hasUnresolvedActivationResources(pluginId) ||
          ["active", "activating", "stopping", "dirty"].includes(state.actual) ||
          ["loading", "loaded", "enabling", "enabled", "disabling", "suspended"].includes(
            usePluginStore.getState().plugins[pluginId]?.status ?? ""
          )
        ) {
          pendingRestore = true
          throw new Error(
            `Pending restore of ${pluginId} to ${targetVersion}; a restart is required, then retry rollback after cleanup`
          )
        }
      }
      if (versionInfo?.source === "backup") {
        await lifecycle.withPluginPackageMutation(pluginId, async () => {
          await assertStopped()
          packageMutated = true
          // Restore from backup
          const backupManager = getPluginBackupManager()
          const restoreResult = backupId
            ? await backupManager.restore(backupId, lifecycle)
            : await backupManager.restoreToVersion(pluginId, targetVersion, lifecycle)
          pendingRestore ||= restoreResult.requiresRestart
          if (!restoreResult.success) {
            throw new Error(`Restore failed: ${restoreResult.error}`)
          }
        })
      } else {
        await assertStopped()
        // Download and install from marketplace. A failed install rolls its
        // own transaction back, so the package only counts as changed once it
        // reports success.
        const installResult = await getPluginMarketplace().installPlugin(pluginId, targetVersion)
        if (!installResult.success) {
          throw new Error(installResult.error || "Marketplace install failed")
        }
        packageMutated = true
      }

      await this.refreshRuntimePlugins()
      if (!(await this.verifyRollback(pluginId, targetVersion))) {
        throw new Error("Rollback restored an unexpected plugin version")
      }

      // Step 4: Put the data back where the restored package can read it,
      // before anything activates it.
      if (data.kind === "restore") {
        await restorePluginDataSnapshot(pluginDb, pluginId, data.snapshotId)
        dataRestored = true
      }

      // Restore the pre-rollback activation state through the same owner as a
      // normal enable. A disabled package must not acquire running code.
      await restoreRuntimeState(lifecycle, pluginId, resumeState, "rollback")
      if (initialStatus === "disabled") this.markDisabled(pluginId)

      // Step 6: Verify
      if (this.config.verifyAfterRollback) {
        const verified = await this.verifyRollback(pluginId, targetVersion)
        if (!verified) {
          throw new Error("Rollback verification failed")
        }
      }

      if (backupId && this.config.createBackupBeforeRollback) {
        await getPluginBackupManager().cleanupOldBackups(pluginId)
      }
      // A marketplace install recorded its own registry origin. A restored
      // snapshot has nothing to fetch again; say so rather than leave the
      // origin of the version it replaced (ADR-0209).
      if (versionInfo?.source === "backup") {
        await this.recordOrigin({
          pluginId,
          version: targetVersion,
          origin: { kind: "local", via: "restored" },
        })
      }

      const result: RollbackResult = {
        success: true,
        pluginId,
        fromVersion,
        toVersion: targetVersion,
        duration: Date.now() - startTime,
        dataRestored,
        requiresRestart: pendingRestore || (await this.checkRequiresRestart(pluginId)),
      }
      return result
    } catch (error) {
      pendingRestore ||=
        lifecycle.hasUnresolvedActivationResources(pluginId) ||
        (error instanceof Error && error.name === "PluginActivationConflictError")
      const cause = error instanceof Error ? error.message : String(error)
      // The newer package may come back below, but the data stays restored:
      // the user agreed to discard it, and that package migrates it again.
      const message = dataRestored
        ? `${cause}; the plugin's data was already restored from its snapshot`
        : cause
      const errorMessage = pendingRestore
        ? `Pending restore of ${pluginId} to ${targetVersion}; a restart is required, then retry rollback after cleanup: ${message}`
        : message
      let compensation: RollbackResult["rollback"] = pendingRestore
        ? { attempted: true, succeeded: false, error: errorMessage }
        : undefined
      if (!pendingRestore && quiesced) {
        const outcome = await this.compensate({
          pluginId,
          fromVersion,
          resumeState,
          initialStatus,
          packageMutated,
          safetyBackupId,
          originBefore,
        })
        compensation = outcome.rollback
        pendingRestore = outcome.requiresRestart
      }
      const result: RollbackResult = {
        success: false,
        pluginId,
        fromVersion,
        toVersion: targetVersion,
        duration: Date.now() - startTime,
        error: errorMessage,
        dataRestored,
        requiresRestart: pendingRestore,
        ...(compensation ? { rollback: compensation } : {}),
      }
      return result
    } finally {
      if (reservation) lifecycle.releasePluginRuntimeGraph(reservation)
    }
  }

  /**
   * Put the plugin back the way the failed rollback found it.
   *
   * Before the package changed, the plugin that was running is still on disk,
   * so its runtime state is restored as an update does. After it changed, the
   * safety snapshot taken in step 1 restores the package (and the origin a
   * marketplace install re-recorded); the
   * restored package stays inactive and asks for a restart instead of
   * resurrecting the runtime, as a failed update does.
   */
  private async compensate(input: {
    pluginId: string
    fromVersion: string
    resumeState: RuntimeResumeState
    initialStatus: string | undefined
    packageMutated: boolean
    safetyBackupId: string | undefined
    originBefore: PluginInstallOriginRecord | undefined
  }): Promise<{ rollback: NonNullable<RollbackResult["rollback"]>; requiresRestart: boolean }> {
    const { pluginId, resumeState } = input
    const lifecycle = getPluginManager()
    const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

    if (!input.packageMutated) {
      try {
        await restoreRuntimeState(lifecycle, pluginId, resumeState, "rollback-restore")
        if (input.initialStatus === "disabled") this.markDisabled(pluginId)
        return { rollback: { attempted: true, succeeded: true }, requiresRestart: false }
      } catch (error) {
        return {
          rollback: {
            attempted: true,
            succeeded: false,
            error: `restore previous runtime: ${describe(error)}`,
          },
          requiresRestart: true,
        }
      }
    }

    if (!input.safetyBackupId) {
      return {
        rollback: {
          attempted: false,
          succeeded: false,
          error: `no safety snapshot of ${pluginId}@${input.fromVersion} to restore`,
        },
        requiresRestart: true,
      }
    }

    const failures: string[] = []
    try {
      const live = runtimeResumeStateOf(usePluginStore.getState().plugins[pluginId]?.status)
      await quiesceRuntime(lifecycle, pluginId, live, "rollback-compensate")
      const restored = await lifecycle.withPluginPackageMutation(pluginId, () =>
        getPluginBackupManager().restore(input.safetyBackupId!, lifecycle)
      )
      if (!restored.success) {
        failures.push(`restore safety snapshot: ${restored.error ?? "unknown error"}`)
      } else {
        await this.refreshRuntimePlugins()
        if (!(await this.verifyRollback(pluginId, input.fromVersion))) {
          failures.push(`safety snapshot did not restore ${pluginId}@${input.fromVersion}`)
        }
      }
    } catch (error) {
      failures.push(`restore safety snapshot: ${describe(error)}`)
    }
    if (failures.length === 0) {
      await this.recordOrigin(
        input.originBefore && input.originBefore.version === input.fromVersion
          ? {
              pluginId,
              version: input.originBefore.version,
              origin: input.originBefore.origin,
              ...(input.originBefore.viaCogpack
                ? { viaCogpack: input.originBefore.viaCogpack }
                : {}),
            }
          : { pluginId, version: input.fromVersion, origin: { kind: "local", via: "restored" } }
      )
      if (input.initialStatus === "disabled") this.markDisabled(pluginId)
    }
    return {
      rollback: {
        attempted: true,
        succeeded: failures.length === 0,
        ...(failures.length > 0 ? { error: failures.join("; ") } : {}),
      },
      // The restored package is left inactive; anything that was running
      // comes back on a restart, never from the torn-down object graph.
      requiresRestart: failures.length > 0 || resumeState !== "stopped",
    }
  }

  private markDisabled(pluginId: string): void {
    usePluginStore.setState((state) => ({
      plugins: {
        ...state.plugins,
        [pluginId]: { ...state.plugins[pluginId], status: "disabled" },
      },
    }))
  }

  private async verifyRollback(pluginId: string, expectedVersion: string): Promise<boolean> {
    return this.getPluginVersion(pluginId) === expectedVersion
  }

  private async checkRequiresRestart(pluginId: string): Promise<boolean> {
    const lifecycle = getPluginManager()
    const state = await lifecycle.getPluginLifecycleState(pluginId)
    return (
      lifecycle.hasUnresolvedActivationResources(pluginId) ||
      ["activating", "stopping", "dirty"].includes(state.actual)
    )
  }

  private getPluginVersion(pluginId: string): string | null {
    const plugin = usePluginStore.getState().plugins[pluginId]
    return plugin?.manifest.version || null
  }

  private async refreshRuntimePlugins(): Promise<void> {
    await getPluginManager().scanPlugins()
    await getPluginManager().syncRuntimeState()
  }

  // ===========================================================================
  // Version Utilities
  // ===========================================================================

  private compareVersions(a: string, b: string): number {
    const aParts = a.split(".").map((p) => parseInt(p) || 0)
    const bParts = b.split(".").map((p) => parseInt(p) || 0)

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0
      const bVal = bParts[i] || 0
      if (aVal > bVal) return 1
      if (aVal < bVal) return -1
    }

    return 0
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let rollbackManagerInstance: PluginRollbackManager | null = null

export function getPluginRollbackManager(config?: Partial<RollbackConfig>): PluginRollbackManager {
  if (!rollbackManagerInstance) {
    rollbackManagerInstance = new PluginRollbackManager(config)
  }
  return rollbackManagerInstance
}

export function resetPluginRollbackManager(): void {
  rollbackManagerInstance = null
}
