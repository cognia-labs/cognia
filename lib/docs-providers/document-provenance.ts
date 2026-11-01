/**
 * Where a staged or sent cloud-document attachment came from.
 *
 * A cloud document becomes an ordinary attachment (a `.md` / `.txt` / `.csv`
 * file) the moment it is staged, and after that only its body and a generic
 * citation survive. The dock needs more to reopen it: which provider and
 * resource it was, the address of the original, when it was read and whether
 * the read was complete. This record carries exactly that, beside the
 * attachment, through the draft and onto the sent message part.
 *
 * It deliberately carries no retrieval identity: no account id, no
 * authorization epoch, no token, no browser profile. Those stay with the
 * device-local remoteDocumentConnections table, so a shared, synced or exported
 * message cannot reveal which account read the document. A random capture id
 * can resolve that binding only on the device that captured it.
 *
 * Every reader goes through `parseRemoteDocumentProvenance`: the record is
 * rebuilt from a whitelist, and the address is re-validated by the strict
 * classifier, so a stale or tampered draft cannot smuggle extra fields or an
 * untrusted host into the dock.
 */

import { classifyCloudDocumentUrl, cloudDocumentTargetFromRef } from "./document-url"
import { isPluginDocsProviderId } from "./types"
import type {
  RemoteDocCompleteness,
  RemoteDocContent,
  RemoteDocIncompleteReason,
  RemoteDocKind,
} from "./types"

export interface RemoteDocumentProvenanceV1 {
  v: 1
  /** Random capture identity, never derived from an account or remote identity. Optional on legacy copies. */
  captureId?: string
  /** The capture used a Host connection; its identity stays in a device-local side table. */
  connectionScoped?: true
  providerId: string
  resourceKind: RemoteDocKind
  resourceId: string
  /** Canonical address from `classifyCloudDocumentUrl`, or "" when no trustworthy one is known. */
  url: string
  title: string
  /** When the body was read, in ms since epoch. */
  fetchedAt: number
  completeness: RemoteDocCompleteness
  truncated?: boolean
  /**
   * Lark folds legacy docs and docx into `doc`; a search hit's opaque token
   * needs this to be read again. Not identity: only `"doc"` or `"docx"`.
   */
  sourceType?: "doc" | "docx"
}

const PROVIDERS = new Set(["lark", "google"])
const KINDS = new Set<RemoteDocKind>(["doc", "wiki", "sheet", "bitable", "resource"])
const REASONS = new Set<RemoteDocIncompleteReason>([
  "upstream-truncated",
  "budget",
  "inaccessible-block",
  "unsupported-content",
  "parse-degraded",
])
const MAX_ID = 256
const MAX_TITLE = 1024

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readCompleteness(value: unknown): RemoteDocCompleteness | null {
  if (!record(value)) return null
  if (value.status === "complete") return { status: "complete" }
  if (value.status !== "partial" || !Array.isArray(value.reasons)) return null
  const reasons = [
    ...new Set(
      value.reasons.filter((reason): reason is RemoteDocIncompleteReason =>
        REASONS.has(reason as RemoteDocIncompleteReason)
      )
    ),
  ]
  return reasons.length ? { status: "partial", reasons } : null
}

/** The address the record may keep: the classifier's canonical form for the same resource, else "". */
function trustedUrl(
  url: unknown,
  providerId: string,
  resourceKind: RemoteDocKind,
  resourceId: string
): string {
  if (typeof url !== "string" || !url) return ""
  const target = classifyCloudDocumentUrl(url)
  return target?.providerId === providerId &&
    target.resourceKind === resourceKind &&
    target.resourceId === resourceId
    ? target.url
    : ""
}

/** Rebuild a provenance record from untrusted input; anything off-contract is `null`. */
export function parseRemoteDocumentProvenance(value: unknown): RemoteDocumentProvenanceV1 | null {
  if (!record(value) || value.v !== 1) return null
  const { providerId, resourceKind, resourceId, title, fetchedAt } = value
  if (
    typeof providerId !== "string" ||
    (!PROVIDERS.has(providerId) && !isPluginDocsProviderId(providerId))
  )
    return null
  if (typeof resourceKind !== "string" || !KINDS.has(resourceKind as RemoteDocKind)) return null
  if (typeof resourceId !== "string" || !resourceId || resourceId.length > MAX_ID) return null
  if (typeof title !== "string") return null
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt <= 0) return null
  const completeness = readCompleteness(value.completeness)
  if (!completeness) return null
  const kind = resourceKind as RemoteDocKind
  return {
    v: 1,
    ...(typeof value.captureId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.captureId)
      ? { captureId: value.captureId }
      : {}),
    ...(value.connectionScoped === true ? { connectionScoped: true } : {}),
    providerId: providerId as RemoteDocumentProvenanceV1["providerId"],
    resourceKind: kind,
    resourceId,
    url: trustedUrl(value.url, providerId, kind, resourceId),
    title: title.slice(0, MAX_TITLE),
    fetchedAt,
    completeness,
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(providerId === "lark" &&
    kind === "doc" &&
    (value.sourceType === "doc" || value.sourceType === "docx")
      ? { sourceType: value.sourceType }
      : {}),
  }
}

/**
 * The record for a body a provider just returned. `null` for providers the
 * dock cannot open (only Lark and Google have document tabs).
 */
export function remoteDocumentProvenance(
  content: RemoteDocContent,
  fetchedAt: number = Date.now()
): RemoteDocumentProvenanceV1 | null {
  const { ref } = content
  return parseRemoteDocumentProvenance({
    v: 1,
    captureId: crypto.randomUUID(),
    providerId: ref.providerId,
    resourceKind: ref.kind,
    resourceId: ref.id,
    url: cloudDocumentTargetFromRef(ref.providerId, ref)?.url ?? "",
    title: content.title || ref.title,
    fetchedAt,
    completeness:
      content.completeness ??
      (content.truncated
        ? { status: "partial", reasons: ["upstream-truncated"] }
        : { status: "complete" }),
    truncated: content.truncated,
    sourceType: ref.sourceType,
  })
}
