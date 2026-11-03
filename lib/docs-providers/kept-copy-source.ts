/** Resolve capture authority locally; none of these rows belong in a message or export. */
import { findAuthConnection, getAuthConnection } from "@/lib/db/auth-connections"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
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
import { resolveDocsAccountBinding } from "./account-binding"
import {
  DocsProviderError,
  isPluginDocsProviderId,
  type DocsProviderAccountBinding,
  type RemoteDocContent,
} from "./types"

export type KeptCopySourceStatus =
  "unknown" | "available" | "not-on-this-device" | "source-disconnected" | "source-deleted"

export type KeptCopySourceReference = Pick<
  RemoteDocumentProvenanceV1,
  "captureId" | "connectionScoped" | "providerId"
>

export class KeptCopySourceError extends Error {
  constructor(readonly code: Exclude<KeptCopySourceStatus, "unknown" | "available">) {
    super(code)
    this.name = "KeptCopySourceError"
  }
}

/** Host-only Issue Sync capture. Portable resources retain only the random id. */
export async function captureKeptCopyConnection(input: {
  providerId: string
  connectionRef: AuthConnectionRef
  revision: number
  consumerPluginId?: string
  consumerKind?: "integration"
}): Promise<string> {
  const db = getDb()
  return db.transaction("rw", db.authConnections, db.remoteDocumentConnections, async () => {
    const connection = await getAuthConnection(input.connectionRef)
    if (connection?.status !== "connected" || connection.revision !== input.revision)
      throw new KeptCopySourceError("source-disconnected")
    const captureId = crypto.randomUUID()
    await putRemoteDocumentConnection({
      captureId,
      providerId: input.providerId,
      connectionRef: connection.id,
      identityKey: connection.identityKey,
      capturedAt: Date.now(),
      sourceKind: "issue-sync",
      ...(input.consumerPluginId ? { consumerPluginId: input.consumerPluginId } : {}),
      ...(input.consumerKind ? { consumerKind: input.consumerKind } : {}),
    })
    return captureId
  })
}

/** Legacy copies deliberately have no source state or new refresh restriction. */
export async function requireKeptCopySource(
  provenance: KeptCopySourceReference | null | undefined
): Promise<void> {
  const status = await resolveKeptCopySource(provenance)
  if (status !== "unknown" && status !== "available") throw new KeptCopySourceError(status)
}

/** Record the local binding before publishing the provenance to a kept copy. */
export async function captureKeptCopyProvenance(
  content: RemoteDocContent,
  binding: DocsProviderAccountBinding
): Promise<RemoteDocumentProvenanceV1 | null> {
  const provenance = remoteDocumentProvenance(content)
  if (!provenance) return null
  const provider = getDocsProvider(content.ref.providerId)
  if (provider?.resolveLegacyAccount) {
    const resolved = await resolveDocsAccountBinding(provider, binding)
    if (!resolved) throw new DocsProviderError("notAuthorized")
    binding = resolved
  }
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
export async function resolveKeptCopyConnection(provenance: KeptCopySourceReference) {
  if (!provenance.connectionScoped || !provenance.captureId) return undefined
  const source = await getRemoteDocumentConnection(provenance.captureId)
  if (
    !source ||
    source.providerId !== provenance.providerId ||
    source.sourceDeletedAt !== undefined ||
    (source.sourceKind !== "issue-sync" && !getDocsProvider(provenance.providerId))
  )
    return undefined
  const original = await getAuthConnection(source.connectionRef)
  const connection =
    original?.status === "connected" && original.identityKey === source.identityKey
      ? original
      : await findAuthConnection(source.identityKey)
  if (connection?.status !== "connected") return undefined
  if (source.consumerPluginId) {
    try {
      const { assertSyncConnection } = await import("@/lib/plugin/api/sync-api")
      const { getPermissionGuard } = await import("@/lib/plugin/security/permission-guard")
      await assertSyncConnection(
        source.consumerPluginId,
        connection.id,
        () => {
          if (
            source.consumerKind !== "integration" &&
            !getPermissionGuard().check(source.consumerPluginId!, "auth:consume")
          )
            throw new KeptCopySourceError("source-disconnected")
        },
        { hostIntegration: source.consumerKind === "integration" }
      )
    } catch {
      return undefined
    }
  }
  return connection
}

export async function resolveKeptCopySource(
  provenance: KeptCopySourceReference | null | undefined
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
  provenance: KeptCopySourceReference | null | undefined,
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
