/**
 * Original files of Digital Twin document sources (ADR-0003, ADR-0024).
 *
 * A binary source (PDF, Office, EPUB) used to keep only the text extracted the
 * moment it was picked, stored as Markdown. A scanned PDF had no text and was
 * refused before the worker's OCR fallback could run; a mixed PDF lost its
 * scanned pages; nothing could be parsed again. The file itself is now kept,
 * in the shared media store (`messageMedia`, keyed `original:<sha256>`), and
 * held by one owner row per source in `messageMediaRefs`:
 *
 *   messageId `twin-source:<sourceId>` · sessionId `twin:sources`
 *
 * The sentinel session id matches no conversation, so session deletion and
 * conversation walks leave these rows alone, while media GC — which counts
 * rows by hash — sees the bytes as referenced. Deleting the source releases
 * its row and collects the bytes once nothing else holds them.
 */

import type { TwinSource, TwinSourceOriginal } from "@/types/twin"
import {
  collectUnreferencedMessageMedia,
  TWIN_SOURCE_OWNER_PREFIX,
  TWIN_SOURCE_REF_SESSION_ID,
} from "./message-media-refs"
import { getDb } from "./schema"
import { hashSessionAssetSource } from "./session-assets"

export function twinSourceOriginalOwnerKey(sourceId: string): string {
  return `${TWIN_SOURCE_OWNER_PREFIX}${sourceId}`
}

function mediaKeyOf(contentHash: string): string {
  return `original:${contentHash}`
}

/**
 * Whether a recorded original names its bytes the way this store keys them.
 * A restored row comes from a package file, so its key is checked before it
 * selects bytes or an owner row.
 */
export function isTwinSourceOriginalKey(
  original: Pick<TwinSourceOriginal, "mediaKey" | "contentHash" | "byteLength">
): boolean {
  return (
    typeof original.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(original.contentHash) &&
    original.mediaKey === mediaKeyOf(original.contentHash) &&
    Number.isSafeInteger(original.byteLength) &&
    original.byteLength >= 0
  )
}

/**
 * Hash the file and describe it. Hashing is async work that must not run
 * inside an IndexedDB transaction (it would commit early), so callers do it
 * first and pass the result to `holdTwinSourceOriginal`.
 */
export async function describeTwinSourceOriginal(
  blob: Blob,
  filename: string,
  mediaType: string
): Promise<TwinSourceOriginal> {
  const contentHash = await hashSessionAssetSource(blob)
  return {
    mediaKey: mediaKeyOf(contentHash),
    contentHash,
    byteLength: blob.size,
    mediaType: mediaType || "application/octet-stream",
    filename,
  }
}

/**
 * Store the bytes (once per content hash) and the source's owner row. Run it
 * inside a transaction that covers `messageMedia` and `messageMediaRefs`, the
 * same one that writes the source row, so a source never points at bytes no
 * row holds.
 */
export async function holdTwinSourceOriginal(
  sourceId: string,
  original: TwinSourceOriginal,
  blob: Blob,
  now = Date.now()
): Promise<void> {
  if (blob.size !== original.byteLength) throw new Error("twin_source_original_size_mismatch")
  const db = getDb()
  if (!(await db.messageMedia.get(original.mediaKey))) {
    await db.messageMedia.add({
      hash: original.mediaKey,
      blob,
      byteSize: blob.size,
      mediaType: original.mediaType,
      width: 0,
      height: 0,
      createdAt: now,
      lastUsedAt: now,
    })
  }
  const messageId = twinSourceOriginalOwnerKey(sourceId)
  await db.messageMediaRefs.where("messageId").equals(messageId).delete()
  await db.messageMediaRefs.put({
    messageId,
    sessionId: TWIN_SOURCE_REF_SESSION_ID,
    hash: original.mediaKey,
  })
}

