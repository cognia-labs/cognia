import type { PluginIssueSyncProviderDef } from "./types"
import type { IssueProjectResource } from "../../../types/issues/index"

export function validatePluginIssueSyncProviderDef(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["Invalid issue-sync provider declaration"]
  const def = value as PluginIssueSyncProviderDef
  const errors: string[] = []
  if (typeof def.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(def.id))
    errors.push("Issue-sync provider id must be a local id without a namespace")
  if (typeof def.label !== "string" || !def.label.trim()) errors.push("Provider label is required")
  if (!Number.isSafeInteger(def.schemaVersion) || def.schemaVersion < 1)
    errors.push("Provider schemaVersion must be a positive integer")
  return errors
}

/** Canonical JSON also rejects values that could not survive a portable backup. */
export function canonicalIssueSyncConfig(config: Record<string, unknown>): string {
  const seen = new Set<object>()
  function visit(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (!value || typeof value !== "object" || seen.has(value))
      throw new Error("Issue-sync config must contain only JSON data")
    seen.add(value)
    let result: unknown
    if (Array.isArray(value)) result = value.map(visit)
    else {
      const prototype = Object.getPrototypeOf(value)
      // IndexedDB can return plain objects from another realm.
      if (prototype !== null && Object.getPrototypeOf(prototype) !== null)
        throw new Error("Issue-sync config must contain only JSON objects")
      result = Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, visit((value as Record<string, unknown>)[key])])
      )
    }
    seen.delete(value)
    return result
  }
  return JSON.stringify(visit(config))
}

/** Resource config travels with projects. Device-local credentials and selection live elsewhere. */
export function assertPortableIssueSyncConfig(config: Record<string, unknown>): void {
  if (!config || Array.isArray(config) || typeof config !== "object")
    throw new Error("Issue-sync config must be an object")
  canonicalIssueSyncConfig(config)
  function check(value: unknown): void {
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[-_]/g, "").toLowerCase()
      if (
        /^(connection(ref|id|bindings)?|account(id|ref)?|adapter(id|ref)|device(id|ref|identity)?|principal(id|ref)?|tenant(id|ref)?|accessToken|refreshToken|idToken|apiKey|token|password|secret|clientSecret|authorization|credential(s)?)$/i.test(
          normalized
        )
      )
        throw new Error(`Device-local identity or credential is not portable: ${key}`)
      check(child)
    }
  }
  check(config)
}

/** Reify the portable resource at storage/import boundaries; extra caller properties never travel. */
export function pluginResourceForStorage(
  resource: Extract<IssueProjectResource, { kind: "plugin" }>
): Extract<IssueProjectResource, { kind: "plugin" }> {
  if (
    typeof resource.providerId !== "string" ||
    !/^plugin:[^/]+\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(resource.providerId) ||
    !Number.isSafeInteger(resource.schemaVersion) ||
    resource.schemaVersion < 1
  )
    throw new Error("Invalid plugin issue resource identity or schemaVersion")
  assertPortableIssueSyncConfig(resource.config)
  return {
    kind: "plugin",
    providerId: resource.providerId,
    schemaVersion: resource.schemaVersion,
    config: JSON.parse(canonicalIssueSyncConfig(resource.config)) as Record<string, unknown>,
    ...(typeof resource.name === "string" ? { name: resource.name } : {}),
    ...(typeof resource.captureId === "string" ? { captureId: resource.captureId } : {}),
  }
}
