/** Public cloud-document retrieval contract (ADR-0246). No Host imports or credentials. */

/**
 * What a reference points at.
 *
 * `wiki` is a Feishu wiki node — an indirection that resolves to a `doc` at
 * fetch time, kept distinct because the picker shows it differently and the
 * token namespaces differ.
 */
export type RemoteDocKind = "doc" | "wiki" | "sheet" | "bitable" | "resource"

/** Body formats a provider may return. Drives the staged attachment's extension. */
export type RemoteDocFormat = "markdown" | "text" | "csv"

/** Retrieval identity. An epoch is a non-secret fence, never an OAuth token. */
export interface DocsProviderAccountBinding {
  accountId: string
  authorizationEpoch?: string
}

export type RemoteDocIncompleteReason =
  "upstream-truncated" | "budget" | "inaccessible-block" | "unsupported-content" | "parse-degraded"

export type RemoteDocCompleteness =
  | { status: "complete"; reasons?: never }
  | { status: "partial"; reasons: readonly RemoteDocIncompleteReason[] }

/**
 * A pointer to one remote document. Cheap to produce — `search` and `matchRef`
 * both return these without fetching a body.
 */
export interface RemoteDocRef {
  /** Owning provider id (`"lark"` / `"google"`). */
  providerId: string
  kind: RemoteDocKind
  /** Provider-stable identifier: Lark doc/wiki/app token, Google file id. */
  id: string
  /** Original provider resource type, retained when `kind` folds several types together. */
  sourceType?: string
  /** Display title. Falls back to the id when the provider cannot cheaply resolve one. */
  title: string
  /** Canonical web URL, when the provider can build one. */
  url?: string
  /** Secondary picker line — owning space, folder, or breadcrumb. */
  sublabel?: string
  /** Last-modified time in ms since epoch, when known. */
  updatedAtMs?: number
  /** Bound when a search/link becomes selectable; never reassigned on pick. */
  accountBinding?: DocsProviderAccountBinding
}

/** A fetched body, ready to be staged as a composer attachment. */
export interface RemoteDocContent {
  ref: RemoteDocRef
  /** Resolved title — may be better than `ref.title` once the body was fetched. */
  title: string
  /** Plain text / markdown / CSV. Never HTML. */
  text: string
  format: RemoteDocFormat
  /**
   * True when the provider hit a row/table/char cap. The body ALSO carries a
   * visible truncation marker — this flag exists so the UI can warn, not so a
   * caller can silently ignore the loss.
   */
  truncated?: boolean
  /** Semantic losses as well as byte/row limits. Legacy consumers use truncated. */
  completeness?: RemoteDocCompleteness
}

/**
 * Failure taxonomy. `code` + `params` slot directly into
 * `docsProviders.errors.<code>` so no provider ever formats user-facing copy.
 *
 * Mirrors `LarkIngestError` (`lib/twin/ingest/lark-doc-fetcher.ts`) — the Lark
 * provider maps that error's codes onto these one-to-one.
 */
export type DocsProviderErrorCode =
  | "notConfigured"
  | "notAuthorized"
  | "noPermission"
  | "notFound"
  | "unsupportedType"
  | "rateLimited"
  | "empty"
  | "hostUnsupported"
  | "network"
  | "tooLarge"
  | "invalidRef"

export class DocsProviderError extends Error {
  readonly code: DocsProviderErrorCode
  readonly params?: Record<string, string>

  constructor(code: DocsProviderErrorCode, params?: Record<string, string>) {
    super(params?.reason ? `${code}: ${params.reason}` : code)
    this.name = "DocsProviderError"
    this.code = code
    this.params = params
  }
}

/**
 * One connected identity a provider can act as.
 *
 * Lark returns one entry per enabled Lark connector instance (a user may bind
 * several tenants); Google returns at most one, because its connection is a
 * single OAuth client.
 */
