/**
 * Feishu/Lark remote document provider (ADR-0134).
 *
 * Credentials are NOT its own: it acts as a bound Lark connector instance, so
 * document reading reuses the connected adapter's credentials and requires
 * the corresponding document permissions. Document ACLs are evaluated against
 * that identity. `listAccounts` projects enabled, configured adapters through
 * the host's current authorization lineage.
 *
 * Document bodies come straight from `fetchLarkDocAsRawSource`; only the two
 * grid-shaped kinds (电子表格 / 多维表格) needed new readers, and those run on
 * the shared `withLarkAuthedApi` harness that the doc fetcher itself now uses.
 */

import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { withLarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import { connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { onCredentialsRotated } from "@/lib/connectors/credentials-events"
import { localTransport } from "@/lib/tauri/transport-instance"
import { throwIfRequestAborted, withRequestAbort } from "@/lib/network/request-abort"
import { hasLarkDocumentSearchScope } from "@/lib/connectors/adapters/lark/auth"
import { fetchLarkDocAsRawSource, resolveLarkWikiNode } from "@/lib/twin/ingest/lark-doc-fetcher"
import { parseLarkResourceUrl } from "@/lib/twin/ingest/lark-url"
import { clampDocText, MAX_REMOTE_DOC_RESPONSE_BYTES } from "@/lib/docs-providers/limits"
import { assertRemoteDocBinding } from "@/lib/docs-providers/account-binding"
import {
  DocsProviderError,
  type DocsProvider,
  type DocsProviderAccount,
  type DocsProviderCallOptions,
  type DocsProviderSearchOptions,
  type RemoteDocContent,
  type RemoteDocKind,
  type RemoteDocRef,
} from "@/lib/docs-providers/types"
import { readLarkBitable } from "./bitable"
import { toDocsProviderError } from "./errors"
import { searchLarkDocs } from "./search"
import { readLarkSpreadsheet } from "./sheets"

export const LARK_PROVIDER_ID = "lark"

async function assertLarkAuthorization(opts: DocsProviderCallOptions): Promise<string> {
  throwIfRequestAborted(opts.signal)
  const state = await withRequestAbort(opts.signal, () =>
    connectorsLarkUserAuth({ action: "snapshot", adapterId: opts.accountId })
  )
  throwIfRequestAborted(opts.signal)
  if (!state.configured) throw new DocsProviderError("notConfigured")
  if (
    opts.expectedAuthorizationEpoch !== undefined &&
    state.authorizationEpoch !== opts.expectedAuthorizationEpoch
  )
    throw new DocsProviderError("notAuthorized")
  throwIfRequestAborted(opts.signal)
  return state.authorizationEpoch
}

/** `parseLarkResourceUrl` kinds → provider kinds. `docx` and `doc` both read as a document. */
const RESOURCE_KIND_TO_DOC_KIND: Record<string, RemoteDocKind> = {
  docx: "doc",
  doc: "doc",
  wiki: "wiki",
  sheet: "sheet",
  bitable: "bitable",
}

/**
 * The string `fetchLarkDocAsRawSource` parses. It takes a URL or a bare token,
 * so a search hit (token only, tenant host unknown) carries its source type
 * separately rather than inferring the kind from a historic token prefix.
 */
function docInputFor(ref: RemoteDocRef): string {
  return ref.url ?? ref.id
}

export const larkDocsProvider: DocsProvider = {
  id: LARK_PROVIDER_ID,
  mentionPrefix: "lark:",
  kinds: ["doc", "wiki", "sheet", "bitable"],
  // Feishu's open APIs send no CORS headers, so only the Rust
  // `connectors_http_request` bridge can reach them. See `DocsProvider.hosts`.
  hosts: ["tauri"],

  async listAccounts(): Promise<DocsProviderAccount[]> {
    const rows = await listAdapterInstancesByType(LARK_PROVIDER_ID)
    const accounts = await Promise.all(
      rows
        .filter((row) => row.enabled)
        .map(async (row) => {
          const state = await connectorsLarkUserAuth({ action: "snapshot", adapterId: row.id })
          if (!state.configured) return null
          return {
            id: row.id,
            label: state.accountLabel
              ? `${row.displayName} · ${state.accountLabel}`
              : row.displayName,
            authorizationEpoch: state.authorizationEpoch,
            searchable:
              Boolean(state.accessToken) && hasLarkDocumentSearchScope(state.scopes ?? []),
          }
        })
    )
    return accounts.filter((account): account is NonNullable<typeof account> => account !== null)
  },

  subscribeAccounts(listener) {
    const stopCredentials = onCredentialsRotated(() => listener())
    const stopNative = localTransport.subscribe("lark-user-authorization-changed", listener)
    return () => {
      stopCredentials()
      stopNative()
    }
  },

  matchRef(input) {
    const ref = parseLarkResourceUrl(input)
    if (!ref) return null
    const kind = RESOURCE_KIND_TO_DOC_KIND[ref.kind]
    if (!kind) return null
    return {
      kind,
      id: ref.token,
      ...(ref.host ? { url: input.trim() } : {}),
    }
  },

  async search(query: string, opts: DocsProviderSearchOptions): Promise<RemoteDocRef[]> {
    try {
      opts = { ...opts, expectedAuthorizationEpoch: await assertLarkAuthorization(opts) }
      throwIfRequestAborted(opts.signal)
      const refs = await withLarkAuthedApi(
        {
          adapterId: opts.accountId,
          requireUserIdentity: true,
          expectedAuthorizationEpoch: opts.expectedAuthorizationEpoch,
          signal: opts.signal,
          maxResponseBytes: MAX_REMOTE_DOC_RESPONSE_BYTES,
        },
        (api) => searchLarkDocs(api, query, opts.limit)
      )
      await assertLarkAuthorization(opts)
      throwIfRequestAborted(opts.signal)
      return refs
    } catch (err) {
      throwIfRequestAborted(opts.signal)
      throw toDocsProviderError(err)
    }
  },

  async fetch(ref: RemoteDocRef, opts: DocsProviderCallOptions): Promise<RemoteDocContent> {
    try {
      opts = {
        ...opts,
        expectedAuthorizationEpoch:
          opts.expectedAuthorizationEpoch ?? ref.accountBinding?.authorizationEpoch,
      }
      assertRemoteDocBinding(
        ref,
        opts.accountId,
        opts.expectedAuthorizationEpoch ?? ref.accountBinding?.authorizationEpoch
      )
      opts = { ...opts, expectedAuthorizationEpoch: await assertLarkAuthorization(opts) }
      throwIfRequestAborted(opts.signal)
      let bodyRef = ref
      let wikiTitle = ""
      const apiOptions = {
        adapterId: opts.accountId,
        expectedAuthorizationEpoch: opts.expectedAuthorizationEpoch,
        signal: opts.signal,
        maxResponseBytes: MAX_REMOTE_DOC_RESPONSE_BYTES,
      }
      if (ref.kind === "wiki") {
        const node = await withLarkAuthedApi(apiOptions, (api) => resolveLarkWikiNode(api, ref.id))
        throwIfRequestAborted(opts.signal)
        const kind = RESOURCE_KIND_TO_DOC_KIND[node.objType]
        if (!kind || kind === "wiki")
          throw new DocsProviderError("unsupportedType", { type: node.objType })
        wikiTitle = node.title
        bodyRef = { ...ref, kind, id: node.token, url: undefined, sourceType: node.objType }
      }
      if (bodyRef.kind === "doc") {
        const fetched = await fetchLarkDocAsRawSource(docInputFor(bodyRef), {
          adapterId: opts.accountId,
          expectedAuthorizationEpoch: opts.expectedAuthorizationEpoch,
          signal: opts.signal,
          maxResponseBytes: MAX_REMOTE_DOC_RESPONSE_BYTES,
          ...(bodyRef.sourceType === "doc" || bodyRef.sourceType === "docx"
            ? { kind: bodyRef.sourceType }
            : {}),
        })
        await assertLarkAuthorization(opts)
        throwIfRequestAborted(opts.signal)
        const clamped = clampDocText(fetched.text)
        return {
          ref: { ...ref, title: wikiTitle || fetched.title },
          title: wikiTitle || fetched.title,
          text: clamped.text,
          format: "text",
          truncated: clamped.truncated,
        }
      }

      if (bodyRef.kind !== "sheet" && bodyRef.kind !== "bitable")
        throw new DocsProviderError("unsupportedType", { type: bodyRef.kind })
      const read = await withLarkAuthedApi(apiOptions, (api) =>
        bodyRef.kind === "sheet"
          ? readLarkSpreadsheet(api, bodyRef.id)
          : readLarkBitable(api, bodyRef.id)
      )
      await assertLarkAuthorization(opts)
      throwIfRequestAborted(opts.signal)
      if (!read.text.trim()) {
        throw new DocsProviderError("empty", { title: read.title })
      }
      const clamped = clampDocText(read.text)
      return {
        ref: { ...ref, title: wikiTitle || read.title },
        title: wikiTitle || read.title,
        text: clamped.text,
        format: "csv",
        truncated: read.truncated || clamped.truncated,
      }
    } catch (err) {
      throwIfRequestAborted(opts.signal)
      throw toDocsProviderError(err)
    }
  },
}
