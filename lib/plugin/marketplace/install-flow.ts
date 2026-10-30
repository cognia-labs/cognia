/**
 * Marketplace pre-install chain.
 *
 * Bridges between the marketplace client (`getPluginMarketplace().installPlugin`)
 * and the UI dialog hosts (`PluginPreInstallDialog`, `PluginConflictDialog`)
 * so that each plugin is committed only after its own conflict, permission,
 * dependency and configuration review. Approved dependency installations may
 * remain when a later parent step is cancelled; the dialog explains this.
 *
 * The orchestrator is dialog-agnostic. usePluginPreInstall supplies the
 * review callbacks; marketplace and Discover mount its controlled dialog.
 *
 * Cancellation releases unused staging and restores temporarily paused or
 * explicitly displaced providers across the whole requested dependency tree.
 */

import type { PluginBinaryRequirement, PluginManifest, PluginPermission } from "@/types/plugin"
import type { PluginIntentPauseLease } from "@/lib/plugin/core/lifecycle-coordinator"
import type { PluginManager } from "@/lib/plugin/core/manager"
import { listPlugins, getPlugin, setPluginConfig } from "@/lib/db/plugins"
import { usePluginStore } from "@/stores/plugin-runtime"
import { ConflictDetector, createPluginRegistration } from "@/lib/plugin/package/conflict-detector"
import { compareVersions, satisfiesConstraint } from "@/lib/plugin/package/dependency-resolver"
import { dispatchPluginError } from "@/lib/plugin/error-bus"
import { reservePluginOwnership } from "@/lib/plugin/registries/createOverlayRegistry"

// =============================================================================
// Public types
// =============================================================================

export type PreInstallStage =
  "conflict" | "dependencies" | "permission" | "binary-requirements" | "config" | "install"

/** A required plugin dependency whose installed version conflicts. */
export interface PreInstallDependencyConflict {
  /** Dependency plugin id. */
  pluginId: string
  /** Version constraint the target plugin requires. */
  required: string
  /** Version currently installed (which fails the constraint). */
  available: string
}

export interface PreInstallDependencyPayload {
  /** The install target. */
  pluginId: string
  /** Required dependency ids that are not installed at all. */
  missing: string[]
  /** Required dependencies installed at an incompatible version. */
  conflicts: PreInstallDependencyConflict[]
  actions?: Array<{
    pluginId: string
    required: string
    available?: string
    version?: string
    pausePluginIds?: string[]
    lookupFailed?: boolean
  }>
  unresolved?: boolean
}

export interface PreInstallBinaryPayload {
  pluginId: string
  /** The binaries declared in `requires.binaries` that aren't satisfied. */
  missing: Array<PluginBinaryRequirement & { detectedVersion?: string }>
}

export interface PreInstallConflict {
  /** Plugin id involved in the conflict (the install target). */
  pluginId: string
  /** Plain-text reasons surfaced to the user. Severity drives styling. */
  reasons: Array<{
    severity: "high" | "medium" | "low"
    message: string
    type?: string
    plugins?: string[]
  }>
  conflictingPluginIds?: string[]
  canContinue?: boolean
}

export interface PreInstallPermissionPayload {
  pluginId: string
  declared: PluginPermission[]
  optional: PluginPermission[]
  /**
   * Declared network egress allowlist (`manifest.networkAccess`). Surfaced in
   * the review so the user sees WHICH hosts the plugin may reach and WHY
   * before granting `network:fetch`.
   */
  networkAccess?: {
    allowedDomains?: string[]
    reasoning?: string
  }
}

export interface PreInstallConfigPayload {
  pluginId: string
  /** Loose shape — the dialog renders whatever it can parse. */
  configSchema: Record<string, unknown>
  /**
   * The manifest's own locale bundles, so the dialog can resolve the schema's
   * `titleKey` / `descriptionKey` / `enumItemLabelKeys` before install, when
   * no runtime bundle for the plugin is loaded yet.
   */
  i18n?: PluginManifest["i18n"]
}

export interface RunMarketplaceInstallOpts {
  pluginId: string
  version?: string
  signal?: AbortSignal
  /** Reviewed active consumers to pause immediately before this commit. */
  pauseBeforeInstall?: string[]

  /**
   * Resolve the conflict-review step. Invoked only when the install detects
   * shared-key overlaps or an already-installed plugin with the same id.
   * Return `"continue"` to advance, `"cancel"` to abort.
   */
  requestConflictReview: (
    conflict: PreInstallConflict
  ) => Promise<"continue" | "disable-conflicting" | "cancel">

