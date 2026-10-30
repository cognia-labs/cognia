"use client"

import { useEffect, useId, useState, useSyncExternalStore } from "react"
import {
  getExtensionRevision,
  getExtensionsForPoint,
  subscribeExtensionChanges,
} from "@/lib/plugin/api/extension-api"
import {
  getInterceptorRevision,
  hasInterceptors,
  resolveInterceptorChain,
  subscribeInterceptorChanges,
} from "@/lib/plugin/interceptors/registry"
import { projectPluginSurface } from "@/lib/plugin/interceptors/consumers"
import type { CanonicalExtensionPoint } from "@/lib/plugin/contracts/plugin-points"
import type { ExtensionRegistration } from "@/types/plugin/plugin"
import { usePluginStore } from "@/stores/plugin-runtime"

type ProjectedExtension = ExtensionRegistration & { projectionTitle?: string }

/** Share asynchronous DTO projection while component functions remain in the extension registry. */
export function useSurfaceProjections(
  point: CanonicalExtensionPoint,
  context?: Readonly<Record<string, unknown>>
) {
  const instanceId = useId()
  const revision = useSyncExternalStore(subscribeExtensionChanges, getExtensionRevision, () => 0)
  const interceptorRevision = useSyncExternalStore(
    subscribeInterceptorChanges,
    getInterceptorRevision,
    () => 0
  )
  const plugins = usePluginStore((state) => state.plugins)
  const all = getExtensionsForPoint(point)
  const active = hasInterceptors("ui.surface.project")
  const decorators = resolveInterceptorChain("ui.surface.project")
    .ordered.map((entry) => `${entry.registrationId}:${entry.generation}`)
    .join(";")
  // The JSON boundary intentionally excludes callbacks/React nodes; projection never supplies authority.
  let contextJson: string
  try {
    contextJson = JSON.stringify(context) ?? "null"
  } catch {
    contextJson = "null"
  }
  const owners = all
    .map((ext) => `${ext.id}:${plugins[ext.pluginId]?.status ?? "activating"}`)
    .join(";")
  const key = JSON.stringify([
    point,
    revision,
    interceptorRevision,
    contextJson,
    owners,
    decorators,
    active,
  ])
  const [result, setResult] = useState<{ key: string; values: Map<string, string | undefined> }>()
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const entries = getExtensionsForPoint(point)
    void Promise.all(
      entries.map(async (ext) => {
        try {
          const value = await projectPluginSurface(
            {
              point,
              pluginId: ext.pluginId,
              extensionId: ext.id,
              context: JSON.parse(contextJson) ?? undefined,
              presentation: { hidden: false },
            },
            {
              operationId: `surface:${instanceId}:${point}:${ext.id}:${key}`,
              signal: controller.signal,
            }
          )
          return value.presentation.hidden
            ? undefined
            : ([ext.id, value.presentation.title] as const)
        } catch {
          // Strict failures suppress the surface; the canonical dispatcher already handles fail-open.
          return undefined
        }
      })
    ).then((values) => {
      if (!controller.signal.aborted)
        setResult({ key, values: new Map(values.filter((value) => value !== undefined)) })
    })
    return () => controller.abort()
  }, [active, contextJson, key, point, instanceId])
  const projected: ProjectedExtension[] = !active
    ? all
    : result?.key === key
      ? all
          .filter((ext) => result.values.has(ext.id))
          .map((ext) => ({ ...ext, projectionTitle: result.values.get(ext.id) }))
      : []
  return [...projected].sort((a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0))
}
