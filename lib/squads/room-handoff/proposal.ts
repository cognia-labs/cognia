/**
 * A hand-off proposal is a `room_handoff_to_squad` tool part in a member's
 * reply (ADR-0252 §4). Reading one back out of a room's transcript, and
 * recording its decision on the reply, without a store or Dexie: the room's
 * runner hands the transcript in and takes the patch.
 */

import type { UIMessage } from "ai"
import {
  ROOM_HANDOFF_BRIEF_MAX_CHARS,
  ROOM_HANDOFF_METADATA_KEY,
  ROOM_HANDOFF_TOOL_NAME,
  type RoomSquadHandoffArgs,
  type RoomSquadHandoffDecision,
  type RoomSquadHandoffToolOutput,
} from "@/types/squads/room-handoff"

/** The prefix the Anthropic path names in-process tools with. */
const PLUGIN_TOOL_PREFIX = "mcp__cognia-plugin-tools__"

/** Whether a tool part names `room_handoff_to_squad`, in either of its name forms. */
export function isRoomHandoffToolPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  const { type, toolName } = part as { type?: unknown; toolName?: unknown }
  const name =
    type === "dynamic-tool"
      ? typeof toolName === "string"
        ? toolName
        : ""
      : typeof type === "string" && type.startsWith("tool-")
        ? type.slice("tool-".length)
        : ""
  const bare = name.startsWith(PLUGIN_TOOL_PREFIX) ? name.slice(PLUGIN_TOOL_PREFIX.length) : name
  return bare === ROOM_HANDOFF_TOOL_NAME
}

/** The call's arguments, or why they are not a proposal. */
export function parseRoomHandoffArgs(
  input: unknown
): { ok: true; args: RoomSquadHandoffArgs } | { ok: false; reason: "brief_required" } {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const brief =
    typeof record.brief === "string"
      ? record.brief.trim().slice(0, ROOM_HANDOFF_BRIEF_MAX_CHARS)
      : ""
  if (!brief) return { ok: false, reason: "brief_required" }
  const squadId = typeof record.squadId === "string" ? record.squadId.trim() : ""
  return { ok: true, args: { brief, ...(squadId ? { squadId } : {}) } }
}

/** The tool's output, when it reads as one (it may be a JSON string). */
export function parseRoomHandoffOutput(output: unknown): RoomSquadHandoffToolOutput | null {
  let value = output
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (
    (record.status !== "proposed" && record.status !== "started" && record.status !== "refused") ||
    typeof record.proposalId !== "string" ||
    typeof record.brief !== "string"
  )
    return null
  return value as RoomSquadHandoffToolOutput
}

/** One proposal as the room holds it. */
export interface RoomHandoffProposal {
  /** The member's reply that carries the call. */
  messageId: string
  /** The member who proposed it (`metadata.senderId`). */
  proposerId: string
  toolUseId: string
  args: RoomSquadHandoffArgs
  /** The run of the member's turn that made the call, when its output names it. */
  memberRunId?: string
  decision?: RoomSquadHandoffDecision
}

/** The decision recorded on a reply for `toolUseId`, if any. */
export function handoffDecisionOf(
  message: UIMessage,
  toolUseId: string
): RoomSquadHandoffDecision | undefined {
  const metadata = (message as { metadata?: Record<string, unknown> }).metadata
  const decisions = metadata?.[ROOM_HANDOFF_METADATA_KEY]
  if (!decisions || typeof decisions !== "object") return undefined
  const decision = (decisions as Record<string, unknown>)[toolUseId]
  return decision && typeof decision === "object"
    ? (decision as RoomSquadHandoffDecision)
    : undefined
}

/** The decision an `auto` call's output records, when it started the Squad run. */
export function decisionFromOutput(
  output: RoomSquadHandoffToolOutput | null
): RoomSquadHandoffDecision | undefined {
  if (output?.status !== "started") return undefined
  return {
    status: "started",
    squadId: output.squadId,
    squadName: output.squadName,
    delegationRunId: output.delegationRunId,
    squadRunId: output.squadRunId,
    decidedAt: output.decidedAt,
    decidedBy: { kind: "auto" },
  }
}

/**
 * Find the proposal `toolUseId` names in a room's transcript. A call whose
 * arguments are no proposal (no brief) is none.
 */
export function findRoomHandoffProposal(
  messages: readonly UIMessage[],
  toolUseId: string
): RoomHandoffProposal | null {
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      const tool = part as { toolCallId?: unknown; input?: unknown; output?: unknown }
      if (tool.toolCallId !== toolUseId || !isRoomHandoffToolPart(part)) continue
      const parsed = parseRoomHandoffArgs(tool.input)
      if (!parsed.ok) return null
      const metadata = (message as { metadata?: Record<string, unknown> }).metadata
      const proposerId = typeof metadata?.senderId === "string" ? metadata.senderId : ""
      if (!proposerId) return null
      const output = parseRoomHandoffOutput(tool.output)
      const memberRunId =
        output && "memberRunId" in output && typeof output.memberRunId === "string"
          ? output.memberRunId
          : undefined
      // An `auto` room records its decision in the call's own output too,
      // since the call may end before its reply holds the part.
      const decision = handoffDecisionOf(message, toolUseId) ?? decisionFromOutput(output)
      return {
        messageId: message.id,
        proposerId,
        toolUseId,
        args: parsed.args,
        ...(memberRunId ? { memberRunId } : {}),
        ...(decision ? { decision } : {}),
      }
    }
  }
  return null
}

/**
 * The patch that records `decision` on the reply. It never replaces a
 * decision already recorded, so applying it again, or after another
 * decision won, changes nothing.
 */
export function withHandoffDecision(
  toolUseId: string,
  decision: RoomSquadHandoffDecision
): (message: UIMessage) => UIMessage {
  return (message) => {
    if (handoffDecisionOf(message, toolUseId)) return message
    const metadata = (message as { metadata?: Record<string, unknown> }).metadata ?? {}
    const decisions = metadata[ROOM_HANDOFF_METADATA_KEY]
    return {
      ...message,
      metadata: {
        ...metadata,
        [ROOM_HANDOFF_METADATA_KEY]: {
          ...(decisions && typeof decisions === "object" ? decisions : {}),
          [toolUseId]: decision,
        },
      },
    } as UIMessage
  }
}
