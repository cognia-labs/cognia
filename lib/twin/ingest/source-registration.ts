import type { TwinSource } from "@/types/twin"
import { createTwinSource, type TwinSourceDraft } from "@/lib/db/twin-sources"
import { getDb } from "@/lib/db/schema"
import {
  parseRemoteDocumentProvenance,
  type RemoteDocumentProvenanceV1,
} from "@/lib/docs-providers/document-provenance"

/** Non-indexed portable fields; device-local identity stays in remoteDocumentConnections. */
export type TwinKeptSource = TwinSource & {
  captureId?: string
  remoteDocument?: RemoteDocumentProvenanceV1
}

/** Rows predating captureId deliberately retain unknown provenance. */
export function twinSourceProvenance(source: TwinSource) {
  const kept = source as TwinKeptSource
  if (!kept.captureId) return undefined
  return (
    parseRemoteDocumentProvenance(kept.remoteDocument) ?? {
      captureId: kept.captureId,
      providerId: "lark",
      connectionScoped: true as const,
    }
  )
}

export async function sourceFingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export interface RegisterTwinSourceResult {
  source: TwinKeptSource
  created: boolean
  revived: boolean
}

/**
 * Canonical Twin source registration seam. Fingerprint lookup and mutation
 * share one transaction so concurrent import paths cannot create duplicate
 * active rows for the same Twin.
 */
export async function registerTwinSource(
  draft: Omit<TwinSourceDraft, "fingerprint"> & {
    fingerprint?: string
    remoteDocument?: RemoteDocumentProvenanceV1
  }
): Promise<RegisterTwinSourceResult> {
  const fingerprint = draft.fingerprint || (await sourceFingerprint(draft.source))
  const db = getDb()
  return db.transaction("rw", db.twinSources, async () => {
    const existing = await db.twinSources
      .where("[twinId+fingerprint]")
      .equals([draft.twinId, fingerprint])
      .first()
    if (existing && existing.status !== "failed" && existing.status !== "deleted") {
      if (draft.remoteDocument && !(existing as TwinKeptSource).captureId) {
        const source: TwinKeptSource = {
          ...existing,
          captureId: draft.remoteDocument.captureId,
          remoteDocument: draft.remoteDocument,
        }
        await db.twinSources.put(source)
        return { source, created: false, revived: false }
      }
      return { source: existing, created: false, revived: false }
    }
    if (existing) {
      await db.twinSources.update(existing.id, {
        kind: draft.kind,
        format: draft.format,
        source: draft.source,
        title: draft.title,
        bytes: draft.bytes,
        fingerprint,
        status: "pending",
        errorMessage: undefined,
        parsedAt: undefined,
        chunkCount: 0,
        redacted: draft.redacted,
        redactionMapEnc: draft.redactionMapEnc,
        tags: draft.tags,
        speakers: draft.speakers,
        ...(draft.remoteDocument
          ? {
              captureId: draft.remoteDocument.captureId,
              remoteDocument: draft.remoteDocument,
            }
          : {}),
      })
      return {
        source: (await db.twinSources.get(existing.id))!,
        created: false,
        revived: true,
      }
    }
    const created = await createTwinSource({ ...draft, fingerprint, status: "pending" })
    const source: TwinKeptSource = draft.remoteDocument
      ? {
          ...created,
          captureId: draft.remoteDocument.captureId,
          remoteDocument: draft.remoteDocument,
        }
      : created
    if (draft.remoteDocument) await db.twinSources.put(source)
    return { source, created: true, revived: false }
  })
}
