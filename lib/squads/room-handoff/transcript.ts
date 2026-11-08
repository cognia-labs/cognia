/**
 * Where a room's hand-off proposals are read and their decisions written
 * (ADR-0252 §4).
 *
 * A character-team room this host runs has one writer of its transcript, its
 * `RoomRunner`, so a decision goes through the runner. An IM room bound to a
 * character team (ADR-0177 batch 5) has no runner: the connector runtime
 * writes each member's reply row itself, so a decision is a metadata patch on
 * that row. Every decision for one IM room is applied in order here, read
 * fresh before each patch, so two proposals in one reply never overwrite
 * each other's decision.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import { ROOM_HANDOFF_METADATA_KEY } from "@/types/squads/room-handoff"

/** Which transcript a hand-off reads and writes, or `null` for a room that holds none. */
export type RoomHandoffTranscriptKind = "runner" | "im"

export async function roomHandoffTranscriptKind(
  session: ChatSession | null | undefined
): Promise<RoomHandoffTranscriptKind | null> {
  const { isLocallyOrchestratedRoom, roomKindOf } = await import("@/lib/chat/room/kind")
  if (isLocallyOrchestratedRoom(session)) return "runner"
  return roomKindOf(session) === "im" ? "im" : null
}

export interface RoomHandoffTranscriptDeps {
  getSession: (roomId: string) => Promise<ChatSession | undefined>
  runnerRead: (roomId: string) => Promise<UIMessage[]>
  runnerPatch: (
    roomId: string,
    messageId: string,
    apply: (message: UIMessage) => UIMessage
  ) => Promise<boolean>
  storeRead: (roomId: string) => Promise<UIMessage[]>
  storePatchMetadata: (
    roomId: string,
    messageId: string,
    patch: Record<string, unknown>
  ) => Promise<void>
}

async function defaultDeps(): Promise<RoomHandoffTranscriptDeps> {
  const [{ getSession }, { getHostRoomRunner }, messages] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/lib/chat/room/runner-host"),
    import("@/lib/db/messages"),
  ])
  return {
    getSession,
    runnerRead: (roomId) => getHostRoomRunner().readMessages(roomId),
    runnerPatch: (roomId, messageId, apply) =>
      getHostRoomRunner().patchMessage(roomId, messageId, apply),
    storeRead: (roomId) => messages.listMessages(roomId),
    storePatchMetadata: (roomId, messageId, patch) =>
      messages.updateMessageMetadata(roomId, messageId, patch),
  }
}

let depsOverride: RoomHandoffTranscriptDeps | null = null

/** Test-only: replace what the transcript reads and writes. */
export function __setRoomHandoffTranscriptDepsForTesting(
  deps: RoomHandoffTranscriptDeps | null
): void {
  depsOverride = deps
}

async function resolveDeps(): Promise<RoomHandoffTranscriptDeps> {
  return depsOverride ?? (await defaultDeps())
}

/** The room's transcript, oldest first; empty for a room that holds no hand-offs. */
export async function readRoomHandoffTranscript(roomId: string): Promise<UIMessage[]> {
  const deps = await resolveDeps()
  const kind = await roomHandoffTranscriptKind(await deps.getSession(roomId))
  if (kind === "runner") return deps.runnerRead(roomId)
  if (kind === "im") return deps.storeRead(roomId)
  return []
}

/** IM rooms' patches in flight, by room, so each reads what the last one wrote. */
const imPatchQueue = new Map<string, Promise<unknown>>()

/**
 * Apply `apply` to one reply. Only the hand-off decisions it records are
 * written for an IM room: the reply's text and parts are the connector's.
 * `false` when the reply is not in the room, or the room holds no hand-offs.
 */
export async function patchRoomHandoffMessage(
  roomId: string,
  messageId: string,
  apply: (message: UIMessage) => UIMessage
): Promise<boolean> {
  const deps = await resolveDeps()
  const kind = await roomHandoffTranscriptKind(await deps.getSession(roomId))
  if (kind === "runner") return deps.runnerPatch(roomId, messageId, apply)
  if (kind !== "im") return false
  const previous = imPatchQueue.get(roomId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const message = (await deps.storeRead(roomId)).find((candidate) => candidate.id === messageId)
      if (!message) return false
      const before = metadataOf(message)[ROOM_HANDOFF_METADATA_KEY]
      const after = metadataOf(apply(message))[ROOM_HANDOFF_METADATA_KEY]
      if (after === before) return true
      await deps.storePatchMetadata(roomId, messageId, { [ROOM_HANDOFF_METADATA_KEY]: after })
      return true
    })
  imPatchQueue.set(roomId, next)
  void next
    .finally(() => {
      if (imPatchQueue.get(roomId) === next) imPatchQueue.delete(roomId)
    })
    .catch(() => undefined)
  return next
}

function metadataOf(message: UIMessage): Record<string, unknown> {
  return ((message as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<
    string,
    unknown
  >
}
