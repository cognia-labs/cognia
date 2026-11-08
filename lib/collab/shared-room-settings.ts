/**
 * A shared room's own settings (ADR-0177 batch 5, ADR-0252 §6).
 *
 * # Where they live
 *
 * A shared room is the collaboration server's to run, and every member has
 * to agree on when its assistant answers and what it is told. So the reply
 * mode and the instructions are columns of the server's session row
 * (`reply_mode`, `room_instructions`, `room_settings_revision`), changed only
 * by an owner or a maintainer, and mirrored onto each member's local
 * `session.roomSettings` by the sync projection. The memory switch stays
 * local: it governs this machine's memory plane, and a room with several
 * people starts with it off.
 *
 * # What each mode does
 *
 * - `auto`: every human turn gets a reply. The author's client asks for it
 *   once the message has landed (`shouldRequestSharedReply`), unless the
 *   message steered a run already answering.
 * - `mention_only`: only a turn somebody asks about ("Request AI"). This is
 *   what a room did before it had a setting, and what a server older than
 *   this batch still does.
 * - `asleep`: nobody gets one. The server refuses an AI request
 *   (`409 room_asleep`) and writes a silence verdict (`room.silence`) to the
 *   session audit for every human turn, so "why did it not answer" has an
 *   answer.
 */

import type {
  ChatSession,
  RoomReplyMode,
  RoomSettings,
  SessionRole,
  SharedSession,
} from "@cognia/agent-config-types"
import { buildRoomInstructionsSection, MAX_ROOM_INSTRUCTIONS_CHARS } from "@/lib/chat/room/settings"
import { getDb } from "@/lib/db/schema"
import { CollabConflictError } from "./client"
import { resolveCurrentCollabContext, type CurrentCollabContext } from "./runtime-client"
import { assertSharedChatClientEnabled } from "./shared-chat-feature"

/** What a room without the setting does: answer only when asked. */
export const DEFAULT_SHARED_ROOM_REPLY_MODE: RoomReplyMode = "mention_only"

/** The audit action of a silence verdict. Must match `ROOM_SILENCE_AUDIT_ACTION`. */
export const ROOM_SILENCE_AUDIT_ACTION = "room.silence"

/** The conflict reason of an AI request an asleep room refused. */
export const ROOM_ASLEEP_REASON = "room_asleep"

const REPLY_MODES: readonly RoomReplyMode[] = ["auto", "mention_only", "asleep"]

/**
 * The local `roomSettings` once the server's row is applied: the server's
 * reply mode and instructions over whatever this machine keeps for itself
 * (the memory switch). A server older than this batch sends neither field,
 * so the room reads as `mention_only`, which is what that server does, and
 * keeps no instructions, because that server would never deliver them.
 */
export function sharedRoomSettingsFromRemote(
  remote: Pick<SharedSession, "replyMode" | "roomInstructions">,
  current: RoomSettings | undefined
): RoomSettings {
  const replyMode =
    remote.replyMode && REPLY_MODES.includes(remote.replyMode)
      ? remote.replyMode
      : DEFAULT_SHARED_ROOM_REPLY_MODE
  const next: RoomSettings = { ...(current ?? {}), replyMode }
  if (typeof remote.roomInstructions === "string") next.instructions = remote.roomInstructions
  else delete next.instructions
  return next
}

/** Whether a session role may change the room's settings: owners and maintainers. */
export function canManageSharedRoomSettings(role: SessionRole | null | undefined): boolean {
  return role === "owner" || role === "maintainer"
}

/**
 * Whether the author's client asks for a reply to the turn it just posted:
 * the room answers every human turn, and the turn did not already steer a
 * run that is answering.
 */
export function shouldRequestSharedReply(
  session: Pick<ChatSession, "collaboration" | "roomSettings"> | null | undefined,
  steerOutcome: "steered" | "queued" | "none"
): boolean {
  if (!session?.collaboration) return false
  if (steerOutcome !== "none") return false
  return session.roomSettings?.replyMode === "auto"
}

/**
 * The room's instructions as the run host appends them to a shared run's
 * system prompt, or `""`: the same section a team room's members read.
 */