  /**
   * Resolve the dependency-review step. Invoked only when the manifest
   * declares `dependencies` AND at least one required dependency is missing
   * or installed at an incompatible version. `"resolve"` reviews and installs
   * compatible packages; `"continue"` rechecks manual changes; `"cancel"` aborts.
   * Optional — when absent, an unmet required dependency aborts the install
   * with a `cancelled/dependencies` result (the plugin can't function without
   * it, so silently proceeding is not acceptable).
   */
  requestDependencyReview?: (
    payload: PreInstallDependencyPayload
  ) => Promise<"continue" | "resolve" | "cancel">

  /**
   * Look up an installed plugin's version by id. Injected so tests don't need
   * a live Dexie; defaults to `getPlugin` from `@/lib/db/plugins`.
   */
  dependencyClient?: RunMarketplaceInstallOpts["client"]
  resolveConflictingPlugins?: (ids: string[]) => Promise<PluginConflictResolution>
  checkInstalledPlugin?: (id: string) => Promise<{ version: string } | null>

  /**
   * Resolve the permission-review step. Invoked only when the manifest
   * declares any permissions (declared or optional). Return `"approve"` to
   * advance, `"cancel"` to abort.
   */
  requestPermissionReview: (payload: PreInstallPermissionPayload) => Promise<"approve" | "cancel">

  /**
   * Resolve the binary-requirements step. Invoked only when the manifest
   * declares `requires.binaries` AND at least one is missing / below its
   * minVersion. The dialog may re-probe internally ("I installed it");
   * it resolves `"proceed"` when the user wants to continue (all satisfied
   * or override) or `"cancel"` to abort. Optional — when absent, a missing
   * binary aborts the install with a `cancelled/binary-requirements` result.
   */
  requestBinaryReview?: (payload: PreInstallBinaryPayload) => Promise<"proceed" | "cancel">

  /**
   * Probe a single binary's presence + version. Injected so tests don't
   * shell out; defaults to the real `detectCli` from `lib/cli-bridge`.
   */
  detectBinary?: (name: string) => Promise<{ available: boolean; version: string | null }>

  /**
   * Resolve the configuration step. Invoked only when the manifest carries a
   * non-empty `configSchema`. Returns `"save"` with the value, or `"cancel"`.
   */
  requestConfig: (
    payload: PreInstallConfigPayload
  ) => Promise<{ result: "save"; value: unknown } | { result: "cancel" }>

  /**
   * The marketplace client. Pass the singleton from
   * `getPluginMarketplace()` — splitting out the dependency lets tests
   * inject a fake without hauling in the full client.
   */
  client: {
    getPlugin: (id: string) => Promise<{ manifest: PluginManifest; name?: string } | null>
    getVersions?: (id: string) => Promise<Array<{ version: string }>>
    preparePlugin?: (
      id: string,
      version?: string
    ) => Promise<{
      manifest: PluginManifest
      install: (config?: Record<string, unknown>) => Promise<unknown>
      dispose: () => Promise<void>
    }>
    supportsTransactionalConfig?: boolean
    installPlugin: (
      id: string,
      version?: string,
      options?: { config?: Record<string, unknown> }
    ) => Promise<unknown>
  }

  /**
   * Rollback hook for failures that happen AFTER `client.installPlugin`
   * returns successfully — currently only the `setPluginConfig` step.
   * The default implementation lazy-loads `getPluginManager()` and calls
   * `rollbackInstallation` on it. Tests inject a spy to assert the call
   * without dragging the full manager into the unit setup.
   *
   * `null` means "skip rollback" (used in tests that simulate the
   * config-persist failure without exercising the manager). In
   * production callers should leave this undefined so the default fires.
   */
  rollback?: ((pluginId: string, reason: string) => Promise<void>) | null
}

/**
 * Discriminant for `failed` results. `install-rollback` is only emitted
 * when the post-install rollback itself failed — the plugin row may
 * still be in Dexie and the user must uninstall manually. The UI uses
 * the distinction to escalate the toast severity.
 */
export type RunMarketplaceFailedStage = PreInstallStage | "install-rollback"

export type RunMarketplaceInstallResult =
  | { status: "installed"; pluginId: string }
  | { status: "cancelled"; stage: PreInstallStage }
  | { status: "failed"; stage: RunMarketplaceFailedStage; message: string }

// =============================================================================
// Helpers
// =============================================================================

