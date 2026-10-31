/**
 * Lark-cli auth bridge (ADR-0026).
 *
 * Pulls credentials out of the existing Lark adapter OAuth flow
 * (`lib/connectors/adapters/lark/auth.ts` + `oauth-handler.ts`) and
 * shapes them into env vars the `lark-cli` binary expects so we don't
 * force users to run `lark-cli config init` / `auth login` again.
 *
 * Resolution order:
 *   1. The authoritative root IM session's Lark adapter (cannot be overridden)
 *   2. An explicitly selected adapter in a local session
 *   3. The sole enabled Lark adapter; multiple accounts require a selection
 *
 * Reads:
 *   - keyring `<adapterId>:appId` (where the settings form and the OAuth
 *     handler store it), falling back to `settings.appId` on rows written by
 *     an older form
 *   - keyring `<adapterId>:appSecret`
 *   - keyring `<adapterId>:user_token`         (preferred — narrow scope)
 *   - keyring `<adapterId>:user_refresh_token` (used by future refresh)
 *
 * Never throws on a missing adapter — returns `{ ok: false, reason }`
 * so the skill can show a precise onboarding banner instead of crashing.
 */

import { getAdapterInstance, listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getTenantToken } from "@/lib/connectors/adapters/lark/auth"
import { observeTenantServiceData } from "@/lib/execution/acting-authority"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { resolveBuiltInSkillSessionBinding } from "../context"
import { assertLarkActingIdentity, LarkActingIdentityError } from "./acting-identity"
import type { BuiltInSkillContext } from "../types"

export type LarkAuthIdentity = "user" | "bot"

export interface LarkAuthBridgeOk {
  ok: true
  /** The adapter row that supplied credentials. */
  adapterId: string
  /** Identity the env will run lark-cli as. */
  identity: LarkAuthIdentity
  /**
   * CLI 1.0.98 environment credentials. Explicit empty values override
   * inherited profile, auth-proxy and alternate-token selectors in the
   * desktop process bridge. Credentials stay ephemeral; no CLI profile is
   * created or changed. The selected environment provider owns the account.
   */
  env: Record<string, string>
}

export type LarkAuthBridgeError =
  | { ok: false; reason: "no_adapter"; message: string }
  | { ok: false; reason: "ambiguous_adapter" | "adapter_mismatch"; message: string }
  | { ok: false; reason: "invalid_adapter"; message: string; adapterId: string }
  | { ok: false; reason: "adapter_disabled"; message: string; adapterId: string }
  | { ok: false; reason: "missing_app_id"; message: string; adapterId: string }
  | { ok: false; reason: "missing_app_secret"; message: string; adapterId: string }
  | {
      ok: false
      reason: "user_not_authorized" | "sender_not_token_owner"
      message: string
      adapterId: string
    }
  | { ok: false; reason: "tenant_token_failed"; message: string; adapterId: string }

export type LarkAuthBridgeResult = LarkAuthBridgeOk | LarkAuthBridgeError

export interface ResolveLarkAuthInput {
  context?: BuiltInSkillContext
  /**
   * Specific Cognia connection, never a local CLI profile. IM sessions
   * cannot select a different adapter; local multi-account calls must select.
   */
  adapterId?: string
  /**
   * Preferred identity:
   *   - `"user"` — uses the OAuth user_access_token; narrower scope,
   *     attributes actions to the connected user. Default.
   *   - `"bot"` — uses the tenant_access_token; broader scope, attributes
   *     actions to the app/bot. Must be explicitly selected.
   */
  identity?: LarkAuthIdentity
}

