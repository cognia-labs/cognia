/**
 * Which room a session is, read off the columns each plane already writes.
 *
 * Kept as one function so the four consumers (roster projection, settings
 * defaults, the runner, the participants chip) cannot disagree about a
 * session that carries two bindings at once. Precedence: a shared session
 * binding wins, because its writes are server-authoritative and a local
 * runner must not orchestrate over it. Then a character team. Then an IM
 * binding.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { ChannelKind } from "@/types/connectors/event"
import type { RoomKind } from "./types"

export type RoomKindSource = Pick<
  ChatSession,
  "kind" | "teamId" | "collaboration" | "platformBinding"
>

export function roomKindOf(session: RoomKindSource | null | undefined): RoomKind | null {
  if (!session) return null
  if (session.collaboration) return "shared"
  if (session.kind === "team" && session.teamId) return "team"
  // A one-to-one IM chat has two participants: it is a direct conversation,
  // not a room (ADR-0252 §6).
  if (session.platformBinding) {
    return platformScopeOf(session.platformBinding) === "private" ? null : "im"
  }
  return null
}

type PlatformBinding = NonNullable<ChatSession["platformBinding"]>

/**
 * The IM conversation's scope: the one the last inbound event stamped, else
 * what the delivery target or the adapter's reference says. `undefined` when
 * nothing says, which reads as a room: a group whose scope is unknown must not
 * lose the room defaults (memory off) by accident.
 */
export function platformScopeOf(binding: PlatformBinding): ChannelKind | undefined {
  const ref = (binding.conversationRef ?? {}) as Record<string, unknown>
  const fromRef = [ref.scopeKind, ref.channelKind].find(isChannelKind)
  return binding.scopeKind ?? binding.deliveryTarget?.address.scopeKind ?? fromRef
}

const CHANNEL_KINDS: readonly ChannelKind[] = ["private", "group", "channel", "thread"]

function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === "string" && (CHANNEL_KINDS as readonly string[]).includes(value)
}

/** A room the local runner may drive. Shared rooms are the server's to run. */
export function isLocallyOrchestratedRoom(session: RoomKindSource | null | undefined): boolean {
  return roomKindOf(session) === "team"
}

/** Rooms where more than one human can be present. */
export function isMultiHumanRoom(kind: RoomKind | null): boolean {
  return kind === "shared" || kind === "im"
}
