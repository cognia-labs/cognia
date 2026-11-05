/**
 * What a connector vendor contributes to the IM framework (ADR-0250 §14,
 * vendor layer 3).
 *
 * The framework under `lib/connectors/` names no vendor and imports no vendor
 * implementation. Where it needs vendor behaviour without a live adapter at
 * hand — a static table, a fallback card, a startup service — it looks the
 * platform up here and calls the hook, so a branch like
 * `if (row.type === "lark")` becomes `connectorVendor(row.type)?.hook?.(…)`.
 * Behaviour a running adapter owns stays on `PlatformAdapter` (for example
 * `runPresentation`); this seam is host-internal and is not part of the plugin
 * contract.
 *
 * The vendor list is `lib/connectors/adapters/_vendors.ts`, which may import
 * only `adapters/<vendor>/contribution.ts` files (`pnpm audit:modules`, G8).
 * A contribution keeps its eager imports to light constants and loads the rest
 * inside its hooks, because every framework file that reads this seam pulls the
 * list in.
 */

import type { PlatformAdapter } from "@/types/connectors"
import type { Capability } from "@/types/connectors/capability"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { AvatarSource, PlatformAvatarTarget } from "./platform-avatar"
import { CONNECTOR_VENDORS } from "./adapters/_vendors"

/** Something a contribution started that the runtime stops on teardown. */
export interface ConnectorVendorService {
  dispose(): void
}

/** What the avatar resolver hands a vendor's avatar lookup. */
export interface ConnectorVendorAvatarContext {
  target: PlatformAvatarTarget
  adapter: AdapterInstanceRow
  /** False once the database or the adapter's credentials changed under the lookup. */
  active(): boolean
  /** The framework's URL screen: only a public HTTPS URL on the vendor's hosts passes. */
  publicUrl(value: unknown, providerResponse?: boolean): string | undefined
}

export interface ConnectorVendorContribution {
  /** The `PlatformKind` this contribution serves. */
  readonly platform: string
  /** Static channel capabilities, read without building an adapter. */
  readonly capabilities?: readonly Capability[]
  /** Build the live adapter for a persisted row. */
  buildAdapter?(row: AdapterInstanceRow): Promise<PlatformAdapter>
  /** Load the probe that confirms an adapter's own identity at start and on demand. */
  loadIdentityProbe?(): Promise<(adapterId: string, options: object) => Promise<unknown>>
  /** Complete an OAuth code exchange the deep-link router validated. */
  completeOAuth?(code: string, state: string): Promise<void>
  /** A transport that waits for upstream pushes and needs a liveness ping when idle. */
  readonly passiveTransport?: {
    applies(row: AdapterInstanceRow): boolean
    ping(row: AdapterInstanceRow): Promise<boolean>
    /** Heartbeat reason recorded when the ping fails. */
    readonly failureReason: string
  }
  /** Avatar hosts the URL screen accepts, and the lookup for this vendor's actors. */
  readonly avatar?: {
    readonly hosts: readonly string[]
    resolve(context: ConnectorVendorAvatarContext): Promise<AvatarSource | undefined>
  }
  /** Long-lived services the connector runtime starts once and disposes on teardown. */
  startRuntimeServices?(): ConnectorVendorService[]
}

/** Every contributed vendor, in catalog order. */
export function connectorVendors(): readonly ConnectorVendorContribution[] {
  return CONNECTOR_VENDORS
}

/** The contribution for one platform, or undefined when its vendor contributes none. */
export function connectorVendor(platform: string): ConnectorVendorContribution | undefined {
  return CONNECTOR_VENDORS.find((vendor) => vendor.platform === platform)
}