/**
 * Detect conflicts against the live plugin table. Surfaces:
 * - id collision with an already-installed plugin (severity: high)
 * - command / shortcut / namespace / capability / version overlaps with installed
 *   plugins, detected via `ConflictDetector` (ADR 0016 P1-6, 2026-05-17).
 *   Severity is mapped from the detector's `error`/`warning`/`info` band.
 *
 * Additional rules (signing required, incompatible dependency, etc.) can be
 * folded in here without changing the orchestrator.
 */
export async function detectConflicts(
  pluginId: string,
  candidateManifest: PluginManifest | null
): Promise<PreInstallConflict | null> {
  const installed = await listPlugins()
  const reasons: PreInstallConflict["reasons"] = []

  const existing = installed.find((p) => p.id === pluginId)
  if (existing) {
    reasons.push({
      severity: "high",
      message: `alreadyInstalled:${existing.version}`,
    })
  }

  if (candidateManifest) {
    const detector = new ConflictDetector()

    detector.setPlugins(
      installed
        .filter((row) => row.id !== pluginId && row.manifest)
        .map((row) => ({
          ...createPluginRegistration(row.manifest as unknown as PluginManifest),
          // Disabled plugins retain dependency/version metadata, but own no live keys.
          ...(row.enabled === false
            ? { commands: [], shortcuts: [], namespaces: [], resources: [] }
            : {}),
        }))
    )
    detector.registerPlugin(createPluginRegistration(candidateManifest))
    const result = detector.detectForPlugin(pluginId)
    const severityFor = (band: "error" | "warning" | "info"): "high" | "medium" | "low" =>
      band === "error" ? "high" : band === "warning" ? "medium" : "low"
    for (const conflict of [...result.errors, ...result.warnings, ...result.info]) {
      reasons.push({
        severity: severityFor(conflict.severity),
        message: `${conflict.type}:${conflict.description}`,
        type: conflict.type,
        plugins: conflict.plugins,
      })
    }
  }

  const conflictingPluginIds = [
    ...new Set(
      reasons
        .filter((r) => r.type && r.type !== "version" && r.type !== "capability")
        .flatMap((r) => r.plugins ?? [])
        .filter((id) => id !== pluginId)
    ),
  ]
  const canContinue = !reasons.some((r) => r.type === "version" && r.plugins?.[0] === pluginId)
  return reasons.length > 0 ? { pluginId, reasons, conflictingPluginIds, canContinue } : null
}

export function hasConfigSchema(manifest: PluginManifest): boolean {
  const schema = (manifest as { configSchema?: unknown }).configSchema
  if (!schema || typeof schema !== "object") return false
  const obj = schema as Record<string, unknown>
  if (obj.type !== "object" || typeof obj.properties !== "object") return false
  const props = obj.properties as Record<string, unknown>
  return Object.keys(props).length > 0
}

/**
 * Probe the manifest's `requires.binaries` and return the subset that
 * isn't satisfied (absent, or present but below `minVersion`). Returns an
 * empty array when the manifest declares no binaries or all are present.
 *
 * `detectBinary` is injected by the orchestrator (defaulting to the real
 * `detectCli`) so this stays unit-testable without spawning processes.
 */
export async function resolveMissingBinaries(
  manifest: PluginManifest,
  detectBinary: (name: string) => Promise<{ available: boolean; version: string | null }>
): Promise<PreInstallBinaryPayload["missing"]> {
  const required = manifest.requires?.binaries ?? []
  if (required.length === 0) return []
  const { satisfiesMinVersion } = await import("@/lib/cli-bridge/detect-cli")
  const missing: PreInstallBinaryPayload["missing"] = []
  for (const req of required) {
    const probe = await detectBinary(req.name)
    const ok = probe.available && satisfiesMinVersion(probe.version, req.minVersion)
    if (!ok) {
      missing.push({ ...req, detectedVersion: probe.version ?? undefined })
    }
  }
  return missing
}

/** Default binary probe — lazy-loads the real detector. */
export async function defaultDetectBinary(
  name: string
): Promise<{ available: boolean; version: string | null }> {
  try {
    const { detectCli } = await import("@/lib/cli-bridge/detect-cli")
    const r = await detectCli(name)
    return { available: r.available, version: r.version }
  } catch {
    // If the detector can't load (web bundle without the command), treat
    // as "not available" — the gate then surfaces the requirement.
    return { available: false, version: null }
  }
}

/**
 * Resolve the manifest's required `dependencies` against installed plugins.
 * Returns the missing ids + version conflicts. `optionalDependencies` are
 * intentionally NOT gated — they degrade gracefully by design.
 *
 * `checkInstalled` is injected (defaulting to `getPlugin`) so this stays
 * unit-testable without a live Dexie.
 */
