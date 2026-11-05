/**
 * Principal resolution for inbound events and callbacks (plan 2026-07-24
 * Phase 1, §3.2): the vocabulary every caller shares, and the one entry point.
 *
 * A platform whose vendor keeps a principal registry resolves through its
 * contribution (`lib/connectors/vendor-contribution.ts`, `principals`); Lark's
 * maps the verified envelope's `tenantKey + appId + openId` to a registered
 * principal and its Cognia account (`adapters/lark/principal/resolve.ts`).
 * FAIL CLOSED: whenever a registry is on and the sender cannot be positively
 * resolved to the currently active account, the event must not create an
 * agent turn and must never fall back to the default local account — callers
 * route every non-`resolved` outcome to the vendor's `handleUnresolved`.
 * Every other platform reports `legacy`, today's ungated behaviour.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { FeishuPrincipalRow, FeishuTenantRow } from "@/lib/db/connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { connectorVendor } from "../vendor-contribution"

/**
 * Must stay in lockstep with `HEADLESS_LOCAL_ACCOUNT_ID` in
 * `cli/src/serve/account.ts` and `crates/cognia-server/src/main.rs` (lib
 * code cannot import from cli/).
 */

export interface IdentityScope {
  tenantKey?: string
  appId?: string
  /**
   * The acting user's `union_id`, read from the same verified envelope.
   * Identity evidence, never an authorization key: resolution still matches
   * on `tenantKey + appId + openId`. It is recorded on bind requests and
   * principals, and it is how a signed-in owner is recognised
   * (`principal/self-bind.ts`).
   */
  unionId?: string
}

export type PrincipalResolution =
  | {
      status: "resolved"
      principal: FeishuPrincipalRow
      tenant: FeishuTenantRow
      accountId: string
    }
  /** Registry off, or a platform without one — today's behavior, no gating. */
  | { status: "legacy" }
  | {
      status: "unbound"
      tenantKey?: string
      appId?: string
      unionId?: string
      openIdHash: string
    }
  | { status: "principal_disabled"; principal: FeishuPrincipalRow }
  | { status: "tenant_disabled"; tenant: FeishuTenantRow }
  /** Registry maps the sender to a DIFFERENT account than this runtime serves. */
  | { status: "cross_account"; declaredAccountId: string }

export interface ResolvePrincipalInput {
  platform: PlatformKind
  adapterRow: Pick<AdapterInstanceRow, "settings" | "lastWhoamiResult">
  /** The platform user id of the sender / clicker (a Lark open_id). */
  remoteUserId: string
  identityScope?: IdentityScope
  /** Injectable for tests; defaults to `getActiveRuntimeAccountId()`. */
  activeAccountId?: string
}

/**
 * Audit-safe stand-in for an open_id — sha256 hex, first 12 chars. Web Crypto
 * so it works in the browser, Tauri webview, and the Node headless brain
 * (jsdom tests get `subtle` from jest.setup.ts).
 */
export async function hashOpenId(openId: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("hashOpenId: Web Crypto unavailable")
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(openId))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12)
}

/**
 * In-memory stamp the bus writes onto `event.channelData` after a positive
 * resolution, so downstream run-creation sites can attribute initiators
 * without re-resolving. Recovery replays re-enter the bus pipeline, which
 * re-stamps — the registry stays the authority, never this denorm.
 */
export interface ResolvedPrincipalStamp {
  principalId: string
  accountId: string
}

/** Typed reader for the `channelData.resolvedPrincipal` stamp set by the bus. */
export function readResolvedPrincipal(
  channelData: Record<string, unknown> | undefined
): ResolvedPrincipalStamp | undefined {
  const raw = channelData?.resolvedPrincipal
  if (!raw || typeof raw !== "object") return undefined
  const stamp = raw as Record<string, unknown>
  if (typeof stamp.principalId !== "string" || typeof stamp.accountId !== "string") return undefined
  return { principalId: stamp.principalId, accountId: stamp.accountId }
}

/** Typed reader for the `channelData.identityScope` stamp set by the parser. */
export function readIdentityScope(
  channelData: Record<string, unknown> | undefined
): IdentityScope | undefined {
  const raw = channelData?.identityScope
  if (!raw || typeof raw !== "object") return undefined
  const scope = raw as Record<string, unknown>
  const tenantKey = typeof scope.tenantKey === "string" ? scope.tenantKey : undefined
  const appId = typeof scope.appId === "string" ? scope.appId : undefined
  const unionId =
    typeof scope.unionId === "string" && scope.unionId.length > 0 ? scope.unionId : undefined
  if (!tenantKey && !appId) return undefined
  return { tenantKey, appId, ...(unionId ? { unionId } : {}) }
}

/**
 * Account scope this runtime is currently serving.
 *
 * Delegates to `lib/accounts/active-account-id`, which is where the logic now
 * lives so callers outside this module graph (the dock's account-scoped layout
 * keys) can ask the same question without importing connector machinery. Kept
 * as a re-export rather than removed: this name is what the connector call
 * sites read, and "which account is this Lark event for" is a connectors
 * concern even when the answer comes from elsewhere.
 */
export function getActiveRuntimeAccountId(): string {
  return getActiveAccountId()
}

export async function resolveConnectorPrincipal(
  input: ResolvePrincipalInput
): Promise<PrincipalResolution> {
  const principals = connectorVendor(input.platform)?.principals
  return principals ? principals.resolve(input) : { status: "legacy" }
}
