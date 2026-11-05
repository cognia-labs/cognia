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
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import type { RunProjectionSnapshot } from "@/types/execution/run"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { AvatarSource, PlatformAvatarTarget } from "./platform-avatar"
import type { StatusView } from "./commands/render"
import type { ApprovalCardState } from "./hitl/approval-card-state"
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

/** What the agent-run reply hands a vendor that draws the final answer itself. */
export interface ConnectorVendorFinalReplyContext {
  /** The row of the adapter that sends the answer (a respond-via sibling, or the receiver). */
  presentationAdapter?: AdapterInstanceRow
  /** The row of the adapter that received the message. */
  receivingAdapter: AdapterInstanceRow
  runId: string
  status: "done" | "interrupted"
  /** The asker's message, when the answer must quote it (native reply-quoting is off). */
  quote?: string
  elapsedMs: number
  privateChat: boolean
  /** The asker's platform user id. */
  initiator: string
  locale?: string
  /** Recovered text to show when the run produced no answer segment. */
  fallbackAnswer?: string
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
  /** How this platform's conversations read to the control commands (`commands/dispatch.ts`). */
  readonly conversations?: {
    /** Private beyond `channel.kind`, for example a topic inside a direct chat. */
    isPrivate?(event: NormalizedInboundEvent): boolean
    /** Whether the conversation's sessions are listed per chat rather than per conversation key. */
    chatScopedSessions?(event: NormalizedInboundEvent): boolean
    /** Whether `/agent verify` may run its unmentioned-delivery probe here. */
    deliveryProbe?(event: NormalizedInboundEvent): boolean
  }
  /** Native drawings of control-command replies; plain text when absent. */
  readonly commands?: {
    renderReply?(
      command: string,
      text: string,
      outcome: "applied" | "denied" | "unknown"
    ): Promise<MessageSegment>
    renderStatus?(view: StatusView): Promise<MessageSegment>
  }
  /**
   * The closed form of an approval or question card. Platforms without it
   * keep the card as sent (`hitl/approval-card-state.ts`).
   */
  closedApprovalSegment?(state: ApprovalCardState, detail?: string): Promise<MessageSegment>
  /** The agent-run reply (`runtime.ts`). */
  readonly reply?: {
    /** The turn's locale from the asker's message and the app language. */
    turnLocale?(text: string, language: string | undefined): Promise<string>
    /** Whether the run's presentation title is the message's first line. */
    readonly titleFromMessage?: boolean
    /**
     * The final answer as outbound groups, one message each. A group holding
     * a card is marked `resultCard` for the `onConnectorOutbound` hook.
     * Undefined keeps the default single message.
     */
    finalGroups?(
      segments: MessageSegment[],
      context: ConnectorVendorFinalReplyContext
    ): Promise<MessageSegment[][] | undefined>
  }
  /** Run cards for the generic presentation runner (`run-presentation/runner.ts`). */
  readonly runPresentation?: {
    /** The terminal milestone; marked `resultCard` for `onConnectorOutbound`. */
    milestone(
      snapshot: RunProjectionSnapshot,
      context: { adapter?: AdapterInstanceRow; timeline: string }
    ): Promise<MessageSegment>
    /** The progress card the fallback path sends or edits. */
    fallback(snapshot: RunProjectionSnapshot, adapter?: AdapterInstanceRow): Promise<MessageSegment>
  }
}

/** Every contributed vendor, in catalog order. */
export function connectorVendors(): readonly ConnectorVendorContribution[] {
  return CONNECTOR_VENDORS
}

/** The contribution for one platform, or undefined when its vendor contributes none. */
export function connectorVendor(platform: string): ConnectorVendorContribution | undefined {
  return CONNECTOR_VENDORS.find((vendor) => vendor.platform === platform)
}
