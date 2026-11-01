/** Resolve capture authority locally; none of these rows belong in a message or export. */
import { findAuthConnection, getAuthConnection } from "@/lib/db/auth-connections"
import {
  getRemoteDocumentConnection,
  markRemoteDocumentSourceDeleted,
  putRemoteDocumentConnection,
} from "@/lib/db/remote-document-connections"
import { getDb } from "@/lib/db/schema"
import {
  parseRemoteDocumentProvenance,
  remoteDocumentProvenance,
  type RemoteDocumentProvenanceV1,
} from "./document-provenance"
import { getDocsProvider } from "./registry"
import {
  DocsProviderError,
  isPluginDocsProviderId,
  type DocsProviderAccountBinding,
  type RemoteDocContent,
} from "./types"

export type KeptCopySourceStatus =
  "unknown" | "available" | "not-on-this-device" | "source-disconnected" | "source-deleted"

/** Record the local binding before publishing the provenance to a kept copy. */
export async function captureKeptCopyProvenance(
  content: RemoteDocContent,
  binding: DocsProviderAccountBinding
): Promise<RemoteDocumentProvenanceV1 | null> {
  const provenance = remoteDocumentProvenance(content)
  if (!provenance) return null
  const db = getDb()
  return db.transaction("rw", db.authConnections, db.remoteDocumentConnections, async () => {
    const connection = await getAuthConnection(binding.accountId)
    // Legacy built-ins use adapter/account ids. A built-in moved to Host
    // connections is captured by the same path without a provider allowlist.
    if (!connection && !isPluginDocsProviderId(content.ref.providerId)) return provenance
    if (
      connection?.status !== "connected" ||
      String(connection.revision) !== binding.authorizationEpoch
    )
      throw new DocsProviderError("notAuthorized")
    const scoped = parseRemoteDocumentProvenance({ ...provenance, connectionScoped: true })!
    await putRemoteDocumentConnection({
      captureId: scoped.captureId!,
      providerId: scoped.providerId,
      connectionRef: connection.id,
      identityKey: connection.identityKey,
      capturedAt: scoped.fetchedAt,
    })
    return scoped
  })
}

/** Same-account reconnect may have a new ref: terminal rows release their identity key. */
export async function resolveKeptCopyConnection(provenance: RemoteDocumentProvenanceV1) {
  if (!provenance.connectionScoped || !provenance.captureId) return undefined
  const source = await getRemoteDocumentConnection(provenance.captureId)
  if (
    !source ||
    source.providerId !== provenance.providerId ||
    source.sourceDeletedAt !== undefined ||
    !getDocsProvider(provenance.providerId)
  )
    return undefined
  const original = await getAuthConnection(source.connectionRef)
  if (original?.status === "connected" && original.identityKey === source.identityKey)
    return original
  const restored = await findAuthConnection(source.identityKey)
  return restored?.status === "connected" ? restored : undefined
}

export async function resolveKeptCopySource(
  provenance: RemoteDocumentProvenanceV1 | null | undefined
): Promise<KeptCopySourceStatus> {
  if (!provenance?.connectionScoped) return "unknown"
  if (!provenance.captureId) return "not-on-this-device"
  const source = await getRemoteDocumentConnection(provenance.captureId)
  if (!source || source.providerId !== provenance.providerId) return "not-on-this-device"
  if (source.sourceDeletedAt !== undefined) return "source-deleted"
  return (await resolveKeptCopyConnection(provenance)) ? "available" : "source-disconnected"
}

/** Only resource-level errors prove deletion/access loss; network and auth outages do not. */
export async function recordKeptCopySourceFailure(
  provenance: RemoteDocumentProvenanceV1 | null | undefined,
  error: unknown
): Promise<void> {
  if (
    provenance?.connectionScoped &&
    provenance.captureId &&
    error instanceof DocsProviderError &&
    (error.code === "notFound" || error.code === "noPermission")
  )
    await markRemoteDocumentSourceDeleted(provenance.captureId)
}
