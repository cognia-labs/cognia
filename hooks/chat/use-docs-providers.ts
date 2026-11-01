"use client"

import { useSyncExternalStore } from "react"
import { getDocsProvidersRevision, subscribeDocsProviders } from "@/lib/docs-providers/registry"

/** A stable primitive snapshot; callers derive their provider list for the current render. */
export function useDocsProvidersRevision(): number {
  return useSyncExternalStore(
    subscribeDocsProviders,
    getDocsProvidersRevision,
    getDocsProvidersRevision
  )
}
