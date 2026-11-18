/**
 * Measure the toolchain a Sites build runs with, inside the same sandbox.
 *
 * The build form's runtime and package manager (`node@24`, `pnpm@10`) were
 * only ever written into the version record: the confined build ran whatever
 * `node` and `pnpm` the sandbox's PATH resolved. A version could therefore say
 * `node@24` after a build on Node 20, which is provenance that lies.
 *
 * Before a version is drafted, each tool is asked for `--version` through the
 * confined runner. A requested major that the sandbox does not provide fails
 * the build; what was measured is recorded next to what was asked for.
 */
import type { ConfinedSiteBuildInput, ConfinedSiteBuildResult } from "./confined-build"

export interface SiteToolchainSpec {
  /** The command the build calls, e.g. `node`, `pnpm`. */
  tool: string
  /** The requested major version, when the spec pins one (`node@24`). */
  major?: number
}

const TOOL = /^[a-z][a-z0-9-]*$/

/**
 * Parse `node@24` / `pnpm@10` / `bun`. The picker accepts custom strings, so
 * anything that is not a plain command name with an optional numeric major is
 * refused here rather than handed to the sandbox as argv[0].
 */
export function parseSiteToolchainSpec(spec: string, label: string): SiteToolchainSpec {
  const [tool = "", version, ...rest] = spec.trim().split("@")
  if (!TOOL.test(tool) || rest.length > 0) {
    throw new Error(`${label} must be a command name with an optional major version: ${spec}`)
  }
  if (version === undefined) return { tool }
  const major = /^(\d+)(?:\.\d+){0,2}$/.exec(version)?.[1]
  if (!major) throw new Error(`${label} version must start with a major number: ${spec}`)
  return { tool, major: Number(major) }
}

/** `v24.3.0\n` → `24.3.0`. The first semver-shaped token wins. */
export function parseToolVersion(output: string): string | undefined {
  return /v?(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1]
}

export interface MeasureSiteToolchainInput {
  runtime: string
  packageManager: string
  /** The sandbox the build phases use: same cwd and roots. */
  sandbox: Pick<ConfinedSiteBuildInput, "cwd" | "writableRoots" | "readableRoots">
  /**
   * Hosts the package-manager probe may reach — the install phase's. A
   * Corepack shim answers `--version` by fetching the pinned release, so the
   * probe gets exactly the allowance the install phase would.
   */
  packageManagerNetworkHosts?: string[]
}

export interface MeasuredSiteToolchain {
  runtime: string
  packageManager: string
}

async function measureOne(
  spec: SiteToolchainSpec,
  label: string,
  input: MeasureSiteToolchainInput,
  networkHosts: string[] | undefined,
  run: (input: ConfinedSiteBuildInput) => Promise<ConfinedSiteBuildResult>
): Promise<string> {
  let result: ConfinedSiteBuildResult
  try {
    result = await run({
      argv: [spec.tool, "--version"],
      ...input.sandbox,
      networkHosts,
      timeoutSeconds: 60,
      maxCpuSeconds: 60,
      maxOutputBytes: 64 * 1024,
    })
  } catch (error) {
    throw new Error(
      `Could not run ${spec.tool} in the build sandbox: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  if (result.timedOut || result.exitCode !== 0) {
    const detail = result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.exitCode}`
    throw new Error(`${label} ${spec.tool} is not available in the build sandbox (${detail})`)
  }
  const version = parseToolVersion(result.stdout) ?? parseToolVersion(result.stderr)
  if (!version) {
    throw new Error(`${label} ${spec.tool} printed no version: ${result.stdout.trim()}`)
  }
  const major = Number(version.split(".")[0])
  if (spec.major !== undefined && major !== spec.major) {
    throw new Error(
      `${label} ${spec.tool}@${spec.major} was requested, but the build sandbox runs ${spec.tool} ${version}`
    )
  }
  return `${spec.tool}@${version}`
}

export async function measureSiteToolchain(
  input: MeasureSiteToolchainInput,
  run: (input: ConfinedSiteBuildInput) => Promise<ConfinedSiteBuildResult>
): Promise<MeasuredSiteToolchain> {
  const runtime = parseSiteToolchainSpec(input.runtime, "Build runtime")
  const packageManager = parseSiteToolchainSpec(input.packageManager, "Package manager")
  return {
    runtime: await measureOne(runtime, "Build runtime", input, undefined, run),
    packageManager: await measureOne(
      packageManager,
      "Package manager",
      input,
      input.packageManagerNetworkHosts,
      run
    ),
  }
}
