/**
 * Feishu/Lark remote document provider (ADR-0134).
 *
 * Credentials are NOT its own: it acts as a bound Lark connector instance, so
 * document reading reuses the connected adapter's credentials and requires
 * the corresponding document permissions. Document ACLs are evaluated against
 * that identity. `listAccounts` projects connected Host user connections.
 *
 * Document bodies come straight from `fetchLarkDocAsRawSource`; only the two
 * grid-shaped kinds (电子表格 / 多维表格) needed new readers, and those run on
 * the shared `withLarkAuthedApi` harness that the doc fetcher itself now uses.
 */

import { hasLarkDocumentSearchScope } from "@cognia/feishu-protocol"
import { admitPersonalCredential } from "@/lib/execution/personal-credential"
import { withLarkAuthedApi } from "@/lib/auth-providers/feishu/authed-api"
import { listLarkConnections, larkConnectionAdapter } from "@/lib/auth-providers/feishu/host-auth"
import { onCredentialsRotated } from "@/lib/connectors/credentials-events"
import { localTransport } from "@/lib/tauri/transport-instance"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"
import { throwIfRequestAborted, withRequestAbort } from "@/lib/network/request-abort"
import { fetchLarkDocAsRawSource, resolveLarkWikiNode } from "@/lib/twin/ingest/lark-doc-fetcher"
import { parseLarkResourceUrl } from "@cognia/feishu-protocol"
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

async function assertLarkAuthorization(opts: DocsProviderCallOptions) {
  throwIfRequestAborted(opts.signal)
  const resolved = await withRequestAbort(opts.signal, () =>
    larkConnectionAdapter(
      opts.accountId,
      opts.expectedAuthorizationEpoch === undefined
        ? undefined
        : Number(opts.expectedAuthorizationEpoch)
    )
  )
  throwIfRequestAborted(opts.signal)
  const decision = await admitPersonalCredential(opts.credentialContext, {
    source: "lark-user",
    person: resolved.adapterId,
  })
  if (!decision.ok) throw new DocsProviderError("notAuthorized")
  return resolved
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

  async listAccounts(options): Promise<DocsProviderAccount[]> {
    return (await listLarkConnections(options?.credentialContext))
      .filter((row) => row.status === "connected")
      .map((row) => ({
        id: row.id,
        label: row.accountLabel,
        authorizationEpoch: String(row.revision),
        searchable: hasLarkDocumentSearchScope(row.scopes),
      }))
  },

  subscribeAccounts(listener) {
    const stopCredentials = onCredentialsRotated(() => listener())
    const stopNative = localTransport.subscribe("lark-user-authorization-changed", listener)
    const stopConnections = getConnectionManager().onDidChange((event) => {
      if (event.providerId === LARK_PROVIDER_ID) listener()
    })
    return () => {
      stopCredentials()
      stopNative()
      stopConnections()
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
      const { connection, adapterId } = await assertLarkAuthorization(opts)
      opts = { ...opts, expectedAuthorizationEpoch: String(connection.revision) }
      throwIfRequestAborted(opts.signal)
      const refs = await withLarkAuthedApi(
        {
          adapterId,
          credentialContext: opts.credentialContext,
          identity: "user",
          expectedAuthorizationEpoch: connection.hostMetadata!.authorizationEpoch,
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
      const { connection, adapterId } = await assertLarkAuthorization(opts)
      opts = { ...opts, expectedAuthorizationEpoch: String(connection.revision) }
      throwIfRequestAborted(opts.signal)
      let bodyRef = ref
      let wikiTitle = ""
      const apiOptions = {
        identity: "user" as const,
        adapterId,
        expectedAuthorizationEpoch: connection.hostMetadata!.authorizationEpoch,
        credentialContext: opts.credentialContext,
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
          adapterId,
          expectedAuthorizationEpoch: connection.hostMetadata!.authorizationEpoch,
          credentialContext: opts.credentialContext,
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
