import {
  defineAuthProvider,
  definePlugin,
  definePluginManifest,
  AuthRefreshRejected,
  type AuthCredentialSet,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)
const ORIGIN = "https://api.example-tracker.test"
const CLIENT_ID = "cognia-example-public-client"

/** Tokens are returned only to the Host's coordinated callbacks, never persisted here. */
export function createProvider(ctx: Pick<PluginContext, "auth" | "network">) {
  async function exchange(
    client: { clientId: string; issuer: string },
    params: Record<string, string>,
    scopes: string[]
  ): Promise<AuthCredentialSet> {
    const { status, body } = await ctx.auth.exchangeConfidential({
      providerId: "example-tracker",
      tokenUrl: `${ORIGIN}/oauth/token`,
      clientId: client.clientId,
      issuer: client.issuer,
      placement: "none",
      params,
    })
    if (body.error === "invalid_grant") throw new AuthRefreshRejected()
    if (status < 200 || status >= 300) throw new Error(`Token exchange failed (${status})`)
    if (
      typeof body.access_token !== "string" ||
      !body.access_token ||
      (body.token_type !== undefined && body.token_type !== "Bearer") ||
      (body.refresh_token !== undefined && typeof body.refresh_token !== "string") ||
      (body.scope !== undefined && typeof body.scope !== "string") ||
      (body.expires_in !== undefined &&
        (typeof body.expires_in !== "number" ||
          !Number.isFinite(body.expires_in) ||
          body.expires_in <= 0))
    )
      throw new Error("Invalid token response")
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token as string | undefined,
      scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : scopes,
      ...(typeof body.expires_in === "number"
        ? { expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString() }
        : {}),
    }
  }

  return defineAuthProvider({
    management: "host",
    id: "example-tracker",
    label: "Example Tracker",
    async authorize(attempt) {
      if (!attempt.redirectUri || !attempt.codeChallenge) throw new Error("PKCE attempt required")
      const url = new URL(`${ORIGIN}/oauth/authorize`)
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: attempt.clientId,
        redirect_uri: attempt.redirectUri,
        state: attempt.attemptId,
        code_challenge: attempt.codeChallenge,
        code_challenge_method: "S256",
        scope: attempt.scopes.join(" "),
      }).toString()
      return { url: url.href }
    },
    async exchange(attempt, callback) {
      if (!callback.code || !attempt.codeVerifier || !attempt.redirectUri)
        throw new Error("Accepted PKCE callback required")
      return exchange(
        attempt,
        {
          grant_type: "authorization_code",
          code: callback.code,
          code_verifier: attempt.codeVerifier,
          redirect_uri: attempt.redirectUri,
        },
        attempt.scopes
      )
    },
    async refresh(lineage) {
      lineage.signal?.throwIfAborted()
      if (!lineage.credentials.refreshToken) throw new AuthRefreshRejected()
      const refreshed = await exchange(
        lineage.identity,
        {
          grant_type: "refresh_token",
          refresh_token: lineage.credentials.refreshToken,
        },
        lineage.credentials.scopes
      )
      lineage.signal?.throwIfAborted()
      return {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? lineage.credentials.refreshToken,
      }
    },
    async describe(tokens) {
      // This callback belongs to the auth provider. Business plugins never receive this token.
      const response = await ctx.network.fetch<unknown>(`${ORIGIN}/me`, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        responseType: "json",
      })
      const identity = response.data as { id?: unknown; name?: unknown } | null
      if (
        !response.ok ||
        !identity ||
        typeof identity.id !== "string" ||
        !identity.id ||
        typeof identity.name !== "string" ||
        !identity.name
      )
        throw new Error("Invalid identity response")
      return {
        issuer: ORIGIN,
        clientId: CLIENT_ID,
        principal: { id: identity.id, kind: "user" as const },
        accountLabel: identity.name,
        scopes: [...tokens.scopes],
      }
    },
  })
}

export default definePlugin({
  manifest,
  async activate(ctx) {
    const dispose = ctx.auth.registerProvider(createProvider(ctx))
    return { onDisable: dispose, onUnload: dispose }
  },
})