export async function resolveDependencyIssues(
  pluginId: string,
  manifest: PluginManifest,
  checkInstalled: (id: string) => Promise<{ version: string } | null>
): Promise<PreInstallDependencyPayload> {
  const required = manifest.dependencies ?? {}
  const missing: string[] = []
  const conflicts: PreInstallDependencyConflict[] = []
  for (const [depId, constraint] of Object.entries(required)) {
    const installed = await checkInstalled(depId)
    if (!installed) {
      missing.push(depId)
    } else if (!satisfiesConstraint(installed.version, constraint)) {
      conflicts.push({ pluginId: depId, required: constraint, available: installed.version })
    }
  }
  return { pluginId, missing, conflicts }
}

/** Default installed-plugin probe — reads the Dexie plugin row. */
async function defaultCheckInstalledPlugin(id: string): Promise<{ version: string } | null> {
  const row = await getPlugin(id)
  return row ? { version: row.version } : null
}

// =============================================================================
// Orchestrator
// =============================================================================

export interface PluginConflictResolution {
  (skipIds?: ReadonlySet<string>): Promise<void>
  pause?: () => Promise<void>
  commit?: () => Promise<void>
  isCurrent?: (pluginId: string) => boolean
  willResume?: (pluginId: string) => boolean
}

interface InstallResolutionContext {
  restoreOnFailure: PluginConflictResolution[]
  resumeOnSuccess: PluginConflictResolution[]
  committedPlugins: Set<string>
  replacements: Array<{ ids: string[]; resolution: PluginConflictResolution }>
  reservations: Array<ReturnType<typeof reservePluginOwnership>>
  manifests: Map<string, PluginManifest>
  resumePlugins: Map<string, PluginConflictResolution[]>
}

function replacementIds(context: InstallResolutionContext): Set<string> {
  return new Set(
    context.replacements.flatMap(({ ids, resolution }) =>
      ids.filter((id) => resolution.isCurrent?.(id) ?? true)
    )
  )
}

function dependencyConstraints(
  manifest: PluginManifest,
  installed: Awaited<ReturnType<typeof listPlugins>>,
  id: string
): string[] {
  return [
    manifest.dependencies![id],
    ...installed
      .filter((row) => row.id !== id)
      .flatMap((row) => {
        const deps = (row.manifest as unknown as PluginManifest | undefined)?.dependencies
        return deps?.[id] ? [deps[id]] : []
      }),
  ]
}

/** Include parent/sibling requirements, even when their packages aren't installed yet. */
async function requiredProviders(context: InstallResolutionContext): Promise<Set<string>> {
  const manifests = new Map(
    (await listPlugins())
      .filter((row) => row.manifest)
      .map((row) => [row.id, row.manifest as unknown as PluginManifest])
  )
  for (const [id, manifest] of context.manifests) manifests.set(id, manifest)
  const required = new Set<string>()
  const visited = new Set<PluginManifest>()
  const visit = (manifest: PluginManifest) => {
    if (visited.has(manifest)) return
    visited.add(manifest)
    for (const [id, range] of Object.entries(manifest.dependencies ?? {})) {
      required.add(id)
      const dependency = manifests.get(id)
      // An incompatible installed version will be replaced. Its old outgoing
      // edges cannot constrain the package selected during dependency review.
      if (dependency && satisfiesConstraint(dependency.version, range)) visit(dependency)
    }
  }
  for (const manifest of context.manifests.values()) visit(manifest)
  for (const [id, resolutions] of context.resumePlugins) {
    const manifest = manifests.get(id)
    if (
      manifest &&
      resolutions.some((resolution) => resolution.willResume?.(id) ?? true) &&
      !replacementIds(context).has(id)
    )
      visit(manifest)
  }
  return required
}

