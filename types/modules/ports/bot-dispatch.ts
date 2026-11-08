// The `bot-dispatch` capability port (ADR-0174, ADR-0250 §14): how the planes
// that produce Bot events reach the Bot control plane. The bot module provides
// it (`lib/bot/ports/bot-dispatch.ts`). The connectors hand it each admitted
// inbound message and cancel a conversation's accepted deliveries through it,
// and the workflow plane hands it desktop events and finished runs, so neither
// imports the bot module (which itself drives connectors, workflows and
// squads). With no provider there are no bots: inbound and event hand-offs are
// no-ops, and there is nothing to cancel.

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { BotEventProvenanceV1 } from "@/types/bot/event"

export interface BotConnectorInboundInput {
  event: NormalizedInboundEvent
  /** When the conversation admitted the message. */
  acceptedAt?: number
}

export interface BotDesktopEventInput {
  /** Dotted type, for example `desktop.uia` or `desktop.pet`. */
  type: string
  /** A stable id for this occurrence, so a redelivery is the same event. */
  sourceRecordId: string
  /** The payload, ALREADY sanitised by the producer: never raw window titles or message bodies. */
  payload: Record<string, unknown>
  resourceId?: string
  occurredAt?: number
}

export interface BotWorkflowCompletedInput {
  workflowId: string
  workflowName: string
  runId: string
  status: "succeeded" | "failed"
  output?: unknown
  provenance?: BotEventProvenanceV1
}

export interface BotConversationCancelInput {
  adapterId: string
  conversationKey: string
  /** Deliveries received at or before this time are cancelled. */
  cutoff: number
}

export interface BotDispatchPort {
  /**
   * Route an admitted inbound IM message to the installed bots. `deferred`
   * when the transfer lost a race to a conversation pause, so the caller keeps
   * its durable receipt and retries.
   */
  connectorInbound(input: BotConnectorInboundInput): Promise<{ deferred?: true }>
  /** Route one desktop or pet occurrence to the installed bots. */
  desktopEvent(input: BotDesktopEventInput): Promise<void>
  /** Route one finished workflow run to the installed bots. */
  workflowCompleted(input: BotWorkflowCompletedInput): Promise<void>
  /**
   * Cancel the accepted, host-owned deliveries a conversation's messages
   * started, up to `cutoff`; resolves with how many were cancelled.
   */
  cancelConversationDeliveries(input: BotConversationCancelInput): Promise<number>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "bot-dispatch": BotDispatchPort
  }
}
