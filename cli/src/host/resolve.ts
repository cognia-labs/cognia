/**
 * Which host a command talks to, and why.
 *
 * Precedence, high to low:
 *   1. `--endpoint` / `--host` / `--profile` on the command line
 *   2. environment (`COGNIA_ENDPOINT`, `COGNIA_SERVER_URL`, `COGNIA_SERVICE_TOKEN`,
 *      `COGNIA_LOCAL_DEBUG_TOKEN`, `COGNIA_PROFILE`)
 *   3. `./.cognia/hosts.json` in the working directory
 *   4. `<cli home>/hosts.json`
 *   5. a Cognia desktop discovered on loopback
 *
 * Merging is per key, so a project file can pin the endpoint while the token
 * still comes from the environment. Every resolved value carries the source
 * that won, because `host show` printing "where did this come from" is the
 * thing that turns a confusing 401 into a one-line fix.
 *
 * A host named explicitly (`--host`, `--profile` or `COGNIA_PROFILE`) is the
 * exception: the person picked that record, so it is used whole. A name no
 * record carries resolves nothing instead of falling through to whatever the
 * environment points at; the environment's endpoint and token do not replace
 * the record's; and only `--endpoint` can point it elsewhere, which drops the
 * record's credentials exactly as for an unnamed host.
 *
 * A paired device identity belongs to the one tenant it was paired into, so a
 * `--tenant` or `COGNIA_TENANT_ID` naming another one is refused rather than
 * sent with that device's key.
 */

import type { HostKind, HostRecord, HostsFile } from "./store"
import {
  normalizeEndpoint,
  readHostsFile,
  hostsPath,
  projectHostsPath,
  type HostsFs,
} from "./store"

export type HostValueSource =
  "flag" | "env" | "project-file" | "user-file" | "desktop-bridge" | "default"

export interface ResolvedValue<T> {
  value: T
  source: HostValueSource
  /** The precise origin, e.g. the env var name or the file path. */
  origin?: string
}

export interface ResolvedHost {
  name?: string
  /** How the name was chosen, for `host show`. */
  nameSource?: ResolvedValue<string>
  kind: ResolvedValue<HostKind>
  endpoint: ResolvedValue<string>
  tenantId?: ResolvedValue<string>
  serviceToken?: ResolvedValue<string>
  record?: HostRecord
}

export interface HostResolutionInput {
  /** `--endpoint`. */
  endpoint?: string
  /** `--host` or `--profile`, both naming a saved record. */
  profile?: string
  /** `--tenant`. */
  tenantId?: string
  env?: Record<string, string | undefined>
  home: string
  cwd: string
  fs?: HostsFs
}

export interface HostResolution {
  host?: ResolvedHost
  /** Why nothing resolved, and the legs that were considered. */
  skipped: Array<{ leg: string; reason: string }>
  /**
   * The inputs contradict each other (a tenant that is not the paired
   * device's). Nothing resolves, and this says why.
   */
  conflict?: { error: string; fix: string[] }
}

export function loadHostsLayers(input: Pick<HostResolutionInput, "home" | "cwd" | "fs">): {
  user: HostsFile
  userPath: string
  project: HostsFile
  projectPath: string
} {
  const userPath = hostsPath(input.home)
  const projectPath = projectHostsPath(input.cwd)
  return {
    user: readHostsFile(userPath, input.fs),
    userPath,
    project: readHostsFile(projectPath, input.fs),
    projectPath,
  }
}

/**
 * Merge the two files. A project record wins over a user record of the same
 * name outright rather than field by field: half a device identity spliced
 * onto another host's endpoint would be a credential sent to the wrong place.
 */
export function mergeHosts(user: HostsFile, project: HostsFile): HostsFile {
  const hosts = { ...user.hosts, ...project.hosts }
  // Take the first active name that a surviving record backs. A project file
  // naming a host it did not define must not silently unset the user's active
  // host, which would turn every later command into "no host configured".
  const active = [project.active, user.active].find((name) => name !== undefined && hosts[name])
  return { version: 1, ...(active ? { active } : {}), hosts }
}

function envEndpoint(
  env: Record<string, string | undefined>
): { value: string; name: string } | undefined {
  for (const name of ["COGNIA_ENDPOINT", "COGNIA_SERVER_URL"]) {
    const value = env[name]?.trim()
    if (value) return { value: normalizeEndpoint(value), name }
  }
  return undefined
}

function envToken(
  env: Record<string, string | undefined>
): { value: string; name: string } | undefined {
  for (const name of ["COGNIA_SERVICE_TOKEN", "COGNIA_LOCAL_DEBUG_TOKEN"]) {
    const value = env[name]?.trim()
    if (value) return { value, name }
  }
  return undefined
}

