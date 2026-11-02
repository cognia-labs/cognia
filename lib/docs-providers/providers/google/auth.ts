/** UI glue only. The selected Rust Host owns attempts, exchange, refresh and revoke. */
import { connectorsEnsureServer } from "@/lib/connectors/tauri/commands"
import { CONNECTORS_SERVER_PORT } from "@/lib/connectors/server-transport"
import { DocsProviderError } from "@/lib/docs-providers/types"
import { GOOGLE_DOCS_SCOPES, getGoogleDocsSettings } from "./config"
import { googleState, type GoogleDisconnectOutcome, type GoogleStateReply } from "./state"

export const GOOGLE_CALLBACK_PATH = "/oauth/docs/google/callback"
export interface GoogleAuthDeps {
  ensureServer?: (port: number) => Promise<string>
  reauthorizeLineage?: string
  clientId?: string
}

export async function beginGoogleDocsAuth(deps: GoogleAuthDeps = {}) {
  const clientId = (deps.clientId ?? (await getGoogleDocsSettings()).clientId)?.trim()
  if (!clientId) throw new DocsProviderError("notConfigured", { field: "clientId" })
  let bound: string
  try {
    bound = await (deps.ensureServer ?? connectorsEnsureServer)(CONNECTORS_SERVER_PORT)
  } catch (error) {
    throw new DocsProviderError("hostUnsupported", {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  const redirectUri = `http://127.0.0.1:${bound.split(":").pop()}${GOOGLE_CALLBACK_PATH}`
  const reply = await googleState({
    action: "begin",
    clientId,
    scopes: GOOGLE_DOCS_SCOPES,
    redirectUri,
    ...(deps.reauthorizeLineage ? { reauthorizeLineage: deps.reauthorizeLineage } : {}),
  })
  if (!reply.attempt?.authorizeUrl)
    throw new DocsProviderError("notAuthorized", { reason: "missing authorization URL" })
  return { ...reply.attempt, authorizeUrl: reply.attempt.authorizeUrl, redirectUri }
}

export async function completeGoogleDocsAuth(input: {
  code?: string
  state?: string
  clientId?: string
  error?: string
  errorDescription?: string
}): Promise<GoogleStateReply> {
  if (input.error)
    throw new DocsProviderError("notAuthorized", { reason: input.errorDescription ?? input.error })
  if (!input.state || !input.code) throw new DocsProviderError("notAuthorized")
  return googleState({
    action: "complete",
    state: input.state,
    code: input.code,
    ...(input.clientId ? { clientId: input.clientId } : {}),
  })
}

export async function pollGoogleDeviceAuth(attemptId: string): Promise<GoogleStateReply> {
  return googleState({ action: "pollDevice", attemptId })
}

export async function disconnectGoogleDocs(lineageId: string): Promise<GoogleDisconnectOutcome> {
  const reply = await googleState({ action: "disconnect", lineageId })
  if (!reply.outcome) throw new Error("Google disconnect returned no outcome")
  return reply.outcome
}
