/**
 * `room_handoff_to_squad`, the room half of the squads module's tool family
 * (ADR-0252 §4; composed in `../agent-tools.ts`).
 *
 * Offered to the members of a character-team room this host orchestrates,
 * and to a member speaking in an IM group bound to a character team while
 * the connector holds its step open (`./im-room.ts`, ADR-0177 batch 5);
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
import { isLocallyOrchestratedRoom, roomKindOf } from "@/lib/chat/room/kind"
import {
  ROOM_HANDOFF_BRIEF_MAX_CHARS,
  ROOM_HANDOFF_TOOL_NAME,
  type RoomSquadHandoffToolOutput,
} from "@/types/squads/room-handoff"
import { parseRoomHandoffArgs } from "./proposal"
import {
  imRoomHandoffStepFor,
  imRoomHandoffStepOfCall,
  recordImRoomHandoffCall,
  type ImRoomHandoffStepInput,
} from "./im-room"

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

function describeSquads(
  squads: readonly { id: string; name: string }[],
  defaultSquadId?: string
): string {
  const fallback = defaultSquadId ? squads.find((squad) => squad.id === defaultSquadId) : undefined
  if (fallback)
    return `This conversation's Squad is ${fallback.name} (${fallback.id}): leave squadId out to hand the work to it.`
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
    if (!ctx.agent || !ctx.session) return null
    // An IM room's member is offered the tool only during its step.
    const imStep =
      roomKindOf(ctx.session) === "im"
        ? imRoomHandoffStepFor(ctx.session.id, ctx.agent.id)
        : undefined
    if (!isLocallyOrchestratedRoom(ctx.session) && !imStep) return null
    const deps = await resolveDeps()
    return {
      tools: [
        {
          name: ROOM_HANDOFF_TOOL_NAME,
          description: `Hand work to a Squad (an agent team) on the room's behalf. ${describeSquads(deps.listSquads(), imStep?.defaultSquadId)}`,
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
    let imStep: Readonly<ImRoomHandoffStepInput> | undefined
    if (roomKindOf(session) === "im") {
      imStep = imRoomHandoffStepOfCall(call.sessionId)
      if (!imStep || imStep.roomId !== roomId || imStep.characterId !== caller.characterId) {
        return `Error: ${ROOM_HANDOFF_TOOL_NAME} is only available to a member while it speaks in the room.`
      }
    } else if (!isLocallyOrchestratedRoom(session)) {
      return `Error: ${ROOM_HANDOFF_TOOL_NAME} is only available in a room this host runs.`
    }
    const squads = deps.listSquads()
    const named = parsed.args.squadId
    if (named && !squads.some((squad) => squad.id === named)) {
      return `Error: there is no Squad ${named}. Leave squadId out to let a person pick one.`
    }
    // An IM conversation's own Squad stands in when the member names none,
    // unless it has since been deleted: then a person picks one.
    const fallback =
      !named && imStep?.defaultSquadId && squads.some((squad) => squad.id === imStep.defaultSquadId)
        ? imStep.defaultSquadId
        : undefined
    const squadId = named ?? fallback
    // The proposal is what the hand-off would start, the fallback included.
    const proposalArgs = { brief: parsed.args.brief, ...(squadId ? { squadId } : {}) }
    const output = await propose(deps, {
      roomId,
      call,
      proposerId: caller.characterId,
      args: proposalArgs,
      auto:
        Boolean(squadId) &&
        (imStep ? imStep.autoAllowed : true) &&
        (await import("@/lib/chat/room/settings")).resolveRoomSettings(session).squadHandoff ===
          "auto",
    })
    if (imStep) {
      recordImRoomHandoffCall(call.sessionId, {
        toolUseId: call.toolUseId,
        input: proposalArgs,
        output,
      })
    }
    return output
  },
}

async function propose(
  deps: RoomHandoffToolDeps,
  input: {
    roomId: string
    call: ToolCallContext
    proposerId: string
    args: { brief: string; squadId?: string }
    /** The room confirms on its own (`squadHandoff: "auto"` with a Squad named). */
    auto: boolean
  }
): Promise<RoomSquadHandoffToolOutput> {
  const { call, args } = input
  const proposal = {
    proposalId: call.toolUseId,
    brief: args.brief,
    ...(args.squadId ? { squadId: args.squadId } : {}),
  }
  if (!input.auto || !args.squadId) {
    return {
      status: "proposed",
      ...proposal,
      ...(call.executionRunId ? { memberRunId: call.executionRunId } : {}),
    }
  }
  // The room confirms on its own. The reply this call sits in is the
  // proposal, so the decision is recorded there as a person's would be.
  const decided = await deps.decide(
    { roomId: input.roomId, toolUseId: call.toolUseId, decision: "confirm", squadId: args.squadId },
    { kind: "auto" },
    {
      proposal: { proposerId: input.proposerId, args },
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
}
