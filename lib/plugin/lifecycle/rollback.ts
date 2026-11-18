/**
 * Plugin Rollback System
 *
 * Handles plugin version rollback with state migration support.
 */

import { getPluginBackupManager, type PluginBackup } from "./backup"
import { loggers } from "../core/logger"
import { usePluginStore } from "@/stores/plugin-runtime"
import { getPluginMarketplace } from "../package/marketplace"
import { getPluginManager } from "../core/manager"
import type { PluginGraphReservation } from "../core/lifecycle-coordinator"
import { getInstallOrigin } from "@/lib/db/plugin-install-origins"
import { recordInstallOrigin } from "../origin/install-origin"
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
}

export interface RollbackResult {
  success: boolean
  pluginId: string
  fromVersion: string
  toVersion: string
  duration: number
  error?: string
  migrationApplied: boolean
  requiresRestart: boolean
  rollback?: { attempted: boolean; succeeded: boolean; error?: string }
}

export interface RollbackPlan {
  pluginId: string
  targetVersion: string
  steps: RollbackStep[]
  estimatedDuration: number
  warnings: string[]
}

export interface RollbackStep {
  order: number
  action: "backup" | "disable" | "unload" | "restore" | "migrate" | "load" | "enable" | "verify"
  description: string
  reversible: boolean
}

export interface MigrationScript {
  fromVersion: string
  toVersion: string
  up: (data: Record<string, unknown>) => Record<string, unknown>
  down: (data: Record<string, unknown>) => Record<string, unknown>
}

export interface RollbackConfig {
  createBackupBeforeRollback: boolean
  verifyAfterRollback: boolean
  migrateData: boolean
  maxRollbackHistory: number
}

// =============================================================================
// Plugin Rollback Manager
// =============================================================================

export interface RollbackDeps {
  readOrigin?: (pluginId: string) => Promise<PluginInstallOriginRecord | undefined>
  recordOrigin?: typeof recordInstallOrigin
}

export class PluginRollbackManager {
  private config: RollbackConfig
  private migrations: Map<string, MigrationScript[]> = new Map()
  private rollbackHistory: RollbackResult[] = []
  private readOrigin: NonNullable<RollbackDeps["readOrigin"]>
  private recordOrigin: typeof recordInstallOrigin

