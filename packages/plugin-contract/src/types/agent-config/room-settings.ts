/**
 * Room settings carried on `ChatSession.roomSettings` (ADR-0177).
 *
 * Mirrors `lib/chat/room/types.ts`. The app-side module re-exports these so a
 * package consumer and the renderer read one shape.
 */

export type RoomReplyMode = "auto" | "mention_only" | "asleep"

/**
 * What a member's `room_handoff_to_squad` does (ADR-0252 §4). `confirm`: it
 * leaves a proposal card a person confirms. `auto`: the Squad run starts at
 * once, still under the Squad run's own approval gates and risk policy.
 */
export type RoomSquadHandoffMode = "confirm" | "auto"

export interface RoomSettings {
  /**
   * When the room's agents may speak on their own. Read by the team runner
   * (`lib/chat/room/runner.ts`) and by IM admission
   * (`lib/connectors/conversation-admission.ts`) since batch 3.
   */
  replyMode?: RoomReplyMode
  /** Injected into every member's system prompt as `## Room instructions`. */
  instructions?: string
  /** Mirrored onto `memoryUse` and `memoryLearn`, which the memory plane reads. */
  memory?: boolean
  /**
   * Members the router never picks on its own. An explicit `@` or a pick in
   * the composer still reaches a muted member: the user asked, so mute, which
   * is about the room's own initiative, does not apply.
   */
  mutedMemberIds?: string[]
  /** Read by `room_handoff_to_squad` (`lib/squads/room-handoff/`). Default `confirm`. */
  squadHandoff?: RoomSquadHandoffMode
}
