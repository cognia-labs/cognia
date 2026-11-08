/**
 * The room hand-off in an IM group bound to a character team (ADR-0177
 * batch 5, ADR-0252 §4).
 *
 * An IM room's members do not run through `RoomRunner`: each member step runs
 * on the connector's reply path, and the connector runtime writes the
 * member's reply row itself. So the hand-off tool cannot tell from the
 * session alone whether a call comes from a member step, and the proposal
 * cannot be read back out of a runner's event stream. The connector opens a
 * step here for the length of each member step; the tool offers itself only
 * to an open step and records what the member proposed on it, and the
 * connector persists those proposals as tool parts on the member's reply and
 * posts the confirmation card into the group.
 *
 * This is the squads module's `api` for the connectors module, which never
 * reads the Squad store or the tool's internals.
 */

import type { UIMessage } from "ai"
import {
  ROOM_HANDOFF_TOOL_NAME,
  type RoomSquadHandoffArgs,
  type RoomSquadHandoffToolOutput,
} from "@/types/squads/room-handoff"

export interface ImRoomHandoffStepInput {
  /** The IM room's session. */
  roomId: string
  /** The member speaking in this step. */
  characterId: string
  /** The step's sub-session (`imRoomMemberSessionId`): the only caller the step answers. */
  memberSessionId: string
  /** The conversation's own Squad, offered when the member names none. */
  defaultSquadId?: string
  /**
   * Whether the room's `auto` setting may start a Squad run inside the call.
   * `false` in a conversation whose replies wait for a person's sign-off
   * (`autonomy: "suggest"`): a hand-off there waits for the card as well.
   */
  autoAllowed: boolean
}

/** One call the member made during its step. */
export interface ImRoomHandoffCall {
  toolUseId: string
  input: RoomSquadHandoffArgs
  output: RoomSquadHandoffToolOutput
}

export interface ImRoomHandoffStep extends Readonly<ImRoomHandoffStepInput> {
  /** The step's calls, in call order. */
  calls(): readonly ImRoomHandoffCall[]
  /** The calls as tool parts for the member's reply row, where the desktop card reads them. */
  parts(): UIMessage["parts"]
  /** End the step: a call that arrives later is refused. */
  close(): void
}

interface OpenStep {
  input: ImRoomHandoffStepInput
  calls: ImRoomHandoffCall[]
}

/** Open steps by member sub-session; at most one per room member at a time. */
const openSteps = new Map<string, OpenStep>()

/** Open a member step. A step still open for the same member is replaced. */
export function openImRoomHandoffStep(input: ImRoomHandoffStepInput): ImRoomHandoffStep {
  for (const [key, open] of openSteps) {
    if (open.input.roomId === input.roomId && open.input.characterId === input.characterId)
      openSteps.delete(key)
  }
  const step: OpenStep = { input: { ...input }, calls: [] }
  openSteps.set(input.memberSessionId, step)
  return {
    ...step.input,
    calls: () => [...step.calls],
    parts: () => step.calls.map(imRoomHandoffToolPart),
    close: () => {
      if (openSteps.get(input.memberSessionId) === step) openSteps.delete(input.memberSessionId)
    },
  }
}

/** The open step a run's tools resolve for, by room and member (`ToolSurfaceContext`). */
export function imRoomHandoffStepFor(
  roomId: string,
  characterId: string
): Readonly<ImRoomHandoffStepInput> | undefined {
  for (const open of openSteps.values()) {
    if (open.input.roomId === roomId && open.input.characterId === characterId) return open.input
  }
  return undefined
}

/** The open step a call belongs to, by the calling sub-session. */
export function imRoomHandoffStepOfCall(
  memberSessionId: string
): Readonly<ImRoomHandoffStepInput> | undefined {
  return openSteps.get(memberSessionId)?.input
}

/** Record a call on its open step. A call after the step closed is not recorded. */
export function recordImRoomHandoffCall(memberSessionId: string, call: ImRoomHandoffCall): boolean {
  const open = openSteps.get(memberSessionId)
  if (!open) return false
  open.calls.push(call)
  return true
}

/**
 * The call as the tool part a desktop room's reply carries, so the reply
 * reads the same to `findRoomHandoffProposal` and to the hand-off card.
 */
export function imRoomHandoffToolPart(call: ImRoomHandoffCall): UIMessage["parts"][number] {
  return {
    type: `tool-${ROOM_HANDOFF_TOOL_NAME}`,
    toolCallId: call.toolUseId,
    state: "output-available",
    input: call.input,
    output: call.output,
  } as UIMessage["parts"][number]
}

/** The Squads a hand-off can start, by id and name, for the card's choices. */
export async function listImRoomHandoffSquads(): Promise<{ id: string; name: string }[]> {
  const { useAgentTeamStore } = await import("@/stores/squads/agent-team-store/store")
  return Object.values(useAgentTeamStore.getState().teams).map((team) => ({
    id: team.id,
    name: team.name,
  }))
}

/** Test-only: forget every open step. */
export function __resetImRoomHandoffStepsForTesting(): void {
  openSteps.clear()
}
