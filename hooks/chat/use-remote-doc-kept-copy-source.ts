"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { parseRemoteDocumentProvenance } from "@/lib/docs-providers/document-provenance"
import { resolveKeptCopySource } from "@/lib/docs-providers/kept-copy-source"
import { useDocsProvidersRevision } from "./use-docs-providers"

/** Re-evaluate on local connection/capture changes and provider registration changes. */
export function useKeptCopySource(value: unknown) {
  const provenance = parseRemoteDocumentProvenance(value)
  const revision = useDocsProvidersRevision()
  const resolved = useLiveQuery(
    () => resolveKeptCopySource(provenance),
    [provenance?.captureId, provenance?.connectionScoped, provenance?.providerId, revision]
  )
  const status = provenance?.connectionScoped ? resolved : "unknown"
  return {
    status,
    // A connection-scoped copy is inert until this device has resolved its source.
    canReopen: !provenance?.connectionScoped || status === "available",
  }
}