export async function runMarketplaceInstall(
  opts: RunMarketplaceInstallOpts
): Promise<RunMarketplaceInstallResult> {
  const context: InstallResolutionContext = {
    restoreOnFailure: [],
    resumeOnSuccess: [],
    committedPlugins: new Set(),
    replacements: [],
    reservations: [],
    manifests: new Map(),
    resumePlugins: new Map(),
  }
  let result: RunMarketplaceInstallResult
  const restored = new Set<PluginConflictResolution>()
  try {
    result = await runInstallStep(opts, [], context)
    const undo = result.status === "installed" ? context.resumeOnSuccess : context.restoreOnFailure
    const errors: unknown[] = []
    const resumeReleased: Array<() => Promise<void>> = []
    if (result.status !== "installed")
      for (const reservation of context.reservations) reservation.activate()
    if (result.status !== "installed" && undo.length > 0 && context.committedPlugins.size) {
      const { getPluginManager } = await import("../core/manager")
      const manager = getPluginManager()
      // Release newly acquired keys before restoring original incumbents. Pause
      // consumers before providers; resume providers before consumers afterward.
      const active = [...context.committedPlugins]
        .reverse()
        .filter((id) => ["enabled", "suspended"].includes(manager.getPlugin(id)?.status ?? ""))
      try {
        if (active.length) resumeReleased.push(await resolveConflictingPlugins(active))
      } catch (error) {
        errors.push(error)
      }
    }
    for (const restore of [...undo].reverse()) {
      try {
        await restore(result.status === "installed" ? replacementIds(context) : undefined)
        restored.add(restore)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const resume of resumeReleased.reverse()) {
      try {
        await resume()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      result = { status: "failed", stage: "install-rollback", message: "restoreFailed" }
  } catch {
    result = { status: "failed", stage: "install-rollback", message: "restoreFailed" }
  }
  try {
    if (context.reservations.length) {
      const { flushPluginShortcutOperations } = await import("../shortcuts/plugin-shortcut-bridge")
      await flushPluginShortcutOperations()
    }
  } catch {
    result = { status: "failed", stage: "install-rollback", message: "restoreFailed" }
  }
  for (const { resolution } of context.replacements) {
    try {
      if (result.status === "installed") await resolution.commit?.()
      else if (!restored.has(resolution)) await resolution()
    } catch {
      result = { status: "failed", stage: "install-rollback", message: "restoreFailed" }
    }
  }
  for (const reservation of context.reservations) reservation.dispose()
  return result
}

async function runInstallStep(
  opts: RunMarketplaceInstallOpts,
  ancestors: readonly string[],
  context: InstallResolutionContext
): Promise<RunMarketplaceInstallResult> {
  if (opts.signal?.aborted) return { status: "cancelled", stage: "install" }
  if (ancestors.includes(opts.pluginId) || ancestors.length >= 32) {
    return { status: "failed", stage: "dependencies", message: "dependencyCycle" }
  }
  let prepared: Awaited<ReturnType<NonNullable<typeof opts.client.preparePlugin>>> | undefined
  let result: RunMarketplaceInstallResult
  try {
    prepared = await opts.client.preparePlugin?.(opts.pluginId, opts.version)
    result = await runReviewedInstall(opts, ancestors, prepared, context)
  } catch (error) {
    result = {
      status: "failed",
      stage: "install",
      message: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    await prepared?.dispose()
  } catch {
    return { status: "failed", stage: "install-rollback", message: "stagingCleanupFailed" }
  }
  return result
}

async function runReviewedInstall(
  opts: RunMarketplaceInstallOpts,
  ancestors: readonly string[],
  prepared:
    | Awaited<ReturnType<NonNullable<RunMarketplaceInstallOpts["client"]["preparePlugin"]>>>
    | undefined,
  context: InstallResolutionContext
): Promise<RunMarketplaceInstallResult> {
  const { pluginId, version, client } = opts

  // Step 0 — resolve the manifest. Without it we can't show permissions /
  // configSchema. Surface as a failed result rather than throwing so the
  // caller can show a toast.
  let manifest: PluginManifest
  try {
    const entry = prepared ?? (await client.getPlugin(pluginId))
    if (!entry) {
      return { status: "failed", stage: "install", message: "plugin_not_found" }
    }
    manifest = entry.manifest
    if (opts.signal?.aborted) return { status: "cancelled", stage: "install" }
    if (manifest.id !== pluginId || (version && manifest.version !== version)) {
      throw new Error("reviewIdentityMismatch")
    }
  } catch (err) {
    return {
      status: "failed",
      stage: "install",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  context.manifests.set(pluginId, manifest)
  const required = await requiredProviders(context)
  if ([...replacementIds(context)].some((id) => required.has(id))) {
    return { status: "failed", stage: "conflict", message: "requiredProviderConflict" }
  }

  // Step 1 — conflict review.
  const conflict = await detectConflicts(pluginId, manifest)
  let replacement: PluginConflictResolution | undefined
  if (conflict) {
    const decision = await opts.requestConflictReview(conflict)
    if (decision === "cancel") return { status: "cancelled", stage: "conflict" }
    if (conflict.canContinue === false)
      return {
        status: "failed",
        stage: "conflict",
        message: "dependentVersionConflict",
      }
    if (decision === "disable-conflicting" && conflict.conflictingPluginIds?.length) {
      if (conflict.conflictingPluginIds.some((id) => required.has(id))) {
        return { status: "failed", stage: "conflict", message: "requiredProviderConflict" }
      }
      try {
        for (const id of conflict.conflictingPluginIds)
          context.reservations.push(reservePluginOwnership(id, false))
        replacement = opts.resolveConflictingPlugins
          ? await opts.resolveConflictingPlugins(conflict.conflictingPluginIds)
          : await resolveConflictingPlugins(conflict.conflictingPluginIds, undefined, {
              deferred: true,
            })
        context.restoreOnFailure.push(replacement)
        context.replacements.push({ ids: conflict.conflictingPluginIds, resolution: replacement })
      } catch (error) {
        return {
          status: "failed",
          stage: error instanceof AggregateError ? "install-rollback" : "conflict",
          message: error instanceof AggregateError ? "restoreFailed" : String(error),
        }
      }
    }
  }

  // Step 1.5 — dependency review (only when the manifest declares required
  // `dependencies` AND at least one is missing / version-incompatible). Like
  // the binary step: absent review callback blocks the install, since the
  // plugin can't function without its dependencies.
  const checkInstalled = opts.checkInstalledPlugin ?? defaultCheckInstalledPlugin
  let depIssues = await resolveDependencyIssues(pluginId, manifest, checkInstalled)
  while (depIssues.missing.length > 0 || depIssues.conflicts.length > 0) {
    if (!opts.requestDependencyReview) return { status: "cancelled", stage: "dependencies" }
    const dependencyClient =
      opts.dependencyClient ?? (await (await import("./review-client")).loadRegistryReviewClient())
    const installed = await listPlugins()
    const ids = [...depIssues.missing, ...depIssues.conflicts.map((c) => c.pluginId)]
    depIssues.actions = await Promise.all(
      ids.map(async (id) => {
        const required = manifest.dependencies![id]
        const available = depIssues.conflicts.find((c) => c.pluginId === id)?.available
        const constraints = dependencyConstraints(manifest, installed, id)
        try {
          const entry = await dependencyClient.getPlugin(id)
          const versions = dependencyClient.getVersions
            ? await dependencyClient.getVersions(id)
            : entry
              ? [{ version: entry.manifest.version }]
              : []
          const version = versions
            .map((v) => v.version)
            .filter((v) => constraints.every((c) => satisfiesConstraint(v, c)))
            .sort((a, b) => compareVersions(b, a))[0]
          const pausePluginIds: string[] = []
          const seen = new Set([id])
          const collect = (provider: string) => {
            for (const row of installed) {
              const deps = (row.manifest as unknown as PluginManifest | undefined)?.dependencies
              const runtime = usePluginStore.getState().plugins[row.id]
              const runtimeActive =
                runtime &&
                ["loading", "loaded", "enabling", "enabled", "suspended"].includes(runtime.status)
              if (
                !(row.enabled || row.lifecycle?.intent === "enabled" || runtimeActive) ||
                !deps?.[provider] ||
                seen.has(row.id)
              )
                continue
              seen.add(row.id)
              collect(row.id)
              pausePluginIds.push(row.id)
            }
          }
          if (available) collect(id)
          return { pluginId: id, required, available, version, pausePluginIds }
        } catch {
          return { pluginId: id, required, available, lookupFailed: true }
        }
      })
    )
    const decision = await opts.requestDependencyReview(depIssues)
    if (decision === "cancel") return { status: "cancelled", stage: "dependencies" }
    let replan = false
    if (decision === "resolve") {
      if (depIssues.actions.some((a) => !a.version)) {
        return {
          status: "failed",
          stage: "dependencies",
          message: "dependencyUnavailable",
        }
      }
      for (const action of depIssues.actions) {
        const current = await checkInstalled(action.pluginId)
        const constraints = dependencyConstraints(manifest, await listPlugins(), action.pluginId)
        // A prior recursive install may already have solved this sibling.
        if (current && constraints.every((range) => satisfiesConstraint(current.version, range))) {
          continue
        }
        if (!constraints.every((range) => satisfiesConstraint(action.version!, range))) {
          replan = true
          break
        }
        const dependencyResult = await runInstallStep(
          {
            ...opts,
            pluginId: action.pluginId,
            version: action.version,
            client: dependencyClient,
            dependencyClient,
            pauseBeforeInstall: action.pausePluginIds,
          },
          [...ancestors, pluginId],
          context
        )
        if (dependencyResult.status !== "installed")
          return dependencyResult.status === "cancelled"
            ? { status: "cancelled", stage: "dependencies" }
            : { status: "failed", stage: "dependencies", message: dependencyResult.message }
      }
    }
    depIssues = {
      ...(await resolveDependencyIssues(pluginId, manifest, checkInstalled)),
      unresolved: true,
    }
    if (
      decision === "resolve" &&
      !replan &&
      (depIssues.missing.length || depIssues.conflicts.length)
    ) {
      return {
        status: "failed",
        stage: "dependencies",
        message: "dependenciesUnresolved",
      }
    }
  }

  const finalRequired = await requiredProviders(context)
  if ([...replacementIds(context)].some((id) => finalRequired.has(id))) {
    return { status: "failed", stage: "conflict", message: "requiredProviderConflict" }
  }
  await replacement?.pause?.()

  // Step 2 — permission review (only when there is something to review).
  const declared = manifest.permissions ?? []
  const optional = manifest.optionalPermissions ?? []
  if (declared.length > 0 || optional.length > 0) {
    const decision = await opts.requestPermissionReview({
      pluginId,
      declared,
      optional,
      networkAccess: manifest.networkAccess,
    })
    if (decision === "cancel") {
      return { status: "cancelled", stage: "permission" }
    }
  }

  // Step 2.5 — binary requirements (only when the manifest declares any
  // and at least one is missing). The detector is injectable; the UI
  // dialog may re-probe internally before resolving.
  const missingBinaries = await resolveMissingBinaries(
    manifest,
    opts.detectBinary ?? defaultDetectBinary
  )
  if (missingBinaries.length > 0) {
    if (!opts.requestBinaryReview) {
      // No UI to resolve the requirement → block the install.
      return { status: "cancelled", stage: "binary-requirements" }
    }
    const decision = await opts.requestBinaryReview({ pluginId, missing: missingBinaries })
    if (decision === "cancel") {
      return { status: "cancelled", stage: "binary-requirements" }
    }
  }

  // Step 3 — configuration (only when the manifest has parseable fields).
  // The user-provided value is persisted post-install via setPluginConfig so
  // the Dexie row reflects their edits before the plugin is enabled by the
  // manager. Empty {} payloads are skipped to avoid overriding manifest
  // defaults the manager would otherwise apply.
  let configValue: Record<string, unknown> | undefined
  if (hasConfigSchema(manifest)) {
    const schema = (manifest as { configSchema?: Record<string, unknown> }).configSchema!
    const i18n = (manifest as { i18n?: PluginManifest["i18n"] }).i18n
    const decision = await opts.requestConfig({
      pluginId,
      configSchema: schema,
      ...(i18n ? { i18n } : {}),
    })
    if (decision.result === "cancel") {
      return { status: "cancelled", stage: "config" }
    }
    if (
      decision.value !== undefined &&
      decision.value !== null &&
      typeof decision.value === "object" &&
      Object.keys(decision.value as Record<string, unknown>).length > 0
    ) {
      configValue = decision.value as Record<string, unknown>
    }
  }

  const finalDeps = await resolveDependencyIssues(pluginId, manifest, checkInstalled)
  if (opts.signal?.aborted) return { status: "cancelled", stage: "install" }
  if (finalDeps.missing.length || finalDeps.conflicts.length) {
    return {
      status: "failed",
      stage: "dependencies",
      message: "dependenciesChanged",
    }
  }

  // Keep live incumbent claims throughout review. Pause consumers only at
  // commit, then restore their priority before restarting modified providers.
  const pauseIds = opts.pauseBeforeInstall
  if (pauseIds?.length) {
    try {
      for (const id of pauseIds) context.reservations.push(reservePluginOwnership(id))
      const resolve = opts.resolveConflictingPlugins ?? resolveConflictingPlugins
      const restore = await resolve(pauseIds)
      for (const id of pauseIds) {
        const resolutions = context.resumePlugins.get(id) ?? []
        resolutions.push(restore)
        context.resumePlugins.set(id, resolutions)
      }
      context.restoreOnFailure.push(restore)
      context.resumeOnSuccess.push(restore)
    } catch (error) {
      return {
        status: "failed",
        stage: error instanceof AggregateError ? "install-rollback" : "dependencies",
        message: error instanceof AggregateError ? "restoreFailed" : String(error),
      }
    }
  }

  // Step 4 — actually install. Any failure here is a true install failure,
  // not a cancellation. After the install succeeds, persist the
  // configuration the user supplied in step 3 so it isn't lost. If the
  // config write fails we surface it as a failed result — the plugin row
  // exists in Dexie but the user's intent (install + configure) wasn't
  // fully met, so silent degradation is not acceptable here.
  if (opts.signal?.aborted) return { status: "cancelled", stage: "install" }
  try {
    const result = prepared
      ? await prepared.install(configValue)
      : configValue !== undefined && client.supportsTransactionalConfig
        ? await client.installPlugin(pluginId, version, { config: configValue })
        : await client.installPlugin(pluginId, version)
    if (result && typeof result === "object" && "success" in result && result.success === false) {
      throw new Error("error" in result ? String(result.error) : "Plugin installation failed")
    }
  } catch (err) {
    return {
      status: "failed",
      stage: "install",
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (configValue !== undefined && !client.supportsTransactionalConfig) {
    try {
      if (!(await getPlugin(pluginId))) {
        throw new Error(`Installed plugin metadata is missing: ${pluginId}`)
      }
      await setPluginConfig(pluginId, configValue)
      // The first activation reads the runtime store as well as Dexie. Keep
      // both views aligned only after the durable write succeeds.
      const store = usePluginStore.getState()
      if (store.plugins[pluginId]) store.setPluginConfig(pluginId, configValue)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // The manager finished a successful install — the user's intent
      // (install + configure) didn't fully complete, so leaving the row
      // in place would surface the plugin as "installed" with stale
      // config. Roll back to pre-install state so the user can retry
      // with their config still in mind.
      const rollbackFn =
        opts.rollback === undefined ? await resolveDefaultRollback() : opts.rollback
      if (rollbackFn) {
        try {
          await rollbackFn(pluginId, `Config persistence failed: ${reason}`)
        } catch (rollbackErr) {
          const rollbackReason =
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
          dispatchPluginError({
            pluginId,
            stage: "install-rollback",
            message: rollbackReason,
            severity: "error",
            recoverable: false,
          })
          return {
            status: "failed",
            stage: "install-rollback",
            message: rollbackReason,
          }
        }
      }
      return {
        status: "failed",
        stage: "install",
        message: reason,
      }
    }
  }

  context.committedPlugins.add(pluginId)
  return { status: "installed", pluginId }
}

/**
 * Lazy-load the production rollback hook
 * (`getPluginManager().rollbackInstallation`). Dynamic import so the
 * install-flow module stays cheap to load in headless tests that never
 * reach the post-install branch, and so the marketplace ⇄ manager edge
 * stays one-directional at module-graph time.
 *
 * Returns `null` when the manager isn't initialized (which happens in
 * tests that exercise install-flow in isolation) so the caller can
 * fall through without crashing — the post-install row is left in
 * Dexie and the test runner is expected to assert on the result.
 */
async function resolveDefaultRollback(): Promise<
  ((pluginId: string, reason: string) => Promise<void>) | null
> {
  try {
    const mod = await import("@/lib/plugin/core/manager")
    // Probe `getPluginManager()` synchronously — when the host hasn't
    // bootstrapped the singleton yet (tests, very early app startup)
    // it throws, and we fall back to "no rollback hook" rather than
    // letting the install-flow surface a misleading
    // "install-rollback failed" result to the user.
    try {
      mod.getPluginManager()
    } catch {
      return null
    }
    return (pluginId, reason) => mod.getPluginManager().rollbackInstallation(pluginId, reason)
  } catch {
    return null
  }
}

/** Disable only the named competitors. The manager refuses active dependents;
 * partial disable is restored before the failure is returned. */
export async function resolveConflictingPlugins(
  ids: string[],
  manager?: Pick<PluginManager, "getPlugin" | "acquirePluginInstallPause">,
  options: { deferred?: boolean } = {}
): Promise<PluginConflictResolution> {
  manager ??= (await import("../core/manager")).getPluginManager()
  const leases = new Map<string, PluginIntentPauseLease>()
  const settle = async (commit: boolean) => {
    const errors: unknown[] = []
    for (const lease of [...leases.values()].reverse()) {
      try {
        if (commit) await lease.commit()
        else await lease.restore()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "restoreFailed")
  }
  const restore: PluginConflictResolution = () => settle(false)
  restore.commit = () => settle(true)
  restore.pause = async () => {
    for (const lease of leases.values()) await lease.pause()
  }
  restore.isCurrent = (id) => leases.get(id)?.isCurrent() ?? false
  restore.willResume = (id) => leases.get(id)?.willResume() ?? false
  try {
    for (const id of new Set(ids)) {
      if (!manager.getPlugin(id)) continue
      leases.set(id, await manager.acquirePluginInstallPause(id, options))
    }
  } catch (error) {
    try {
      await restore()
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "restoreFailed")
    }
    throw error
  }
  return restore
}
