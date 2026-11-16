/**
 * Agent Host provider credentials: set or replace the Anthropic key and
 * provider env the sidecar spawns with, and report whether a key or an
 * OAuth bearer is present. Values stay in the Host; reads return booleans.
 */
import { transport } from "@/lib/tauri"

export async function setApiKey(key: string | null): Promise<void> {
  await transport.call("claude_set_api_key", { key })
}

/**
 * Replace the Anthropic provider env (api key + optional base URL) atomically.
 * Used by the CCSwitch provider-switch flow so the sidecar restart sees a
 * coherent (key, base-url) pair rather than a half-switched state.
 *
 * Pass `null` for either field to clear it. Empty strings are treated as null
 * by the Rust side.
 *
 * `customHeaders` carries relay-required headers (e.g.
 * `{ "anthropic-beta": "context-1m-2025-08-07" }` for the 1M window), forwarded
 * as `ANTHROPIC_CUSTOM_HEADER_*` at sidecar spawn. Semantics on the Rust side:
 * `undefined` leaves the existing header set untouched (legacy callers that
 * don't manage headers); an explicit object — including `{}` — replaces it, so
 * switching to a provider without headers clears a previous relay's headers.
 */
export async function setProviderEnv(
  apiKey: string | null,
  baseUrl: string | null,
  customHeaders?: Record<string, string>
): Promise<void> {
  await transport.call("claude_set_provider_env", {
    apiKey,
    baseUrl,
    customHeaders: customHeaders ? Object.entries(customHeaders) : undefined,
  })
}

export async function hasApiKey(): Promise<boolean> {
  return transport.call<boolean>("claude_has_api_key")
}

// `setOauthBearer` was removed in ADR-0025 — the unified subscription module
// pushes the bearer into `ApiKeyState` server-side via `subscription_set_active`.
// Renderers that previously called `setOauthBearer(token)` + `restartSidecar()`
// now call `subscription_set_active("anthropic", accountId)` (see
// `lib/subscription/anthropic/sidecar-sync.ts`). The Rust-side
// `claude_set_oauth_bearer` command continues to exist for the diagnostics
// `hasOauthBearer()` read below and as a transitional surface during the
// migration window, but no renderer code calls it directly.

export async function hasOauthBearer(): Promise<boolean> {
  return transport.call<boolean>("claude_has_oauth_bearer")
}
