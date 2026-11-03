/** Host binding resolution. Migration is a working copy, never an implicit persisted write. */
import type { IssueProject, IssueProjectResource } from "@/types/issues"
import type { IssueSyncBinding } from "./types"
import { getIssueSyncRegistry, type IssueSyncRegistry } from "./registry"
import {
  assertPortableIssueSyncConfig,
  canonicalIssueSyncConfig,
} from "@cognia/plugin-contract/lib/issues/sync/resources"
import { validatePluginConfig } from "@cognia/plugin-contract/lib/plugin/core/validation"

type PluginResource = Extract<IssueProjectResource, { kind: "plugin" }>

export { pluginResourceForStorage } from "@cognia/plugin-contract/lib/issues/sync/resources"
export type PluginResourceState =
  | { status: "unavailable" | "needs-attention"; key: string }
  | { status: "ready"; key: string; label: string; resource: PluginResource }

export function pluginResourceState(
  resource: PluginResource,
  registry: IssueSyncRegistry = getIssueSyncRegistry()
): PluginResourceState {
  let fallback = `${resource.providerId}:unavailable`
  try {
    fallback = `${resource.providerId}:${canonicalIssueSyncConfig(resource.config)}`
  } catch {
    /* Invalid imported data stays visible. */
  }
  const descriptor = registry.get(resource.providerId)?.resource
  if (!descriptor) return { status: "unavailable", key: fallback }
  try {
    assertPortableIssueSyncConfig(resource.config)
    if (
      !Number.isSafeInteger(resource.schemaVersion) ||
      resource.schemaVersion < 1 ||
      resource.schemaVersion > descriptor.schemaVersion
    )
      return { status: "needs-attention", key: fallback }
    let config = JSON.parse(canonicalIssueSyncConfig(resource.config)) as Record<string, unknown>
    if (resource.schemaVersion < descriptor.schemaVersion) {
      if (!descriptor.migrate) return { status: "needs-attention", key: fallback }
      config = descriptor.migrate(resource.schemaVersion, config)
    }
    assertPortableIssueSyncConfig(config)
    if (
      !validatePluginConfig(config, descriptor.schema).valid ||
      descriptor.validate?.(config).length
    )
      return { status: "needs-attention", key: fallback }
    if (
      descriptor.schema.mapping &&
      !validatePluginConfig(
        (config.mapping ?? {}) as Record<string, unknown>,
        descriptor.schema.mapping
      ).valid
    )
      return { status: "needs-attention", key: fallback }
    const description = descriptor.describe(config)
    if (
      typeof description.key !== "string" ||
      !description.key ||
      typeof description.label !== "string"
    )
      return { status: "needs-attention", key: fallback }
    return {
      status: "ready",
      key: `${resource.providerId}:${description.key}`,
      label: description.label,
      resource: { ...resource, schemaVersion: descriptor.schemaVersion, config },
    }
  } catch {
    return { status: "needs-attention", key: fallback }
  }
}

export function resolvePluginSyncBindings(
  containers: readonly IssueProject[],
  registry: IssueSyncRegistry = getIssueSyncRegistry()
): IssueSyncBinding[] {
  return containers.flatMap((container) =>
    container.resources.flatMap((resource) => {
      if (resource.kind !== "plugin") return []
      const state = pluginResourceState(resource, registry)
      if (state.status !== "ready") return []
      return [
        {
          providerId: resource.providerId,
          projectId: container.projectId,
          issueProjectId: container.id,
          projectKey: container.key,
          resource: state.resource,
          key: state.key,
          ...(registry.get(resource.providerId)?.connectionRef
            ? { connectionRef: registry.get(resource.providerId)!.connectionRef }
            : {}),
        },
      ]
    })
  )
}