export function sharedRoomRunInstructions(
  session: Pick<ChatSession, "collaboration" | "roomSettings"> | null | undefined
): string {
  if (!session?.collaboration) return ""
  return buildRoomInstructionsSection(session.roomSettings?.instructions)
}

/** `prompt` with the room's instructions after whatever it already says. */
export function withSharedRoomInstructions(
  prompt: string | undefined,
  session: Pick<ChatSession, "collaboration" | "roomSettings"> | null | undefined
): string | undefined {
  const section = sharedRoomRunInstructions(session)
  if (!section) return prompt
  return prompt ? `${prompt}\n\n${section}` : section
}

/**
 * A shared run's send options with the room's instructions in the system
 * prompt: after a replacing `systemPrompt` when the run has one (the two
 * fields are mutually exclusive), else in `appendSystemPrompt`.
 */
export function applySharedRoomInstructions<
  T extends { systemPrompt?: string; appendSystemPrompt?: string },
>(options: T, session: Pick<ChatSession, "collaboration" | "roomSettings"> | null | undefined): T {
  if (!sharedRoomRunInstructions(session)) return options
  if (typeof options.systemPrompt === "string" && options.systemPrompt) {
    return { ...options, systemPrompt: withSharedRoomInstructions(options.systemPrompt, session) }
  }
  return {
    ...options,
    appendSystemPrompt: withSharedRoomInstructions(options.appendSystemPrompt, session),
  }
}

/** Whether a refused AI request was refused because the room is asleep. */
export function isRoomAsleepRefusal(error: unknown): boolean {
  if (!(error instanceof CollabConflictError)) return false
  const authoritative = error.authoritative as { reason?: unknown } | null | undefined
  return authoritative?.reason === ROOM_ASLEEP_REASON
}

export interface SharedRoomSettingsChange {
  replyMode?: RoomReplyMode
  instructions?: string
}

export interface UpdateSharedRoomSettingsDeps {
  resolveContext?: () => Promise<CurrentCollabContext | null>
  writeLocal?: (sessionId: string, roomSettings: RoomSettings) => Promise<void>
  operationId?: () => string
}

/**
 * Change the room's reply mode or instructions on the server, then mirror the
 * answer locally at once rather than on the next pull. A revision that moved
 * underneath (a title change, another manager) is retried once against the
 * row the server returned with the conflict.
 */
export async function updateSharedRoomSettings(
  session: Pick<ChatSession, "id" | "collaboration" | "roomSettings">,
  change: SharedRoomSettingsChange,
  deps: UpdateSharedRoomSettingsDeps = {}
): Promise<SharedSession> {
  assertSharedChatClientEnabled()
  const binding = session.collaboration
  const context = await (deps.resolveContext ?? resolveCurrentCollabContext)()
  if (
    !binding ||
    !context ||
    context.orgId !== binding.orgId ||
    (binding.endpoint && binding.endpoint !== context.client.baseUrl)
  ) {
    throw new Error("Shared session connection is unavailable")
  }
  const body = {
    ...(change.replyMode ? { replyMode: change.replyMode } : {}),
    ...(change.instructions !== undefined
      ? { roomInstructions: change.instructions.trim().slice(0, MAX_ROOM_INSTRUCTIONS_CHARS) }
      : {}),
  }
  const operationId = (deps.operationId ?? (() => `room-settings:${crypto.randomUUID()}`))()
  let base = (await context.client.getSharedSession(context.orgId, binding.sessionId)).revision
  let updated: SharedSession
  try {
    updated = await context.client.updateSharedRoomSettings(context.orgId, binding.sessionId, {
      ...body,
      operationId,
      baseRevision: base,
    })
  } catch (error) {
    const authoritative =
      error instanceof CollabConflictError
        ? (error.authoritative as { revision?: unknown } | null | undefined)
        : undefined
    if (typeof authoritative?.revision !== "number") throw error
    base = authoritative.revision
    updated = await context.client.updateSharedRoomSettings(context.orgId, binding.sessionId, {
      ...body,
      operationId: `${operationId}:retry`,
      baseRevision: base,
    })
  }
  const roomSettings = sharedRoomSettingsFromRemote(updated, session.roomSettings)
  await (
    deps.writeLocal ??
    (async (id, next) => {
      await getDb().sessions.update(id, { roomSettings: next })
    })
  )(session.id, roomSettings)
  return updated
}
