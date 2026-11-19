/**
 * Replace the package under one or more plugins, the way ADR-0258 says every
 * environment must: stop what is running, swap the package, register the
 * manifest now on disk, and bring each plugin back to the state it was in.
 *
 * The CLI update (`cli/src/plugin/host.ts` `replaceDiskPlugin`), the headless
 * Host's reconcile (`cli/src/serve/plugin-runtime-adapter.ts`), the package
 * changes a paired device asks a Host for
 * (`lib/plugin/lifecycle/host-package-change.ts`) and a cogpack carried to a
 * Host (`lib/plugin/cogpack/transfer-install.ts`) all run through here, so
 * they cannot disagree about what "the state it was in" means:
 *
 * - a plugin's runtime state is read before teardown and restored afterwards
 *   (`runtime-state.ts`), never replaced by a blanket enable;
 * - a plugin whose durable intent is `disabled` is never started, whatever it
 *   was doing;
 * - a plugin that was not installed before comes up in `whenNew` (stopped
 *   unless the caller says otherwise);
 * - a commit that fails leaves every package where it was and puts back
 *   exactly what was running.
 */

import type { PluginGraphReservation } from "@/lib/plugin/core/lifecycle-coordinator"
import type { PluginIntent } from "@/lib/plugin/core/lifecycle-state"
import type { PluginStatus } from "@/types/plugin"

import {
  quiesceRuntime,
  restoreRuntimeState,
  runtimeResumeStateOf,
  type RuntimeResumeState,
  type RuntimeStateOwner,
} from "./runtime-state"

/** What a replacement needs from the plugin manager. `PluginManager` satisfies it through {@link packageOwnerOf}. */
export interface PackageReplacementOwner extends RuntimeStateOwner {
  /** The plugin's status in the runtime store; `undefined` when it is not installed. */
  statusOf(pluginId: string): PluginStatus | string | undefined
  /** The plugin's durable intent, when the host records one. */
  intentOf?(pluginId: string): Promise<PluginIntent | undefined>
  reservePluginRuntimeGraph(pluginId: string): PluginGraphReservation
  releasePluginRuntimeGraph(reservation: PluginGraphReservation): unknown
  /** Serialize package I/O with activation of the same plugin. */
  withPluginPackageMutation<T>(pluginId: string, operation: () => Promise<T>): Promise<T>
}

export interface PackageReplacementRequest<T> {
  /** Every plugin the commit may replace. */
  pluginIds: readonly string[]
  /** Swap the packages on disk. Runs with every listed plugin stopped. */
  commit: () => Promise<T>
  /** Which plugins the commit replaced; the rest keep their old package. Defaults to all. */
  replaced?: (result: T) => readonly string[]
  /** Make the manager hold the manifest now on disk for `pluginId`. */
  register: (pluginId: string, result: T) => Promise<void>
  /** The state a plugin that was not installed before comes up in. */
  whenNew?: RuntimeResumeState
  /** Lifecycle reason recorded for the stop and the restart. */
  reason: string
}

