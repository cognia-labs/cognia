/**
 * Typed access to `protocol/external-agent-launch.json`, the engine launch
 * table the integration packages declare (ADR-0217,
 * `lib/agent-ecosystem/launch-table.ts`). The renderer, the launch path and
 * the CLI host read state roots and isolation here; nothing in the host names
 * an engine.
 */

import type { EngineLaunchDescriptor } from "@cognia/agent-contracts/engine-launch"
import { descriptorsFor } from "@cognia/agent-contracts/engine-launch"
import TABLE from "@/protocol/external-agent-launch.json"

export const ENGINE_LAUNCH_DESCRIPTORS: readonly EngineLaunchDescriptor[] = (
  TABLE as unknown as { engines: EngineLaunchDescriptor[] }
).engines

/** How a launch's state moves into its private root (ADR-0216), merged over every matching engine. */
export interface ResolvedAgentStateIsolation {
  env: Record<string, string>
  sharedRoots: string[]
  denyReadable: string[]
}

function pushUnique(into: string[], values: readonly string[] | undefined): void {
  for (const value of values ?? []) if (!into.includes(value)) into.push(value)
}

/**
 * The home-relative state roots a launch must be able to write. `npx
 * <package>` runs the package, so both the runner's and the package's roots
 * apply.
 */
export function agentStateWritableRoots(command: string, args: readonly string[] = []): string[] {
  const roots: string[] = []
  for (const descriptor of descriptorsFor(ENGINE_LAUNCH_DESCRIPTORS, command, args))
    pushUnique(roots, descriptor.stateRoots)
  return roots
}

/** The subset of `agentStateWritableRoots` that are files rather than directories. */
export function agentStateFileRoots(command: string, args: readonly string[] = []): string[] {
  const roots: string[] = []
  for (const descriptor of descriptorsFor(ENGINE_LAUNCH_DESCRIPTORS, command, args))
    pushUnique(roots, descriptor.fileRoots)
  return roots
}

/**
 * The isolation for a launch, or `null` when no matching engine documents a
 * home variable, so the launch cannot get a private state root.
 */
export function agentStateIsolationFor(
  command: string,
  args: readonly string[] = []
): ResolvedAgentStateIsolation | null {
  let resolved: ResolvedAgentStateIsolation | null = null
  for (const { isolation } of descriptorsFor(ENGINE_LAUNCH_DESCRIPTORS, command, args)) {
    if (!isolation) continue
    resolved ??= { env: {}, sharedRoots: [], denyReadable: [] }
    Object.assign(resolved.env, isolation.env)
    pushUnique(resolved.sharedRoots, isolation.sharedRoots)
    pushUnique(resolved.denyReadable, isolation.denyReadable)
  }
  return resolved
}
