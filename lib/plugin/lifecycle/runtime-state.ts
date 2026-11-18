/**
 * The runtime state a package operation (update, rollback, replacement) must
 * hand back once it is done with the package underneath a plugin.
 *
 * Every such operation stops the plugin before it touches the package and
 * brings it back afterwards. Bringing it back with a blanket enable turns a
 * plugin that was only loaded, or idle-suspended, into a fully active one; and
 * an operation that fails before the package changed must put back exactly
 * what was running, not leave it stopped. Both need one record of what was
 * live, taken before teardown, and one way to return to it.
 */

import type { PluginStatus } from "@/types/plugin"

/** What was live before teardown, in the terms the lifecycle can restore. */
export type RuntimeResumeState = "enabled" | "suspended" | "loaded" | "stopped"

/**
 * Classify a store status. A transition in progress counts as its target:
 * the lifecycle lock serializes it ahead of the teardown that follows.
 */
export function runtimeResumeStateOf(
  status: PluginStatus | string | undefined
): RuntimeResumeState {
  switch (status) {
    case "enabled":
    case "enabling":
      return "enabled"
    case "suspended":
      return "suspended"
    case "loaded":
    case "loading":
      return "loaded"
    default:
      return "stopped"
  }
}

/** The lifecycle methods these helpers drive; `PluginManager` satisfies it. */
export interface RuntimeStateOwner {
  enablePlugin(pluginId: string, reason?: string): Promise<void>
  disablePlugin(pluginId: string, reason?: string): Promise<void>
  suspendPlugin(pluginId: string, reason?: string): Promise<void>
  loadPlugin(pluginId: string): Promise<void>
  unloadPlugin(pluginId: string): Promise<void>
}

/** Stop whatever `state` says is running, so the package can be replaced. */
export async function quiesceRuntime(
  owner: RuntimeStateOwner,
  pluginId: string,
  state: RuntimeResumeState,
  reason: string
): Promise<void> {
  if (state === "stopped") return
  if (state === "enabled" || state === "suspended") await owner.disablePlugin(pluginId, reason)
  await owner.unloadPlugin(pluginId)
}

/** Bring a stopped plugin back to `state`, through the normal lifecycle. */
export async function restoreRuntimeState(
  owner: RuntimeStateOwner,
  pluginId: string,
  state: RuntimeResumeState,
  reason: string
): Promise<void> {
  switch (state) {
    case "enabled":
      await owner.enablePlugin(pluginId, reason)
      return
    case "suspended":
      // A suspended plugin is enabled in intent; suspension tears its
      // contributions down again, as the idle sweep would have.
      await owner.enablePlugin(pluginId, reason)
      await owner.suspendPlugin(pluginId, reason)
      return
    case "loaded":
      await owner.loadPlugin(pluginId)
      return
    case "stopped":
      return
  }
}
