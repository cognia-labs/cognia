/**
 * The engine launch table (ADR-0217): every launch descriptor the integration
 * packages declare, validated and normalized into the one file both process
 * hosts read, `protocol/external-agent-launch.json`.
 * `scripts/build/gen-external-agent-launch.mjs` writes it and `--check` fails
 * on drift, so a descriptor is edited only in its package.
 *
 * Validation is where a careless descriptor fails instead of reaching a host:
 * every path is home- or root-relative with no `..`, every file root is a
 * state root, and every isolation env key maps inside the private root.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { EngineLaunchDescriptor } from "@cognia/agent-contracts/engine-launch"

/** The persisted file. Its descriptors carry every default resolved. */
export interface EngineLaunchTableFile {
  description: string
  engines: EngineLaunchDescriptor[]
}

export const ENGINE_LAUNCH_TABLE_DESCRIPTION =
  "Engine launch descriptors (ADR-0217), generated from the integration packages by " +
  "scripts/build/gen-external-agent-launch.mjs; edit the descriptor in its package. " +
  "Both process hosts (crates/cognia-external-agent, cli/src/runtime/external) read this " +
  "file and name no engine themselves. A launch matches by its target: for `npx <package>` " +
  "the package, otherwise the executable file name without a Windows suffix, lower-cased."

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/

function relativePathError(path: string): string | null {
  if (path === "" || path.startsWith("/") || path.startsWith("~") || path.includes("\\"))
    return "must be a relative path with forward slashes"
  if (path.split("/").some((part) => part === "" || part === "." || part === ".."))
    return "must not contain empty, `.` or `..` segments"
  return null
}

function validate(descriptor: EngineLaunchDescriptor, errors: string[]): void {
  const at = `launch descriptor "${descriptor.id}"`
  if (descriptor.match.values.length === 0) errors.push(`${at}: match has no values`)
  const paths: [string, readonly string[] | undefined][] = [
    ["stateRoots", descriptor.stateRoots],
    ["fileRoots", descriptor.fileRoots],
    ["isolation.sharedRoots", descriptor.isolation?.sharedRoots],
    ["isolation.denyReadable", descriptor.isolation?.denyReadable],
    ["isolation.env", descriptor.isolation && Object.values(descriptor.isolation.env)],
  ]
  for (const [field, list] of paths) {
    for (const path of list ?? []) {
      const problem = relativePathError(path)
      if (problem) errors.push(`${at}: ${field} "${path}" ${problem}`)
    }
  }
  const stateRoots = new Set(descriptor.stateRoots ?? [])
  for (const file of descriptor.fileRoots ?? []) {
    if (!stateRoots.has(file)) errors.push(`${at}: file root "${file}" is not a state root`)
  }
  for (const root of descriptor.isolation?.sharedRoots ?? []) {
    if (!stateRoots.has(root)) errors.push(`${at}: shared root "${root}" is not a state root`)
  }
  for (const key of Object.keys(descriptor.isolation?.env ?? {})) {
    if (!ENV_KEY.test(key)) errors.push(`${at}: isolation env key "${key}" is not an env name`)
  }
  if (descriptor.isolation && Object.keys(descriptor.isolation.env).length === 0)
    errors.push(`${at}: isolation maps no env key into the private root`)
}

function normalize(descriptor: EngineLaunchDescriptor): EngineLaunchDescriptor {
  const { isolation } = descriptor
  return {
    ...descriptor,
    ...(isolation && {
      isolation: {
        env: isolation.env,
        sharedRoots: isolation.sharedRoots ?? descriptor.stateRoots ?? [],
        denyReadable: isolation.denyReadable,
      },
    }),
  }
}

/**
 * The table, in declaration order: integration manifests, then the ACP
 * package's engines, then the host's own launch runners. Throws with every
 * problem when a descriptor is invalid or two share an id.
 */
export function buildEngineLaunchTable(
  manifests: readonly AgentIntegrationManifest[],
  ...descriptorLists: readonly (readonly EngineLaunchDescriptor[])[]
): EngineLaunchTableFile {
  const engines = [
    ...manifests.flatMap((manifest) => manifest.launch ?? []),
    ...descriptorLists.flat(),
  ]
  const errors: string[] = []
  const seen = new Set<string>()
  for (const descriptor of engines) {
    if (seen.has(descriptor.id))
      errors.push(`launch descriptor "${descriptor.id}" is declared twice`)
    seen.add(descriptor.id)
    validate(descriptor, errors)
  }
  if (errors.length) throw new Error(errors.join("\n"))
  return { description: ENGINE_LAUNCH_TABLE_DESCRIPTION, engines: engines.map(normalize) }
}