  constructor(config: Partial<RollbackConfig> = {}, deps: RollbackDeps = {}) {
    this.readOrigin = deps.readOrigin ?? getInstallOrigin
    this.recordOrigin = deps.recordOrigin ?? recordInstallOrigin
    this.config = {
      createBackupBeforeRollback: true,
      verifyAfterRollback: true,
      migrateData: true,
      maxRollbackHistory: 50,
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
          })
        }
      }
    } catch {
      // Marketplace not available
    }

    // Sort by version (newest first)
    availableVersions.sort((a, b) => this.compareVersions(b.version, a.version))

    return {
      pluginId,
      currentVersion,
      availableVersions,
      hasBackups: backups.length > 0,
      lastBackup: backups[0],
    }
  }

  // ===========================================================================
  // Rollback Planning
  // ===========================================================================

  async createRollbackPlan(pluginId: string, targetVersion: string): Promise<RollbackPlan> {
    const info = await this.getRollbackInfo(pluginId)
    const steps: RollbackStep[] = []
    const warnings: string[] = []

    // Check if target version is available
    const targetVersionInfo = info.availableVersions.find((v) => v.version === targetVersion)
    if (!targetVersionInfo) {
      throw new Error(`Version ${targetVersion} is not available for rollback`)
    }

    if (!targetVersionInfo.canRollback) {
      throw new Error(`Cannot rollback to version ${targetVersion}`)
    }

    // Plan steps
    let order = 1

    // Step 1: Backup current state
    if (this.config.createBackupBeforeRollback) {
      steps.push({
        order: order++,
        action: "backup",
        description: "Create backup of current state",
        reversible: true,
      })
    }

    // Step 2: Disable plugin
    steps.push({
      order: order++,
      action: "disable",
      description: "Disable plugin",
      reversible: true,
    })

    // Step 3: Unload plugin
    steps.push({
      order: order++,
      action: "unload",
      description: "Unload plugin module",
      reversible: true,
    })

    // Step 4: Restore/install target version
    steps.push({
      order: order++,
      action: "restore",
      description: `Restore to version ${targetVersion}`,
      reversible: false,
    })

    // Step 5: Migrate data if needed
    if (this.config.migrateData) {
      const hasMigration = this.hasMigrationPath(pluginId, info.currentVersion, targetVersion)
      if (hasMigration) {
        steps.push({
          order: order++,
          action: "migrate",
          description: "Migrate plugin data",
          reversible: true,
        })
      } else {
        warnings.push("No migration script found; data may be incompatible")
      }
    }

    const status = usePluginStore.getState().plugins[pluginId]?.status
    const reactivate = ["enabled", "suspended", "enabling"].includes(status ?? "")
    // Match execution: inactive plugins stay inactive after restoring bytes.
    if (reactivate || status === "loaded" || status === "loading")
      steps.push({
        order: order++,
        action: "load",
        description: "Load plugin module",
        reversible: true,
      })

    // Step 7: Enable plugin
    if (reactivate)
      steps.push({
        order: order++,
        action: "enable",
        description: "Enable plugin",
        reversible: true,
      })

    // Step 8: Verify
    if (this.config.verifyAfterRollback) {
      steps.push({
        order: order++,
        action: "verify",
        description: "Verify rollback success",
        reversible: false,
      })
    }

    // Check for potential issues
    if (this.isMajorVersionChange(info.currentVersion, targetVersion)) {
      warnings.push("Major version change detected; breaking changes may occur")
    }

    return {
      pluginId,
      targetVersion,
      steps,
      estimatedDuration: steps.length * 1000, // Rough estimate
      warnings,
    }
  }

  // ===========================================================================
  // Rollback Execution
  // ===========================================================================

  /** Restore the selected snapshot, including multiple backups of one version. */
  async restoreBackup(backupId: string): Promise<RollbackResult> {
    const backup = getPluginBackupManager().getBackup(backupId)
    if (!backup) {
      return {
        success: false,
        pluginId: "",
        fromVersion: "",
        toVersion: "",
        duration: 0,
        error: "Backup not found",
        migrationApplied: false,
        requiresRestart: false,
      }
    }
    return this.rollback(backup.pluginId, backup.version, backupId)
  }

  async rollback(
    pluginId: string,
    targetVersion: string,
    backupId?: string
  ): Promise<RollbackResult> {
    const startTime = Date.now()
    const info = await this.getRollbackInfo(pluginId)
    const fromVersion = info.currentVersion
    let initialStatus = usePluginStore.getState().plugins[pluginId]?.status
    const lifecycle = getPluginManager()
    let reservation: PluginGraphReservation | undefined
    let migrationApplied = false
    let pendingRestore = false
    // Compensation state: what to put back if a step after teardown fails.
    let safetyBackupId: string | undefined
    let resumeState: RuntimeResumeState = "stopped"
    let quiesced = false
    let packageMutated = false
    let configBeforeMigration: Record<string, unknown> | undefined
    let originBefore: PluginInstallOriginRecord | undefined

    try {
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

      // Step 4: Migrate data if needed
      if (this.config.migrateData) {
        const config = usePluginStore.getState().plugins[pluginId]?.config
        configBeforeMigration = config ? structuredClone(config) : undefined
        migrationApplied = await this.applyMigration(pluginId, fromVersion, targetVersion)
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
        migrationApplied,
        requiresRestart: pendingRestore || (await this.checkRequiresRestart(pluginId)),
      }

      this.recordRollback(result)
      return result
    } catch (error) {
      pendingRestore ||=
        lifecycle.hasUnresolvedActivationResources(pluginId) ||
        (error instanceof Error && error.name === "PluginActivationConflictError")
      const message = error instanceof Error ? error.message : String(error)
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
          configBeforeMigration: migrationApplied ? configBeforeMigration : undefined,
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
        migrationApplied,
        requiresRestart: pendingRestore,
        ...(compensation ? { rollback: compensation } : {}),
      }

      this.recordRollback(result)
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
   * safety snapshot taken in step 1 restores the package (and the config a
   * migration rewrote, and the origin a marketplace install re-recorded); the
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
    configBeforeMigration: Record<string, unknown> | undefined
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
      if (input.configBeforeMigration) {
        usePluginStore.getState().setPluginConfig(pluginId, input.configBeforeMigration)
      }
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

  async rollbackToLatestBackup(pluginId: string): Promise<RollbackResult> {
    const backupManager = getPluginBackupManager()
    const backups = backupManager.getBackups(pluginId)

    if (backups.length === 0) {
      return {
        success: false,
        pluginId,
        fromVersion: "",
        toVersion: "",
        duration: 0,
        error: "No backups available",
        migrationApplied: false,
        requiresRestart: false,
      }
    }

    return this.rollback(pluginId, backups[0].version)
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

  // ===========================================================================
  // Migration Support
  // ===========================================================================

  registerMigration(pluginId: string, migration: MigrationScript): void {
    const migrations = this.migrations.get(pluginId) || []
    migrations.push(migration)
    migrations.sort((a, b) => this.compareVersions(a.fromVersion, b.fromVersion))
    this.migrations.set(pluginId, migrations)
  }

  hasMigrationPath(pluginId: string, fromVersion: string, toVersion: string): boolean {
    const migrations = this.migrations.get(pluginId)
    if (!migrations) return false

    // Check if we can migrate between these versions
    const isDowngrade = this.compareVersions(fromVersion, toVersion) > 0

    if (isDowngrade) {
      // Need down migrations
      return migrations.some(
        (m) =>
          this.compareVersions(m.toVersion, fromVersion) <= 0 &&
          this.compareVersions(m.fromVersion, toVersion) >= 0
      )
    } else {
      // Need up migrations
      return migrations.some(
        (m) =>
          this.compareVersions(m.fromVersion, fromVersion) >= 0 &&
          this.compareVersions(m.toVersion, toVersion) <= 0
      )
    }
  }

  private async applyMigration(
    pluginId: string,
    fromVersion: string,
    toVersion: string
  ): Promise<boolean> {
    const migrations = this.migrations.get(pluginId)
    if (!migrations) return false

    const isDowngrade = this.compareVersions(fromVersion, toVersion) > 0

    try {
      const store = usePluginStore.getState()
      const existingPlugin = store.plugins[pluginId]
      if (!existingPlugin) {
        return false
      }

      // A throwing migration must not mutate nested values in the live config.
      let migratedData = structuredClone(existingPlugin.config)

      if (isDowngrade) {
        // Apply down migrations in reverse order
        const applicableMigrations = migrations
          .filter(
            (m) =>
              this.compareVersions(m.toVersion, fromVersion) <= 0 &&
              this.compareVersions(m.fromVersion, toVersion) >= 0
          )
          .reverse()

        for (const migration of applicableMigrations) {
          migratedData = migration.down(migratedData)
        }
      } else {
        // Apply up migrations in order
        const applicableMigrations = migrations.filter(
          (m) =>
            this.compareVersions(m.fromVersion, fromVersion) >= 0 &&
            this.compareVersions(m.toVersion, toVersion) <= 0
        )

        for (const migration of applicableMigrations) {
          migratedData = migration.up(migratedData)
        }
      }

      // Save migrated data
      store.setPluginConfig(pluginId, migratedData)
      return true
    } catch (error) {
      loggers.manager.error("[Rollback] Migration failed:", error)
      throw error
    }
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

  private isMajorVersionChange(from: string, to: string): boolean {
    const fromMajor = parseInt(from.split(".")[0]) || 0
    const toMajor = parseInt(to.split(".")[0]) || 0
    return fromMajor !== toMajor
  }

  // ===========================================================================
  // History
  // ===========================================================================

  private recordRollback(result: RollbackResult): void {
    this.rollbackHistory.push(result)
    if (this.rollbackHistory.length > this.config.maxRollbackHistory) {
      this.rollbackHistory = this.rollbackHistory.slice(-this.config.maxRollbackHistory)
    }
  }

  getRollbackHistory(pluginId?: string): RollbackResult[] {
    if (pluginId) {
      return this.rollbackHistory.filter((r) => r.pluginId === pluginId)
    }
    return [...this.rollbackHistory]
  }

  clearHistory(): void {
    this.rollbackHistory = []
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