export function resolveHost(input: HostResolutionInput): HostResolution {
  const env = input.env ?? process.env
  const skipped: HostResolution["skipped"] = []
  const layers = loadHostsLayers(input)
  const merged = mergeHosts(layers.user, layers.project)

  const envProfile = env.COGNIA_PROFILE?.trim()
  const requestedName = input.profile ?? envProfile
  const named = requestedName !== undefined && requestedName.length > 0

  let record: HostRecord | undefined
  let name: string | undefined
  if (named) {
    record = merged.hosts[requestedName]
    if (!record) {
      const known = Object.keys(merged.hosts)
      skipped.push({
        leg: "named host",
        reason:
          known.length > 0
            ? `no host named "${requestedName}" (known: ${known.join(", ")})`
            : `no host named "${requestedName}" and no hosts are saved`,
      })
      // An explicit name that matches nothing is a mistake to report, never
      // a reason to use whatever host the environment points at.
      return { skipped }
    }
    name = requestedName
  } else if (merged.active) {
    record = merged.hosts[merged.active]
    name = merged.active
  }

  const recordSource: HostValueSource =
    name && layers.project.hosts[name] ? "project-file" : "user-file"
  const recordOrigin = recordSource === "project-file" ? layers.projectPath : layers.userPath
  const nameSource: ResolvedValue<string> | undefined = name
    ? input.profile
      ? { value: name, source: "flag", origin: "--host" }
      : named
        ? { value: name, source: "env", origin: "COGNIA_PROFILE" }
        : {
            value: name,
            source: layers.project.active === name ? "project-file" : "user-file",
            origin:
              layers.project.active === name
                ? `active in ${layers.projectPath}`
                : `active in ${layers.userPath}`,
          }
    : undefined

  const flagEndpoint = input.endpoint ? normalizeEndpoint(input.endpoint) : undefined
  const fromEnv = envEndpoint(env)

  let endpoint: ResolvedValue<string> | undefined
  if (flagEndpoint) endpoint = { value: flagEndpoint, source: "flag", origin: "--endpoint" }
  else if (named && record)
    endpoint = { value: record.endpoint, source: recordSource, origin: recordOrigin }
  else if (fromEnv) endpoint = { value: fromEnv.value, source: "env", origin: fromEnv.name }
  else if (record) endpoint = { value: record.endpoint, source: recordSource, origin: recordOrigin }

  if (!endpoint) {
    if (!requestedName && !merged.active) {
      skipped.push({
        leg: "saved host",
        reason: "no active host is configured",
      })
    }
    skipped.push({
      leg: "environment",
      reason: "neither COGNIA_ENDPOINT nor COGNIA_SERVER_URL is set",
    })
    return { skipped }
  }

  const tokenFromEnv = envToken(env)
  // An explicit `--endpoint` points somewhere the saved record may not
  // describe, so its token is only reused when the endpoints agree. Sending a
  // host's token to a different host would be the worst kind of convenience.
  const recordMatchesEndpoint = record && record.endpoint === endpoint.value
  // A named record's own credential is not replaced by an ambient one: the
  // environment fills in a token only for a record that carries none.
  const recordToken = recordMatchesEndpoint ? record?.serviceToken : undefined
  let serviceToken: ResolvedValue<string> | undefined
  if (named && recordToken) {
    serviceToken = { value: recordToken, source: recordSource, origin: recordOrigin }
  } else if (tokenFromEnv) {
    serviceToken = { value: tokenFromEnv.value, source: "env", origin: tokenFromEnv.name }
  } else if (recordToken) {
    serviceToken = { value: recordToken, source: recordSource, origin: recordOrigin }
  }

  const kindValue: HostKind = recordMatchesEndpoint && record ? record.kind : "headless"
  const kind: ResolvedValue<HostKind> = recordMatchesEndpoint
    ? { value: kindValue, source: recordSource, origin: recordOrigin }
    : { value: "headless", source: "default", origin: "no saved host matches this endpoint" }

  const pairedTenant =
    recordMatchesEndpoint && record?.kind === "device" && record.deviceId
      ? record.tenantId
      : undefined
  const overrideTenant = input.tenantId ?? (env.COGNIA_TENANT_ID?.trim() || undefined)
  if (pairedTenant && overrideTenant && overrideTenant !== pairedTenant) {
    return {
      skipped,
      conflict: {
        error:
          `host ${name ?? endpoint.value} is a device paired into tenant ${pairedTenant}; ` +
          `${input.tenantId ? "--tenant" : "COGNIA_TENANT_ID"} names ${overrideTenant}`,
        fix: [
          input.tenantId ? "drop --tenant" : "unset COGNIA_TENANT_ID",
          `or pair a device into ${overrideTenant}: cognia-agent host login <name> --invitation 'cgnp4|…'`,
        ],
      },
    }
  }
  const tenantValue =
    input.tenantId ??
    env.COGNIA_TENANT_ID?.trim() ??
    (recordMatchesEndpoint ? record?.tenantId : undefined)
  const tenantId: ResolvedValue<string> | undefined = tenantValue
    ? {
        value: tenantValue,
        source: input.tenantId ? "flag" : env.COGNIA_TENANT_ID?.trim() ? "env" : recordSource,
        origin: input.tenantId
          ? "--tenant"
          : env.COGNIA_TENANT_ID?.trim()
            ? "COGNIA_TENANT_ID"
            : recordOrigin,
      }
    : undefined

  return {
    host: {
      ...(name ? { name } : {}),
      ...(nameSource ? { nameSource } : {}),
      kind,
      endpoint,
      ...(tenantId ? { tenantId } : {}),
      ...(serviceToken ? { serviceToken } : {}),
      ...(recordMatchesEndpoint && record ? { record } : {}),
    },
    skipped,
  }
}

/** Flat rows for `host show`, one per resolved value with its source. */
export function describeResolution(host: ResolvedHost): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = []
  const push = (key: string, resolved?: ResolvedValue<string>) => {
    if (!resolved) return
    rows.push({
      key,
      value: resolved.value,
      source: resolved.source,
      origin: resolved.origin ?? "",
    })
  }
  if (host.name)
    rows.push({
      key: "host",
      value: host.name,
      source: host.nameSource?.source ?? "user-file",
      origin: host.nameSource?.origin ?? "",
    })
  rows.push({
    key: "kind",
    value: host.kind.value,
    source: host.kind.source,
    origin: host.kind.origin ?? "",
  })
  push("endpoint", host.endpoint)
  push("tenantId", host.tenantId)
  if (host.serviceToken) {
    rows.push({
      key: "serviceToken",
      value: "(set)",
      source: host.serviceToken.source,
      origin: host.serviceToken.origin ?? "",
    })
  }
  return rows
}
