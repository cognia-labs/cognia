/** Attachment-only metadata. Retrieval authority stays in the dock's memory. */
import {
  parseRemoteDocumentProvenance,
  type RemoteDocumentProvenanceV1,
} from "@/lib/docs-providers/document-provenance"

export const REMOTE_DOC_PART_KEY = "remoteDocument"
const incoming = new WeakMap<File, RemoteDocumentProvenanceV1>()

export function rememberRemoteDocument(file: File, value: unknown): void {
  const provenance = parseRemoteDocumentProvenance(value)
  if (provenance) incoming.set(file, provenance)
}

export function stagedRemoteDocument(
  file: File | undefined
): RemoteDocumentProvenanceV1 | undefined {
  return file ? incoming.get(file) : undefined
}

/**
 * Transport boundary for message parts, references and draft metadata. Callers
 * explicitly choose whether that projection carries citations. Rebuild the
 * record even when keeping it: persisted input may contain extra identity keys.
 * Binary backup values (Blob, typed arrays, Date) remain intact.
 */
export function projectRemoteDocumentData<T>(value: T, keep: boolean): T {
  if (Array.isArray(value)) {
    const projected = value.map((entry) => projectRemoteDocumentData(entry, keep))
    return value.every((entry, index) => entry === projected[index]) ? value : (projected as T)
  }
  // IndexedDB values may belong to another realm; prototype identity is not
  // a reliable plain-record check. Preserve binary values without traversing them.
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") return value
  let changed = false
  const entries = Object.entries(value).flatMap(([key, entry]): [string, unknown][] => {
    if (key === REMOTE_DOC_PART_KEY) {
      changed = true
      const parsed = keep ? parseRemoteDocumentProvenance(entry) : null
      return parsed ? [[key, parsed]] : []
    }
    const projected = projectRemoteDocumentData(entry, keep)
    if (projected !== entry) changed = true
    return [[key, projected]]
  })
  return changed ? (Object.fromEntries(entries) as T) : value
}
