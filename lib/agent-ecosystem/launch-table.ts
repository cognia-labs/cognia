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
/** Loader and injection keys no descriptor may set, whatever it is for. */
const LOADER_ENV = /^(?:LD_|DYLD_|NODE_OPTIONS$|GCONV_PATH$|GIT_CONFIG_|HOSTALIASES$|NLSPATH$)/
const FLAG = /^--[a-z][a-z0-9-]*$/

function relativePathError(path: string): string | null {
  if (path === "" || path.startsWith("/") || path.startsWith("~") || path.includes("\\"))
    return "must be a relative path with forward slashes"
  if (path.split("/").some((part) => part === "" || part === "." || part === ".."))
    return "must not contain empty, `.` or `..` segments"
  return null
}

function validate(descriptor: EngineLaunchDescriptor, errors: string[]): void {
  const at = `launch descriptor "${descriptor.id}"`
  const { isolation, relocation, temp, companion, env, mcpConfigFile } = descriptor
  if (descriptor.match.values.length === 0) errors.push(`${at}: match has no values`)
  const paths: [string, readonly (string | undefined)[] | undefined][] = [
    ["stateRoots", descriptor.stateRoots],
    ["fileRoots", descriptor.fileRoots],
    ["isolation.sharedRoots", isolation?.sharedRoots],
    ["isolation.denyReadable", isolation?.denyReadable],
    ["isolation.env", isolation && Object.values(isolation.env)],
    ["relocation.default", [relocation?.default]],
    ["relocation.writable", relocation?.writable],
    ["relocation.temp", [relocation?.temp]],
    ["temp.home", [temp?.home]],
    ["temp.isolated.path", [temp?.isolated?.path]],
    ["hiddenFiles.home", descriptor.hiddenFiles?.home],
    ["hiddenFiles.searched", descriptor.hiddenFiles?.searched],
    ["programRoots", descriptor.programRoots],
    ["loginRoots", descriptor.loginRoots],
    ["mcpConfigFile.rootDefault", [mcpConfigFile?.rootDefault]],
    ["mcpConfigFile.privateCopy.home", mcpConfigFile?.privateCopy?.map((copy) => copy.home)],
    ["mcpConfigFile.privateCopy.state", mcpConfigFile?.privateCopy?.map((copy) => copy.state)],
  ]
  for (const [field, list] of paths) {
    for (const path of list ?? []) {
      if (path === undefined) continue
      const problem = relativePathError(path)
      if (problem) errors.push(`${at}: ${field} "${path}" ${problem}`)
    }
  }
  const stateRoots = new Set(descriptor.stateRoots ?? [])
  for (const file of descriptor.fileRoots ?? []) {
    if (!stateRoots.has(file)) errors.push(`${at}: file root "${file}" is not a state root`)
  }
  for (const root of isolation?.sharedRoots ?? []) {
    if (!stateRoots.has(root)) errors.push(`${at}: shared root "${root}" is not a state root`)
  }
  if (isolation && Object.keys(isolation.env).length === 0)
    errors.push(`${at}: isolation maps no env key into the private root`)
  if (relocation && relocation.env.length === 0 && !relocation.args)
    errors.push(`${at}: relocation names no env key or flag`)
  if (temp?.isolated && !(isolation && temp.isolated.env in isolation.env))
    errors.push(`${at}: temp.isolated.env "${temp.isolated.env}" is not an isolation env key`)
  const envKeys = [
    ...Object.keys(isolation?.env ?? {}),
    ...Object.keys(isolation?.setEnv ?? {}),
    ...(relocation?.env ?? []),
    ...Object.keys(relocation?.setEnv ?? {}),
    ...(companion ? [companion.env] : []),
    ...(env?.keys ?? []),
    ...(env?.privateBlank ?? []),
    ...(env?.secret ?? []),
    ...(mcpConfigFile ? [mcpConfigFile.rootEnv] : []),
  ]
  for (const key of envKeys) {
    if (!ENV_KEY.test(key) || LOADER_ENV.test(key))
      errors.push(`${at}: env key "${key}" is not an env name a descriptor may set`)
  }
  for (const prefix of [...(env?.prefixes ?? []), ...(env?.reviewedPrefixes ?? [])]) {
    if (!/^[A-Z][A-Z0-9_]*_$/.test(prefix) || LOADER_ENV.test(prefix))
      errors.push(`${at}: env prefix "${prefix}" is not an env family a descriptor may admit`)
  }
  if (env?.reviewedRequestOnly && !env.reviewedPrefixes?.length)
    errors.push(`${at}: env.reviewedRequestOnly needs reviewedPrefixes`)
  if (mcpConfigFile) {
    const { directory, serversFile, settingsFile, project } = mcpConfigFile
    for (const name of [
      directory,
      serversFile,
      settingsFile,
      project.directory,
      ...project.files,
    ]) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..")
        errors.push(`${at}: mcpConfigFile name "${name}" is not a file name`)
    }
    if (serversFile === settingsFile)
      errors.push(`${at}: mcpConfigFile writes its servers over its settings file`)
    for (const dotted of [...mcpConfigFile.privateKeep, ...Object.keys(mcpConfigFile.privateSet)]) {
      if (dotted.split(".").some((part) => !part))
        errors.push(`${at}: mcpConfigFile path "${dotted}" has an empty segment`)
    }
  }
  for (const name of descriptor.hiddenFiles?.searched ?? []) {
    if (name.includes("/")) errors.push(`${at}: searched file "${name}" is not a file name`)
  }
  for (const line of descriptor.stderrNoise ?? []) {
    if (line.length === 0 || line.some((part) => !part))
      errors.push(`${at}: a stderr noise entry needs nonempty substrings`)
  }
  for (const flag of [...(relocation?.args?.flags ?? []), ...(relocation?.refusedArgs ?? [])]) {
    if (!FLAG.test(flag)) errors.push(`${at}: flag "${flag}" is not a long option`)
  }
  if (companion && !/^[A-Za-z0-9._-]+$/.test(companion.sibling))
    errors.push(`${at}: companion "${companion.sibling}" is not a file name`)
  for (const args of Object.values(descriptor.platformArgs ?? {})) {
    for (const arg of args) {
      if (!FLAG.test(arg.split("=")[0]))
        errors.push(`${at}: platform argument "${arg}" is not a long option`)
    }
  }
}

function normalize(descriptor: EngineLaunchDescriptor): EngineLaunchDescriptor {
  const { isolation } = descriptor
  return {
    ...descriptor,
    ...(isolation && {
      isolation: {
        env: isolation.env,
        ...(isolation.setEnv && { setEnv: isolation.setEnv }),
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