export interface PackageReplacementOutcome<T> {
  result: T
  /** The state each replaced plugin was brought to. */
  runtime: Record<string, RuntimeResumeState>
  /**
   * Plugins whose package changed but which could not be registered or
   * restarted. Their runtime is left stopped; the caller reports them.
   */
  failures: Array<{ pluginId: string; error: unknown }>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface Prior {
  pluginId: string
  status: PluginStatus | string | undefined
  running: RuntimeResumeState
  target: RuntimeResumeState
}

async function priorOf(
  owner: PackageReplacementOwner,
  pluginId: string,
  whenNew: RuntimeResumeState
): Promise<Prior> {
  const status = owner.statusOf(pluginId)
  const running = runtimeResumeStateOf(status)
  const intent = await owner.intentOf?.(pluginId)
  const target = intent === "disabled" ? "stopped" : status === undefined ? whenNew : running
  return { pluginId, status, running, target }
}

/** Run `operation` holding every plugin's package lock, in a stable order. */
function withPackageLocks<T>(
  owner: PackageReplacementOwner,
  pluginIds: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  return [...pluginIds]
    .sort()
    .reduceRight<
      () => Promise<T>
    >((inner, pluginId) => () => owner.withPluginPackageMutation(pluginId, inner), operation)()
}

/** Replace several plugins' packages in one commit. */
export async function replacePluginPackages<T>(
  owner: PackageReplacementOwner,
  request: PackageReplacementRequest<T>
): Promise<PackageReplacementOutcome<T>> {
  const pluginIds = [...new Set(request.pluginIds)]
  const whenNew = request.whenNew ?? "stopped"
  const priors: Prior[] = []
  for (const pluginId of pluginIds) priors.push(await priorOf(owner, pluginId, whenNew))
  const reservations = priors
    .filter((prior) => prior.status !== undefined)
    .map((prior) => owner.reservePluginRuntimeGraph(prior.pluginId))
  const restoreRunning = async (subset: Prior[]): Promise<unknown[]> => {
    const errors: unknown[] = []
    for (const prior of subset) {
      try {
        await restoreRuntimeState(owner, prior.pluginId, prior.running, `${request.reason}-restore`)
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
  }
  try {
    for (const prior of priors) {
      await quiesceRuntime(owner, prior.pluginId, prior.running, request.reason)
      // A disabled plugin is inactive but still loaded from the old tree.
      if (prior.status === "disabled") await owner.unloadPlugin(prior.pluginId)
    }
    let result: T
    try {
      result = await withPackageLocks(owner, pluginIds, request.commit)
    } catch (error) {
      const restoreErrors = await restoreRunning(priors)
      if (restoreErrors.length > 0) {
        throw new AggregateError(
          [error, ...restoreErrors],
          `${messageOf(error)}; restoring the previous runtime also failed: ${restoreErrors.map(messageOf).join("; ")}`
        )
      }
      throw error
    }

    const replaced = new Set(request.replaced ? request.replaced(result) : pluginIds)
    const runtime: Record<string, RuntimeResumeState> = {}
    const failures: PackageReplacementOutcome<T>["failures"] = []
    for (const prior of priors) {
      if (!replaced.has(prior.pluginId)) continue
      try {
        await request.register(prior.pluginId, result)
        await restoreRuntimeState(owner, prior.pluginId, prior.target, request.reason)
        runtime[prior.pluginId] = prior.target
      } catch (error) {
        failures.push({ pluginId: prior.pluginId, error })
      }
    }
    // A plugin the commit left alone still has its old package: put back what
    // was running.
    const untouched = priors.filter((prior) => !replaced.has(prior.pluginId))
    for (const [index, error] of (await restoreRunning(untouched)).entries()) {
      failures.push({ pluginId: untouched[index]?.pluginId ?? "", error })
    }
    return { result, runtime, failures }
  } finally {
    for (const reservation of reservations) owner.releasePluginRuntimeGraph(reservation)
  }
}

/**
 * Replace one plugin's package. A failure after the commit is thrown as it
 * came, with the new package in place; the caller decides how to report it.
 */
export async function replacePluginPackage<T>(
  owner: PackageReplacementOwner,
  request: Omit<PackageReplacementRequest<T>, "pluginIds" | "replaced" | "register"> & {
    pluginId: string
    register: (result: T) => Promise<void>
  }
): Promise<{ result: T; runtime: RuntimeResumeState }> {
  const outcome = await replacePluginPackages(owner, {
    pluginIds: [request.pluginId],
    commit: request.commit,
    register: (_pluginId, result) => request.register(result),
    whenNew: request.whenNew,
    reason: request.reason,
  })
  const failure = outcome.failures[0]
  if (failure) throw failure.error
  return { result: outcome.result, runtime: outcome.runtime[request.pluginId] ?? "stopped" }
}

/** The plugin manager as a {@link PackageReplacementOwner}. */
export function packageOwnerOf(manager: {
  getPlugin(pluginId: string): { status: PluginStatus } | undefined
  getPluginLifecycleState(pluginId: string): Promise<{ intent: PluginIntent }>
  enablePlugin(pluginId: string, reason?: string): Promise<void>
  disablePlugin(pluginId: string, reason?: string): Promise<void>
  suspendPlugin(pluginId: string, reason?: string): Promise<void>
  loadPlugin(pluginId: string): Promise<void>
  unloadPlugin(pluginId: string): Promise<void>
  reservePluginRuntimeGraph(pluginId: string): PluginGraphReservation
  releasePluginRuntimeGraph(reservation: PluginGraphReservation): unknown
  withPluginPackageMutation<T>(pluginId: string, operation: () => Promise<T>): Promise<T>
}): PackageReplacementOwner {
  return {
    statusOf: (pluginId) => manager.getPlugin(pluginId)?.status,
    intentOf: async (pluginId) => (await manager.getPluginLifecycleState(pluginId)).intent,
    enablePlugin: (pluginId, reason) => manager.enablePlugin(pluginId, reason),
    disablePlugin: (pluginId, reason) => manager.disablePlugin(pluginId, reason),
    suspendPlugin: (pluginId, reason) => manager.suspendPlugin(pluginId, reason),
    loadPlugin: (pluginId) => manager.loadPlugin(pluginId),
    unloadPlugin: (pluginId) => manager.unloadPlugin(pluginId),
    reservePluginRuntimeGraph: (pluginId) => manager.reservePluginRuntimeGraph(pluginId),
    releasePluginRuntimeGraph: (reservation) => manager.releasePluginRuntimeGraph(reservation),
    withPluginPackageMutation: (pluginId, operation) =>
      manager.withPluginPackageMutation(pluginId, operation),
  }
}
