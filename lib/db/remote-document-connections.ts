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
