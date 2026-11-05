/**
 * OAuth handler registry — Task 42 + Task 80 + Task 93, extended at
 * ADR-0009 v41 / A4 (D2) to land Lark's code-exchange completion.
 *
 * Maps platform kind to the async function that completes the OAuth code
 * exchange and stores the resulting credentials in the keyring.
 *
 * Telegram and Discord do not use OAuth. Slack and the contributed vendors
 * route to platform-specific completion handlers that resolve the adapter row,
 * exchange the code, store credentials in the keyring, and stamp connected
 * metadata back onto the adapter settings.
 *
 * The ConnectorDeepLinkRouter calls the registered handler after
 * validating the OAuth state parameter — state is also forwarded into
 * the handler so platform handlers can decode `adapterId` from a
 * platform-specific state shape (`<platform>:<adapterId>:<nonce>`).
 */

import type { PlatformKind } from "@/types/connectors/platform-kind"
import { connectorVendors } from "./vendor-contribution"

/** sessionStorage/localStorage key shared by the OAuth `state` producer (connector config forms) and the deep-link validator (ConnectorDeepLinkRouter) — the two must never drift. */
export { CONNECTOR_OAUTH_STATE_KEY } from "./oauth-state"

export type OAuthHandler = (code: string, state: string) => Promise<void>

/**
 * Global registry: PlatformKind → OAuth completion handler.
 */
export const oauthRegistry = new Map<PlatformKind, OAuthHandler>()

// ---------------------------------------------------------------------------
// Slack — fully wired (ADR-0009 D1, completed in the IM connector uplift).
// Routes cognia://connector/oauth/slack?code=...&state=slack:<adapterId>:<nonce>
// through `handleSlackOAuth`, which swaps the code for a bot token via
// oauth.v2.access and persists it in the keyring under `botToken`.
// ---------------------------------------------------------------------------

oauthRegistry.set("slack", async (code: string, state: string): Promise<void> => {
  const { handleSlackOAuth } = await import("./adapters/slack/oauth-handler")
  await handleSlackOAuth(code, { state })
})

// ---------------------------------------------------------------------------
// Contributed vendors (ADR-0250 §14): a vendor that completes an OAuth code
// exchange supplies `completeOAuth` in its `adapters/<vendor>/contribution.ts`
// (Lark: the send-as-user flow in `lib/auth-providers/feishu/oauth-handler.ts`).
// ---------------------------------------------------------------------------

for (const vendor of connectorVendors()) {
  if (vendor.completeOAuth) oauthRegistry.set(vendor.platform as PlatformKind, vendor.completeOAuth)
}
