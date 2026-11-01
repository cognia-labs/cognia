/**
 * Google Workspace remote document provider (ADR-0134).
 *
 * Consumes a Google Host connection whose scopes permit document reads. The
 * Host, shared with other Google consumers, owns identity and credentials.
 *
 * Desktop-only for a concrete reason, not a policy one: Google's installed-app
 * flow permits only a loopback redirect, and the loopback listener is the Rust
 * connectors server (`/oauth/docs/google/callback`).
 */

import { admitPersonalCredential } from "@/lib/execution/personal-credential"
import { clampDocText } from "@/lib/docs-providers/limits"
import {
  assertRemoteDocBinding,
  resolveDocsAccountBinding,
} from "@/lib/docs-providers/account-binding"
import {
  listGoogleConnections,
  resolveGoogleConnection,
} from "@/lib/auth-providers/google/host-auth"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"
import {
  DocsProviderError,
  type DocsProvider,
  type DocsProviderAccount,
  type DocsProviderCallOptions,
  type DocsProviderSearchOptions,
  type RemoteDocContent,
  type RemoteDocRef,
} from "@/lib/docs-providers/types"
import {
  getDocsOAuthCompletion,
  registerDocsOAuthCompletion,
} from "@/lib/docs-providers/oauth-deep-link"
import { completeGoogleDocsAuth } from "./auth"
import { GOOGLE_DOCS_SCOPES } from "./config"
import { subscribeGoogleStateChanged } from "./state"
import {
  googleHttp,
  throwIfGoogleRequestAborted,
  withGoogleRequestAbort,
  type GoogleHttpFn,
} from "./http"
import { parseGoogleDocUrl, googleDocUrl } from "./url"
import {
  exportGoogleDoc,
  getGoogleFileName,
  readGoogleSpreadsheet,
  searchGoogleDocs,
  type GoogleApiContext,
} from "./api"

export const GOOGLE_PROVIDER_ID = "google"

/** Stored pre-connection bindings remain readable only when selection is unambiguous. */
export const GOOGLE_ACCOUNT_ID = "default"

export interface GoogleProviderDeps {
  http?: GoogleHttpFn
  accessToken?: () => Promise<string>
}

let deps: GoogleProviderDeps = {}

/** Test seam — inject the transport and token resolver. */
export function __setGoogleProviderDepsForTests(next: GoogleProviderDeps): void {
  deps = next
}

async function assertGoogleEpoch(
  accountId: string,
  revision?: number,
  credentialContext?: DocsProviderCallOptions["credentialContext"]
) {
  try {
    const connection = await resolveGoogleConnection(accountId, revision, credentialContext)
    if (
      connection.status !== "connected" ||
      !GOOGLE_DOCS_SCOPES.every((scope) => connection.scopes.includes(scope))
    )
      throw new DocsProviderError("notAuthorized")
    return connection
  } catch (error) {
    if (error instanceof DocsProviderError) throw error
    throw new DocsProviderError("notAuthorized")
  }
}

type BoundGoogleContext = GoogleApiContext & { accountId: string; revision: number }
async function context(opts: DocsProviderCallOptions): Promise<BoundGoogleContext> {
  const signal = opts.signal
  throwIfGoogleRequestAborted(signal)
  const admission = await admitPersonalCredential(opts.credentialContext, {
    source: "google-docs",
    person: opts.accountId,
  })
  if (!admission.ok) throw new DocsProviderError("notAuthorized")
  if (opts.accountId === GOOGLE_ACCOUNT_ID) {
    const resolved = await resolveDocsAccountBinding(
      googleDocsProvider,
      {
        accountId: opts.accountId,
        authorizationEpoch: opts.expectedAuthorizationEpoch,
      },
      undefined,
      { credentialContext: opts.credentialContext }
    )
    if (!resolved) throw new DocsProviderError("notAuthorized")
    opts = {
      ...opts,
      accountId: resolved.accountId,
      expectedAuthorizationEpoch: resolved.authorizationEpoch,
    }
  }
  const expected =
    opts.expectedAuthorizationEpoch === undefined
      ? undefined
      : Number(opts.expectedAuthorizationEpoch)
  if (expected !== undefined && !Number.isSafeInteger(expected))
    throw new DocsProviderError("notAuthorized")
  const connection = await assertGoogleEpoch(opts.accountId, expected, opts.credentialContext)
  let accessToken: string
  try {
    accessToken = await withGoogleRequestAbort(
      signal,
      deps.accessToken ??
        (async () =>
          (
            await getConnectionManager().getCredentials(connection.id, {
              minValidityMs: 60_000,
              credentialContext: opts.credentialContext,
            })
          ).accessToken)
    )
  } catch (error) {
    throwIfGoogleRequestAborted(signal)
    // Rust publishes invalid_grant as needs-reauth; preserve that outcome
    // instead of presenting an authorization failure as a network outage.
    await assertGoogleEpoch(connection.id, connection.revision, opts.credentialContext)
    throw error
  }
  await assertGoogleEpoch(connection.id, connection.revision, opts.credentialContext)
  throwIfGoogleRequestAborted(signal)
  return {
    http: deps.http ?? googleHttp,
    accessToken,
    signal,
    accountId: connection.id,
    revision: connection.revision,
  }
}