export interface DocsProviderAccount {
  /** Provider-scoped account id — a Lark adapter id, or `"default"` for Google. */
  id: string
  /** User-visible label (adapter display name, Google account email). */
  label: string
  /** Stable across token refresh; changes when authorization is invalidated. */
  authorizationEpoch?: string
  /** False means this account can use direct links but needs search authorization. */
  searchable?: boolean
}

/** Per-call options shared by `search` and `fetch`. */
export interface DocsProviderCallOptions {
  /** Which `DocsProviderAccount.id` to act as. */
  accountId: string
  expectedAuthorizationEpoch?: string
  signal?: AbortSignal
}

export interface DocsProviderSearchOptions extends DocsProviderCallOptions {
  limit: number
}

export interface PluginDocsProviderAccount extends DocsProviderAccount {
  authorizationEpoch: string
}

/** A plugin contributes functions; the manifest and Host own the descriptor and hosts. */
export interface PluginDocsProvider {
  readonly id: string
  readonly mentionPrefix: string
  readonly kinds: readonly RemoteDocKind[]
  /** Account ids are Host connection refs; authorizationEpoch is String(connection.revision). */
  listAccounts(): Promise<PluginDocsProviderAccount[]>
  subscribeAccounts?(listener: () => void): () => void
  /** Pure recognition; the Host calls this only for declared HTTPS origins. */
  matchRef(input: string): Omit<RemoteDocRef, "providerId" | "title"> | null
  search?(query: string, options: DocsProviderSearchOptions): Promise<RemoteDocRef[]>
  fetch(ref: RemoteDocRef, options: DocsProviderCallOptions): Promise<RemoteDocContent>
}

export interface PluginDocsProviderDef {
  id: string
  label: string
  /** Plugin-owned namespace, for example `acme.docs:` for plugin `acme`. */
  mentionPrefix: string
  kinds: RemoteDocKind[]
  /** Exact HTTPS origins, without paths, credentials, query or fragment. */
  urlOrigins: string[]
}

export interface PluginDocsProviderRegistration {
  providerId: string
  unregister(): void
}

export interface PluginDocsProvidersAPI {
  register(provider: PluginDocsProvider): PluginDocsProviderRegistration
}

export function isPluginDocsProviderId(id: string): boolean {
  return /^plugin:[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)
}

export function isDocsProviderUrlOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && url.origin === value
  } catch {
    return false
  }
}

/** Shared manifest/registration validation, with collisions checked by the Host registry. */
export function validatePluginDocsProviderDef(value: unknown, pluginId: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return ["Expected a docs provider descriptor"]
  const def = value as Record<string, unknown>
  const errors: string[] = []
  if (typeof def.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(def.id))
    errors.push("Invalid docs provider id")
  if (typeof def.label !== "string" || !def.label.trim())
    errors.push("Docs provider label is required")
  if (
    typeof def.mentionPrefix !== "string" ||
    !def.mentionPrefix.startsWith(`${pluginId}.`) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*:$/.test(def.mentionPrefix) ||
    def.mentionPrefix.length <= pluginId.length + 2 ||
    ["lark:", "google:", "gdoc:"].includes(def.mentionPrefix)
  )
    errors.push("Docs provider mentionPrefix must use the plugin namespace and end with ':'")
  const kinds = ["doc", "wiki", "sheet", "bitable", "resource"]
  if (
    !Array.isArray(def.kinds) ||
    !def.kinds.length ||
    def.kinds.some((kind) => !kinds.includes(kind)) ||
    new Set(def.kinds).size !== def.kinds.length
  )
    errors.push("Invalid docs provider kinds")
  if (
    !Array.isArray(def.urlOrigins) ||
    !def.urlOrigins.length ||
    def.urlOrigins.some((origin) => !isDocsProviderUrlOrigin(origin)) ||
    new Set(def.urlOrigins).size !== def.urlOrigins.length
  )
    errors.push("Docs provider urlOrigins must be exact HTTPS origins")
  return errors
}
