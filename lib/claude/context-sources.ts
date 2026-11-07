/**
 * Reading what modules' context contributions reported for the UI
 * (`SendOptions.contextSources`, ADR-0250 §14 `context` amendment). Kept apart
 * from the resolver so a reader imports no contribution registry.
 */

import type { ContextSourcesMap } from "@/lib/modules/manifest-types"

/** One contribution's UI report from `SendOptions.contextSources`, typed by `ContextSourcesMap`. */
export function contextSourcesOf<K extends keyof ContextSourcesMap>(
  contextSources: Readonly<Record<string, unknown>> | undefined,
  key: K
): ContextSourcesMap[K] | undefined {
  return contextSources?.[key as string] as ContextSourcesMap[K] | undefined
}
