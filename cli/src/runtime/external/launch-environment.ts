/**
 * What a launch inherits from the Host's own environment (ADR-0243 3C), the
 * twin of `crates/cognia-external-agent/src/launch_environment.rs`. The table
 * is `launchEnvironment` in `protocol/external-agent-security-policy.json`;
 * the engine keys come from the launch descriptors.
 */

import { EXTERNAL_AGENT_LAUNCH_ENVIRONMENT as TABLE } from "@/lib/ai/agent/external/policy/security-policy"

import { admitsRequestEnv } from "./launch-descriptor"

/**
 * - `owner`: the local person's own run.
 * - `isolated`: an isolated launch (`COGNIA_ENGINE_PROFILE`): the essentials
 *   and the session keys that carry no credential. Its state, temp and cache
 *   roots come from its private state root, and it always runs with
 *   {@link ISOLATED_SET}.
 * - `essential`: a brokered launch (a gateway task), which gets its home and
 *   credentials from the Host.
 * - `none`: a runtime that builds its whole environment itself (DSH).
 */
export type LaunchInheritance = "owner" | "isolated" | "essential" | "none"

/** Loader and injection keys, refused from every source. */
const DANGEROUS_ENV =
  /^(?:LD_|DYLD_|NODE_OPTIONS$|GCONV_PATH$|GIT_CONFIG_|HOSTALIASES$|NLSPATH$|RESOLV_HOST_CONF$|PSMODULEPATH$|PSEXECUTIONPOLICYPREFERENCE$)/i

/** Windows env keys are case-insensitive (`SystemRoot`, `Path`). */
const normal = (key: string) => (process.platform === "win32" ? key.toUpperCase() : key)
const ESSENTIAL = new Set(TABLE.essentialKeys.map(normal))
const OWNER = new Set(
  [...TABLE.essentialKeys, ...TABLE.sessionKeys, ...TABLE.ownerKeys].map(normal)
)
const ISOLATED = new Set([...TABLE.essentialKeys, ...TABLE.isolatedKeys].map(normal))
const CONFIG = new Set(TABLE.configKeys)

/** The fixed env every isolated launch runs with, over its request env. */
export const ISOLATED_SET: Readonly<Record<string, string>> = TABLE.isolatedSet

export function isDangerousEnvKey(key: string): boolean {
  return DANGEROUS_ENV.test(key)
}

/** A request env key the host admits: its own configuration or one an engine reads. */
export function admitsRequestKey(key: string): boolean {
  return (
    !isDangerousEnvKey(key) &&
    (CONFIG.has(key) ||
      TABLE.configPrefixes.some((prefix) => key.startsWith(prefix)) ||
      admitsRequestEnv(key))
  )
}

/** The part of `ambient` a launch inherits; the request env goes on top. */
export function inheritedEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  inheritance: LaunchInheritance
): Record<string, string> {
  const inherited: Record<string, string> = {}
  if (inheritance === "none") return inherited
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined || isDangerousEnvKey(key) || key.startsWith("COGNIA_")) continue
    const kept =
      inheritance === "essential"
        ? ESSENTIAL.has(normal(key))
        : inheritance === "isolated"
          ? ISOLATED.has(normal(key))
          : OWNER.has(normal(key)) ||
            TABLE.ownerPrefixes.some((prefix) => key.startsWith(prefix)) ||
            admitsRequestKey(key)
    if (kept) inherited[key] = value
  }
  return inherited
}