export const googleDocsProvider: DocsProvider = {
  id: GOOGLE_PROVIDER_ID,
  mentionPrefix: "gdoc:",
  // No Bitable counterpart exists in Google Workspace, and Slides has no useful
  // text read, so the picker never offers either for this provider.
  kinds: ["doc", "sheet"],
  // Google's APIs are CORS-friendly, but its installed-app OAuth redirect must
  // land on the Rust loopback listener. See `DocsProvider.hosts`.
  hosts: ["tauri"],

  async listAccounts(options): Promise<DocsProviderAccount[]> {
    return (await listGoogleConnections(options?.credentialContext))
      .filter(
        (connection) =>
          connection.status === "connected" &&
          GOOGLE_DOCS_SCOPES.every((scope) => connection.scopes.includes(scope))
      )
      .map((connection) => ({
        id: connection.id,
        label: connection.accountLabel,
        authorizationEpoch: String(connection.revision),
      }))
  },

  async resolveLegacyAccount(binding, options) {
    if (binding.accountId !== GOOGLE_ACCOUNT_ID) return null
    const accounts = await googleDocsProvider.listAccounts(options)
    return accounts.length === 1 ? accounts[0] : null
  },

  subscribeAccounts(listener) {
    const stopNative = subscribeGoogleStateChanged(listener)
    const stopConnections = getConnectionManager().onDidChange((event) => {
      if (event.providerId === GOOGLE_PROVIDER_ID) listener()
    })
    return () => {
      stopNative()
      stopConnections()
    }
  },

  matchRef(input) {
    const ref = parseGoogleDocUrl(input)
    if (!ref) return null
    return { kind: ref.kind, id: ref.id, url: googleDocUrl(ref.kind, ref.id) }
  },

  async search(query: string, opts: DocsProviderSearchOptions): Promise<RemoteDocRef[]> {
    const ctx = await context(opts)
    const refs = await searchGoogleDocs(ctx, query, opts.limit)
    await assertGoogleEpoch(ctx.accountId, ctx.revision, opts.credentialContext)
    return refs
  },

  async fetch(ref: RemoteDocRef, opts: DocsProviderCallOptions): Promise<RemoteDocContent> {
    opts = {
      ...opts,
      expectedAuthorizationEpoch:
        opts.expectedAuthorizationEpoch ?? ref.accountBinding?.authorizationEpoch,
    }
    assertRemoteDocBinding(ref, opts.accountId, opts.expectedAuthorizationEpoch)
    const ctx = await context(opts)
    if (ref.accountBinding)
      ref = {
        ...ref,
        accountBinding: { accountId: ctx.accountId, authorizationEpoch: String(ctx.revision) },
      }
    if (ref.kind === "doc") {
      const [read, name] = await Promise.all([
        exportGoogleDoc(ctx, ref.id),
        // A ref from a pasted URL carries the id as its title; ask Drive for
        // the real name so the attachment is not called `1AbC_dEf…`.
        ref.title === ref.id ? getGoogleFileName(ctx, ref.id) : Promise.resolve(ref.title),
      ])
      if (!read.text.trim()) throw new DocsProviderError("empty", { title: name })
      const clamped = clampDocText(read.text)
      await assertGoogleEpoch(ctx.accountId, ctx.revision, opts.credentialContext)
      return {
        ref: { ...ref, title: name },
        title: name,
        text: clamped.text,
        format: read.format,
        truncated: clamped.truncated,
      }
    }

    if (ref.kind !== "sheet") {
      throw new DocsProviderError("unsupportedType", { type: ref.kind })
    }
    const read = await readGoogleSpreadsheet(ctx, ref.id)
    if (!read.text.trim()) throw new DocsProviderError("empty", { title: read.title })
    const clamped = clampDocText(read.text)
    await assertGoogleEpoch(ctx.accountId, ctx.revision, opts.credentialContext)
    return {
      ref: { ...ref, title: read.title },
      title: read.title,
      text: clamped.text,
      format: "csv",
      truncated: read.truncated || clamped.truncated,
    }
  },
}

// Registered at module load, next to the provider it completes, so the deep-link
// router never has to know which providers exist. The registry can outlive a reload.
if (!getDocsOAuthCompletion(GOOGLE_PROVIDER_ID)) {
  registerDocsOAuthCompletion(GOOGLE_PROVIDER_ID, async (callback, credentialContext) => {
    await completeGoogleDocsAuth(
      {
        code: callback.code,
        state: callback.state,
        error: callback.error,
        errorDescription: callback.errorDescription,
      },
      credentialContext
    )
  })
}