/**
 * The source's original bytes, or `undefined` when it has none or they are
 * gone (a backup restored without them). Bytes whose size disagrees with the
 * record are treated as gone rather than parsed as something else.
 */
export async function readTwinSourceOriginal(
  source: Pick<TwinSource, "original">
): Promise<Blob | undefined> {
  if (!source.original) return undefined
  const row = await getDb().messageMedia.get(source.original.mediaKey)
  if (!(row?.blob instanceof Blob) || row.blob.size !== source.original.byteLength) return undefined
  return row.blob
}

/**
 * Drop the owner rows of `sourceIds`. Run it inside the transaction that
 * deletes the sources; it returns the media keys they held, for
 * `collectReleasedTwinSourceOriginals` once that transaction has committed.
 */
export async function releaseTwinSourceOriginalRefs(
  sourceIds: readonly string[]
): Promise<string[]> {
  if (sourceIds.length === 0) return []
  const db = getDb()
  const owners = sourceIds.map(twinSourceOriginalOwnerKey)
  const refs = await db.messageMediaRefs.where("messageId").anyOf(owners).toArray()
  if (refs.length === 0) return []
  await db.messageMediaRefs.where("messageId").anyOf(owners).delete()
  return [...new Set(refs.map((ref) => ref.hash))]
}

/** Delete released bytes nothing else holds. Call after the releasing transaction. */
export async function collectReleasedTwinSourceOriginals(mediaKeys: readonly string[]) {
  if (mediaKeys.length === 0) return 0
  return collectUnreferencedMessageMedia(mediaKeys, { graceMs: 0 })
}

/** Every media key a Twin source holds (backup exports these bytes). */
export async function listTwinSourceOriginalMediaKeys(): Promise<string[]> {
  const refs = await getDb()
    .messageMediaRefs.where("messageId")
    .startsWith(TWIN_SOURCE_OWNER_PREFIX)
    .toArray()
  return [...new Set(refs.map((ref) => ref.hash))]
}

/**
 * Make the owner rows match the sources after a restore. A source whose bytes
 * arrived gets its row back; a source whose bytes did not is what it really
 * is now — text only — and loses its `original`; a row whose source is gone is
 * dropped. Run inside a transaction over `twinSources`, `messageMedia` and
 * `messageMediaRefs`; returns the media keys released, for collection after.
 */
export async function reconcileTwinSourceOriginals(): Promise<string[]> {
  const db = getDb()
  const refs = await db.messageMediaRefs
    .where("messageId")
    .startsWith(TWIN_SOURCE_OWNER_PREFIX)
    .toArray()
  const refBySource = new Map(
    refs.map((ref) => [ref.messageId.slice(TWIN_SOURCE_OWNER_PREFIX.length), ref])
  )
  const released: string[] = []
  const live = new Set<string>()
  for (const source of await db.twinSources.toArray()) {
    if (!source.original) continue
    const valid = isTwinSourceOriginalKey(source.original)
    const row = valid ? await db.messageMedia.get(source.original.mediaKey) : undefined
    const present = row?.blob instanceof Blob && row.blob.size === source.original.byteLength
    if (!present) {
      await db.twinSources.update(source.id, (draft) => {
        delete draft.original
      })
      continue
    }
    live.add(source.id)
    const ref = refBySource.get(source.id)
    if (ref?.hash === source.original.mediaKey) continue
    if (ref) released.push(ref.hash)
    const messageId = twinSourceOriginalOwnerKey(source.id)
    await db.messageMediaRefs.where("messageId").equals(messageId).delete()
    await db.messageMediaRefs.put({
      messageId,
      sessionId: TWIN_SOURCE_REF_SESSION_ID,
      hash: source.original.mediaKey,
    })
  }
  for (const [sourceId, ref] of refBySource) {
    if (live.has(sourceId)) continue
    await db.messageMediaRefs.where("messageId").equals(ref.messageId).delete()
    released.push(ref.hash)
  }
  return [...new Set(released)]
}