export async function resolveLarkAuth(
  input: ResolveLarkAuthInput = {}
): Promise<LarkAuthBridgeResult> {
  const selection = await resolveLarkAdapter(input)
  if (!selection.ok) return selection
  const { adapter } = selection

  const appId =
    (await safeKeyringGet(adapter.id, "appId"))?.trim() ||
    String(adapter.settings.appId ?? "").trim()
  if (!appId) {
    return {
      ok: false,
      reason: "missing_app_id",
      message: `Lark adapter "${adapter.displayName}" has no appId in the keyring.`,
      adapterId: adapter.id,
    }
  }

  const appSecret = await safeKeyringGet(adapter.id, "appSecret")
  if (!appSecret) {
    return {
      ok: false,
      reason: "missing_app_secret",
      message: `Lark adapter "${adapter.displayName}" has no appSecret in the keyring.`,
      adapterId: adapter.id,
    }
  }

  const preferred = input.identity ?? "user"
  if (preferred === "user") {
    let verified: Awaited<ReturnType<typeof assertLarkActingIdentity>>
    try {
      verified = await assertLarkActingIdentity(adapter.id, input.context)
    } catch (err) {
      if (!(err instanceof LarkActingIdentityError)) throw err
      return { ok: false, reason: err.reason, message: err.message, adapterId: adapter.id }
    }
    const userToken = verified?.accessToken ?? (await safeKeyringGet(adapter.id, "user_token"))
    if (userToken) {
      return {
        ok: true,
        adapterId: adapter.id,
        identity: "user",
        env: larkCliEnv(appId, appSecret, "user", userToken),
      }
    }
    return {
      ok: false,
      reason: "user_not_authorized",
      message: "user_not_authorized: connect Lark user OAuth before using personal Lark actions.",
      adapterId: adapter.id,
    }
  }

  if (preferred !== "bot") {
    return {
      ok: false,
      reason: "user_not_authorized",
      message: "user_not_authorized: unsupported Lark identity.",
      adapterId: adapter.id,
    }
  }

  // Bot identity (tenant_access_token).
  try {
    observeTenantServiceData(input.context?.sessionId, adapter.id, "lark-cli")
    const tenantToken = await getTenantToken({ appId, appSecret }, "service-data")
    return {
      ok: true,
      adapterId: adapter.id,
      identity: "bot",
      env: larkCliEnv(appId, appSecret, "bot", tenantToken),
    }
  } catch (err) {
    return {
      ok: false,
      reason: "tenant_token_failed",
      adapterId: adapter.id,
      message:
        err instanceof Error
          ? `Lark tenant token fetch failed: ${err.message}`
          : "Lark tenant token fetch failed.",
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Select without accessing credentials, so preflight can pin the account before approval. */
export async function resolveLarkAdapter(
  input: Pick<ResolveLarkAuthInput, "adapterId" | "context"> = {}
): Promise<{ ok: true; adapter: AdapterInstanceRow } | LarkAuthBridgeError> {
  const contextId = input.context?.larkAdapterId
  let selectedId = input.adapterId ?? contextId
  if (input.adapterId && contextId && input.adapterId !== contextId) {
    return { ok: false, reason: "adapter_mismatch", message: "Lark account selections disagree." }
  }
  if (input.context) {
    try {
      const { binding } = await resolveBuiltInSkillSessionBinding(input.context.sessionId)
      const supplied = input.context.imBinding
      if (
        (binding &&
          (binding.platform !== "lark" ||
            !binding.adapterId ||
            !binding.conversationKey ||
            (selectedId !== undefined && selectedId !== binding.adapterId))) ||
        (supplied &&
          (!binding ||
            supplied.platform !== binding.platform ||
            supplied.adapterId !== binding.adapterId ||
            supplied.conversationKey !== binding.conversationKey))
      ) {
        return {
          ok: false,
          reason: "adapter_mismatch",
          message: "Lark actions must use the connection bound to this conversation.",
        }
      }
      if (binding) selectedId = binding.adapterId
    } catch {
      return {
        ok: false,
        reason: "adapter_mismatch",
        message: "Lark conversation account binding could not be verified.",
      }
    }
  }
  try {
    let adapter: AdapterInstanceRow | undefined
    if (selectedId !== undefined) {
      adapter = await getAdapterInstance(selectedId)
    } else {
      const all = await listAdapterInstancesByType("lark")
      const enabled = all.filter((row) => row.enabled)
      if (enabled.length > 1) {
        return {
          ok: false,
          reason: "ambiguous_adapter",
          message:
            "Multiple Lark connections are enabled. Choose the intended connection explicitly with adapterId.",
        }
      }
      adapter = enabled[0] ?? (all.length === 1 ? all[0] : undefined)
    }
    if (!adapter) {
      return {
        ok: false,
        reason: "no_adapter",
        message:
          "No Lark adapter configured for this selection. Connect Lark via Settings → Connectors before invoking Lark skills.",
      }
    }
    if (adapter.type !== "lark") {
      return {
        ok: false,
        reason: "invalid_adapter",
        message: "The selected connection is not a Lark adapter.",
        adapterId: adapter.id,
      }
    }
    if (!adapter.enabled) {
      return {
        ok: false,
        reason: "adapter_disabled",
        message: `Lark adapter "${adapter.displayName}" is disabled. Enable it via Settings → Connectors.`,
        adapterId: adapter.id,
      }
    }
    return { ok: true, adapter }
  } catch {
    return {
      ok: false,
      reason: "no_adapter",
      message: "No Lark adapter could be resolved. Check the configured Lark connection.",
    }
  }
}

function larkCliEnv(
  appId: string,
  appSecret: string,
  identity: LarkAuthIdentity,
  token: string
): Record<string, string> {
  return {
    LARKSUITE_CLI_APP_ID: appId,
    LARKSUITE_CLI_APP_SECRET: appSecret,
    LARKSUITE_CLI_BRAND: "feishu",
    LARKSUITE_CLI_USER_ACCESS_TOKEN: identity === "user" ? token : "",
    LARKSUITE_CLI_TENANT_ACCESS_TOKEN: identity === "bot" ? token : "",
    LARKSUITE_CLI_DEFAULT_AS: identity,
    LARKSUITE_CLI_STRICT_MODE: identity,
    LARKSUITE_CLI_PROFILE: "",
    LARKSUITE_CLI_CONFIG_DIR: "",
    LARKSUITE_CLI_AUTH_PROXY: "",
    LARKSUITE_CLI_PROXY_KEY: "",
    LARKSUITE_CLI_TENANT_ACCESS_TOKEN_SOURCE: "",
  }
}

async function safeKeyringGet(adapterId: string, key: string): Promise<string | undefined> {
  try {
    const v = await connectorsKeyringGet(adapterId, key)
    return typeof v === "string" && v.length > 0 ? v : undefined
  } catch {
    // Keyring may be unavailable on web shell — fail soft so the caller
    // gets a clean "missing credential" reason.
    return undefined
  }
}
