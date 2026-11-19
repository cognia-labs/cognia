import type { AuthState } from "./types.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomState, buildProvider } from "../../../mcp-oauth-helper.mjs"

test("randomState returns a fresh 16-character hex value for each authorization", () => {
  const first = randomState()
  const second = randomState()
  assert.match(first, /^[0-9a-f]{16}$/)
  assert.match(second, /^[0-9a-f]{16}$/)
  assert.notEqual(first, second)
})

test("buildProvider reads/writes the seeded state and stamps expiry", (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000)
  const state: AuthState = { tokens: { access_token: "seed", token_type: "Bearer" } }
  const provider = buildProvider(state, {
    redirectUrl: "http://127.0.0.1:1/callback",
    state: "csrf",
  })
  assert.equal(provider.redirectUrl, "http://127.0.0.1:1/callback")
  assert.equal(provider.state(), "csrf")
  assert.deepEqual(provider.tokens(), { access_token: "seed", token_type: "Bearer" })

  provider.saveClientInformation({ client_id: "c" })
  assert.deepEqual(state.clientInformation, { client_id: "c" })

  provider.saveCodeVerifier("v")
  assert.equal(provider.codeVerifier(), "v")

  provider.saveTokens({ access_token: "new", token_type: "Bearer", expires_in: 100 })
  assert.equal(state.tokens!.access_token, "new")
  assert.equal(state.codeVerifier, undefined) // cleared on token save
  assert.equal(state.expiresAtMs, 1_800_000_100_000)

  // A later refresh replaces the expiry using that save's clock and lifetime.
  t.mock.method(Date, "now", () => 1_800_000_050_000)
  provider.saveTokens({ access_token: "refreshed", token_type: "Bearer", expires_in: 20 })
  assert.equal(state.expiresAtMs, 1_800_000_070_000)
  provider.saveTokens({ access_token: "expired", token_type: "Bearer", expires_in: 0 })
  assert.equal(state.expiresAtMs, 1_800_000_050_000)
})

test("buildProvider.codeVerifier throws when none is saved", () => {
  const provider = buildProvider({}, { redirectUrl: "http://x/callback" })
  assert.throws(() => provider.codeVerifier(), /No PKCE code verifier/)
})
