import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getDb } from "./schema"

/** Device-local source binding for a user-kept copy. Never portable or plugin-owned. */
export interface RemoteDocumentConnectionRow {
  captureId: string
  providerId: string
  connectionRef: AuthConnectionRef
  /** Original identity key, retained when a terminal connection releases its identity slot. */
  identityKey: string
  capturedAt: number
  /** Issue imports use the same kept-copy identity rule without a docs provider. */
  sourceKind?: "issue-sync"
  /** The consumer whose grant authorized this copy, when applicable. */
  consumerPluginId?: string
  /** Built-in Host integration reads predate the public auth:consume service API. */
  consumerKind?: "integration"
  /** A provider confirmed the remote item is missing or forbidden. */
  sourceDeletedAt?: number
}

export function getRemoteDocumentConnection(captureId: string) {
  return getDb().remoteDocumentConnections.get(captureId)
}

export async function putRemoteDocumentConnection(row: RemoteDocumentConnectionRow): Promise<void> {
  await getDb().remoteDocumentConnections.put(row)
}

export async function deleteRemoteDocumentConnection(captureId: string): Promise<void> {
  await getDb().remoteDocumentConnections.delete(captureId)
}

export async function markRemoteDocumentSourceDeleted(captureId: string): Promise<void> {
  await getDb().remoteDocumentConnections.update(captureId, { sourceDeletedAt: Date.now() })
}
