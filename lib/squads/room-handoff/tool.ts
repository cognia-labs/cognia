/**
 * `room_handoff_to_squad`, the room half of the squads module's tool family
 * (ADR-0252 §4; composed in `../agent-tools.ts`).
 *
 * Offered to the members of a character-team room this host orchestrates,
 * never to a Squad's teammate (whose dispatch session is a team session
 * without a room) and never in a shared room. The call proposes: in a room
 * whose `squadHandoff` setting is `confirm` it leaves a card a person answers;
 * in an `auto` room it starts the Squad run at once, through the same
 * decision a person makes. Either way the Squad run's own approval gates and
 * risk policy still ask.
 *
 * The tier allows the call: the card, or the room's own setting, is the
 * consent, so a person is not asked twice.
 */

import type {
  ModuleToolFamily,
  ToolCallContext,
  ToolSurfaceContext,
} from "@/lib/modules/manifest-types"
import { decodeSubSession } from "@/lib/claude/team-session-id"
import { isLocallyOrchestratedRoom } from "@/lib/chat/room/kind"
import {
  ROOM_HANDOFF_BRIEF_MAX_CHARS,
  ROOM_HANDOFF_TOOL_NAME,
  type RoomSquadHandoffToolOutput,
} from "@/types/squads/room-handoff"
import { parseRoomHandoffArgs } from "./proposal"

/** The most Squads the description names; the card lists every one. */
export const ROOM_HANDOFF_LISTED_SQUADS = 20

export const ROOM_HANDOFF_INSTRUCTIONS = `ROOM HAND-OFF TO A SQUAD:
When the conversation asks for work that needs a Squad (an agent team that plans and runs a multi-step task), call ${ROOM_HANDOFF_TOOL_NAME} once with a self-contained brief: the Squad does not see this room. Do not do the work yourself as well. A person may have to confirm the hand-off; when the Squad finishes you receive its result as a background task update, and you then report back to the room. Do not call it again for the same work while it is proposed or running.`

export interface RoomHandoffToolDeps {
  listSquads: () => readonly { id: string; name: string }[]
  getSession: (
    roomId: string
  ) => Promise<import("@cognia/agent-config-types").ChatSession | undefined>
  decide: typeof import("./decide").decideRoomSquadHandoff
}

async function defaultDeps(): Promise<RoomHandoffToolDeps> {
  const [{ useAgentTeamStore }, { getSession }, { decideRoomSquadHandoff }] = await Promise.all([
    import("@/stores/squads/agent-team-store/store"),
    import("@/lib/db/sessions"),
    import("./decide"),
  ])
  return {
    listSquads: () =>
      Object.values(useAgentTeamStore.getState().teams).map((team) => ({
        id: team.id,
        name: team.name,
      })),
    getSession,
    decide: decideRoomSquadHandoff,
  }
}

let depsOverride: RoomHandoffToolDeps | null = null

/** Test-only: replace what the tool reads. */
export function __setRoomHandoffToolDepsForTesting(deps: RoomHandoffToolDeps | null): void {
  depsOverride = deps
}

async function resolveDeps(): Promise<RoomHandoffToolDeps> {
  return depsOverride ?? (await defaultDeps())
}

export function isRoomHandoffTool(name: string): boolean {
  return name === ROOM_HANDOFF_TOOL_NAME
}

function describeSquads(squads: readonly { id: string; name: string }[]): string {
  if (squads.length === 0)
    return "There are no Squads yet: leave squadId out and a person picks one."
  const listed = squads
    .slice(0, ROOM_HANDOFF_LISTED_SQUADS)
    .map((squad) => `${squad.name} (${squad.id})`)
    .join("; ")
  const more = squads.length > ROOM_HANDOFF_LISTED_SQUADS ? "; and others" : ""
  return `Squads: ${listed}${more}.`
}

export const roomHandoffToolFamily: ModuleToolFamily = {
  async surface(ctx: ToolSurfaceContext) {
    if (!isLocallyOrchestratedRoom(ctx.session) || !ctx.agent) return null
    const deps = await resolveDeps()
    return {
      tools: [
        {
          name: ROOM_HANDOFF_TOOL_NAME,
          description: `Hand work to a Squad (an agent team) on the room's behalf. ${describeSquads(deps.listSquads())}`,
          jsonSchema: {
            type: "object",
            additionalProperties: false,
            required: ["brief"],
            properties: {
              brief: {
                type: "string",
                minLength: 1,
                maxLength: ROOM_HANDOFF_BRIEF_MAX_CHARS,
                description:
                  "What the Squad is to do, self-contained: the goal, the constraints, and what done looks like.",
              },
              squadId: {
                type: "string",
                description: "The Squad's id. Leave it out to let a person pick one.",
              },
            },
          },
        },
      ],
      instructions: ROOM_HANDOFF_INSTRUCTIONS,
    }
  },

  async run(
    _name: string,
    args: Record<string, unknown>,
    call: ToolCallContext
  ): Promise<RoomSquadHandoffToolOutput | string> {
    const caller = decodeSubSession(call.sessionId)
    if (!caller) return `Error: ${ROOM_HANDOFF_TOOL_NAME} is only available to a room member.`
    const parsed = parseRoomHandoffArgs(args)
    if (!parsed.ok) return `Error: ${ROOM_HANDOFF_TOOL_NAME} needs a brief.`
    const deps = await resolveDeps()
    const roomId = caller.teamSessionId
    const session = await deps.getSession(roomId)
    if (!isLocallyOrchestratedRoom(session)) {
      return `Error: ${ROOM_HANDOFF_TOOL_NAME} is only available in a room this host runs.`
    }
    const { brief, squadId } = parsed.args
    if (squadId && !deps.listSquads().some((squad) => squad.id === squadId)) {
      return `Error: there is no Squad ${squadId}. Leave squadId out to let a person pick one.`
    }
    const proposal = {
      proposalId: call.toolUseId,
      brief,
      ...(squadId ? { squadId } : {}),
    }
    const { resolveRoomSettings } = await import("@/lib/chat/room/settings")
    if (!squadId || resolveRoomSettings(session).squadHandoff !== "auto") {
      return {
        status: "proposed",
        ...proposal,
        ...(call.executionRunId ? { memberRunId: call.executionRunId } : {}),
      }
    }
    // The room confirms on its own. The reply this call sits in is the
    // proposal, so the decision is recorded there as a person's would be.
    const decided = await deps.decide(
      { roomId, toolUseId: call.toolUseId, decision: "confirm", squadId },
      { kind: "auto" },
      {
        proposal: { proposerId: caller.characterId, args: parsed.args },
        ...(call.executionRunId ? { memberRunId: call.executionRunId } : {}),
      }
    )
    if (decided.ok && decided.decision.status === "started") {
      return {
        status: "started",
        ...proposal,
        squadId: decided.decision.squadId,
        squadName: decided.decision.squadName,
        delegationRunId: decided.decision.delegationRunId,
        squadRunId: decided.decision.squadRunId,
        decidedAt: decided.decision.decidedAt,
      }
    }
    return {
      status: "refused",
      ...proposal,
      reason: decided.ok
        ? decided.decision.status === "failed"
          ? decided.decision.reason
          : decided.decision.status
        : decided.reason,
    }
  },
}
