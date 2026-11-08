/**
 * Who speaks, in order, when an IM group bound to a character team gets a
 * message (ADR-0177 batch 4, ADR-0252 §6).
 *
 * # Why not the chat-plane `RoomRunner`
 *
 * `RoomRunner` runs each member as a sidecar sub-session with store sinks
 * and desktop approvals. An IM reply needs what the connector runtime's
 * reply path already does: the run card, approval cards in the group, drafts,
 * platform streaming and the delivery gateway. So an IM room keeps that path
 * for every member reply and borrows only the room's decisions, the same
 * pure functions `RoomRunner` calls: `routeTurn` for the first speakers,
 * `stickyResponderOf` for the unaddressed follow-up, `planAutoRound` for
 * hand-offs between members, and the supervisor's dispatch and synthesis.
 *
 * # Shape
 *
 * {@link ImRoomTurn} is a cursor. `next()` names the next step and
 * `record()` feeds back what that member said, which is how a supervisor's
 * dispatches and a member's `@` hand-off decide the steps after it. Nothing
 * here does IO, so the runtime and a node test drive it the same way.
 *
 * Admission has already applied the reply mode (the conversation's activation
 * policy), so the planner routes as an `auto` room; mutes still apply.
 *
 * The ceilings match `RoomRunner`'s: in a linear room `routeTurn` and
 * `planAutoRound` hold the team's response cap; in a supervisor room every
 * supervisor or dispatch run counts against it, as it does there.
 */

import type { Character, Team, TeamMember } from "@cognia/agent-config-types"
import {
  MAX_SUPERVISOR_ROUNDS,
  buildSupervisorRoster,
  buildSynthesisAddendum,
  hasHandoffStopToken,
  holdReasonFor,
  parseDispatches,
  parseMentions,
  planAutoRound,
  routeTurn,
  stickyResponderOf,
  stripDispatches,
  stripHandoffStopToken,
  type AutoRoundStop,
  type TeamReply,
  type TurnHoldReason,
} from "@/lib/claude/team-router"
import { fallbackPrimaryResponder, resolveTeamResponseCap } from "@/lib/claude/team-primary-router"
import { canSendMessage, type RecentMessage } from "@/lib/squads/gates/message-guard"
import { resolveAutoRoundBudget } from "@/lib/chat/room/settings"

export type ImRoomStepKind = "reply" | "supervisor" | "dispatch" | "synthesis" | "handoff"

/** One member reply the runtime runs through the IM reply path. */
export interface ImRoomStep {
  kind: ImRoomStepKind
  character: Character
  /**
   * What the member is asked for. `null` answers the inbound message itself;
   * a dispatch and a synthesis carry their own instruction.
   */
  instruction: string | null
  /** Extra system-prompt text for this step (the supervisor's roster, the synthesis). */
  promptAddendum: string
  /**
   * The step's place in the turn (`reply-1`, `dispatch-3`): with the
   * inbound message's id it names the member's run, and a replay of the turn
   * recognises a step that already answered by it and its member.
   */
  stepKey: string
}

export interface ImRoomTurnInput {
  team: Pick<
    Team,
    "members" | "orchestration" | "maxResponses" | "maxAutoRounds" | "supervisorCharacterId"
  >
  /** The team's characters, resolved. Order does not matter: the team's slots decide it. */
  characters: readonly Character[]
  userText: string
  /** The room's transcript so far, for the sticky responder. */
  messages: readonly { role: string; metadata?: unknown }[]
  mutedMemberIds: readonly string[]
  /**
   * The smart primary router's pick for an unaddressed turn in a
   * `mention_round_robin` room (see {@link primaryRoutingOf}). Absent, the
   * room falls back the way the router does: the sticky member, else the
   * most talkative, else the first.
   */
  primaryCharacterId?: string
  /**
   * The members this turn is addressed to, a pick that wins over mentions,
   * routing and the supervisor (`routeTurn`'s explicit targets): a turn the
   * host owes the room, such as a Squad's result for the member that handed
   * it the work. A muted member still gets it, as a composer pick does.
   */
  targetMemberIds?: readonly string[]
  now: () => number
  random?: () => number
}

export type ImRoomTurnEnd =
  | { kind: "held"; reason: TurnHoldReason }
  | { kind: "no-supervisor" }
  | { kind: "empty" }
  | { kind: "done"; autoStop: AutoRoundStop | null }

/** What a member's reply looks like to the reader, room protocol removed. */
export function visibleRoomReplyText(step: Pick<ImRoomStep, "kind">, text: string): string {
  const withoutStop = stripHandoffStopToken(text)
  return step.kind === "supervisor" || step.kind === "synthesis"
    ? stripDispatches(withoutStop)
    : withoutStop
}

/**
 * Whether this turn asks the smart primary router, and whom it may pick.
 * `null` when the room has no primary to choose: a supervisor or manual or
 * round-robin team, or a message that `@`-names a member.
 */
export function primaryRoutingOf(
  input: Pick<
    ImRoomTurnInput,
    "team" | "characters" | "userText" | "messages" | "mutedMemberIds" | "targetMemberIds"
  >
): { candidates: Character[]; sticky: Character | undefined } | null {
  if (addressedMembers(input).length > 0) return null
  const members = orderedMembers(input.team, input.characters)
  if (
    input.team.orchestration !== "mention_round_robin" &&
    input.team.orchestration !== undefined
  ) {
    return null
  }
  if (parseMentions(input.userText, members).length > 0) return null
  const muted = new Set(input.mutedMemberIds)
  const candidates = members.filter((member) => !muted.has(member.id))
  if (candidates.length === 0) return null
  return { candidates, sticky: stickyResponderOf(input.messages, candidates) }
}

/** The members a turn's explicit targets name (they answer in the pick's order). */
function addressedMembers(
  input: Pick<ImRoomTurnInput, "team" | "characters" | "targetMemberIds">
): Character[] {
  const ids = new Set(input.targetMemberIds ?? [])
  if (ids.size === 0) return []
  return orderedMembers(input.team, input.characters).filter((member) => ids.has(member.id))
}

function orderedMembers(
  team: Pick<Team, "members">,
  characters: readonly Character[]
): Character[] {
  const byId = new Map(characters.map((character) => [character.id, character]))
  const out: Character[] = []
  for (const slot of team.members) {
    const character = byId.get(slot.characterId)
    if (character && !out.includes(character)) out.push(character)
  }
  return out
}

export class ImRoomTurn {
  private readonly members: Character[]
  private readonly slots: ReadonlyMap<string, TeamMember>
  private readonly queue: ImRoomStep[] = []
  private readonly responseCap: number
  private readonly maxAutoRounds: number
  /** Supervisor and dispatch runs so far (the supervisor room's cap). */
  private supervisedRuns = 0
  private ended: ImRoomTurnEnd | null = null
  // Linear (and hand-off) rounds.
  private roundReplies: TeamReply[] = []
  private roundPending = 0
  private autoRound = 0
  private readonly spokenIds: string[] = []
  private readonly recent: RecentMessage[] = []
  // Supervisor rounds.
  private readonly supervisor: Character | undefined
  private supervisorRound = 0
  private readonly dispatchedReplies: { name: string; reply: string }[] = []
  private readonly seenDispatches = new Set<string>()
  private dispatchesPending = 0
  private stepCounter = 0

  constructor(private readonly input: ImRoomTurnInput) {
    this.members = orderedMembers(input.team, input.characters)
    this.slots = new Map(input.team.members.map((slot) => [slot.characterId, slot]))
    this.responseCap = resolveTeamResponseCap(input.team.maxResponses)
    this.maxAutoRounds = resolveAutoRoundBudget(input.team.maxAutoRounds)
    this.supervisor =
      input.team.orchestration === "supervisor"
        ? this.members.find((member) => member.id === input.team.supervisorCharacterId)
        : undefined
    this.start()
  }

  /** Why the turn produced no (more) replies, once it has finished. */
  get end(): ImRoomTurnEnd | null {
    return this.queue.length === 0 ? this.ended : null
  }

  next(): ImRoomStep | null {
    const step = this.queue[0]
    if (!step) return null
    const supervised = step.kind !== "reply" && step.kind !== "handoff"
    if (supervised && this.supervisedRuns >= this.responseCap) {
      this.queue.length = 0
      this.ended = { kind: "done", autoStop: "cap" }
      return null
    }
    this.queue.shift()
    if (supervised) this.supervisedRuns += 1
    return step
  }

  /**
   * Feed back one step's reply. `text` is what the member wrote, protocol
   * tags included (empty when it produced nothing).
   */
  record(step: ImRoomStep, text: string): void {
    const raw = text
    switch (step.kind) {
      case "supervisor":
        this.afterSupervisor(raw)
        return
      case "dispatch":
        if (raw.trim()) {
          this.dispatchedReplies.push({
            name: step.character.name,
            reply: visibleRoomReplyText(step, raw),
          })
        }
        this.dispatchesPending -= 1
        if (this.dispatchesPending === 0) this.afterDispatches()
        return
      case "synthesis":
        this.ended = { kind: "done", autoStop: null }
        return
      case "reply":
      case "handoff":
        this.afterLinear(step, raw)
        return
    }
  }

  private start(): void {
    const { team, userText, mutedMemberIds, targetMemberIds } = this.input
    // A turn addressed to members runs linear for them, whatever the team's
    // routing: they are the ones it is owed to.
    if (addressedMembers(this.input).length > 0) {
      const targets = routeTurn(team, this.members, userText, undefined, {
        mutedMemberIds,
        replyMode: "auto",
        explicitTargetIds: targetMemberIds,
      })
      this.pushRound(targets, "reply")
      return
    }
    if (team.orchestration === "supervisor") {
      if (!this.supervisor) {
        this.ended = { kind: "no-supervisor" }
        return
      }
      this.pushSupervisor(1)
      return
    }
    const routing = primaryRoutingOf(this.input)
    const primaryId = routing
      ? (
          routing.candidates.find((member) => member.id === this.input.primaryCharacterId) ??
          fallbackPrimaryResponder(routing.candidates, this.slots, routing.sticky)
        )?.id
      : undefined
    const targets = routeTurn(team, this.members, userText, primaryId, {
      mutedMemberIds,
      replyMode: "auto",
    })
    if (targets.length === 0) {
      const reason = holdReasonFor(team, targets, { replyMode: "auto" })
      this.ended = reason ? { kind: "held", reason } : { kind: "empty" }
      return
    }
    this.pushRound(targets, "reply")
  }

  private pushRound(targets: readonly Character[], kind: "reply" | "handoff"): void {
    this.roundReplies = []
    this.roundPending = targets.length
    for (const character of targets) {
      this.queue.push({
        kind,
        character,
        instruction: null,
        promptAddendum: "",
        stepKey: this.stepKeyFor(kind),
      })
      this.spokenIds.push(character.id)
    }
  }

  private afterLinear(step: ImRoomStep, raw: string): void {
    const now = this.input.now()
    const visible = visibleRoomReplyText(step, raw)
    const stopRequested = hasHandoffStopToken(raw)
    if (visible.trim()) {
      const decision = canSendMessage({
        senderId: step.character.id,
        content: visible,
        now,
        recentMessages: this.recent,
      })
      if (decision.allow) {
        this.recent.push({ senderId: step.character.id, content: visible, createdAt: now })
        this.roundReplies.push({ characterId: step.character.id, text: visible, stopRequested })
      }
    } else if (stopRequested) {
      this.roundReplies.push({ characterId: step.character.id, text: "", stopRequested: true })
    }
    this.roundPending -= 1
    if (this.roundPending > 0) return
    if (this.maxAutoRounds === 0) {
      this.ended = { kind: "done", autoStop: null }
      return
    }
    const plan = planAutoRound({
      replies: this.roundReplies,
      members: this.members,
      spokenCount: this.spokenIds.length,
      responseCap: this.responseCap,
      round: this.autoRound,
      maxAutoRounds: this.maxAutoRounds,
      spokenIds: this.spokenIds,
      mutedMemberIds: this.input.mutedMemberIds,
      slots: this.slots,
      random: this.input.random,
    })
    if (plan.targets.length === 0) {
      this.ended = { kind: "done", autoStop: plan.stop }
      return
    }
    this.autoRound += 1
    this.pushRound(plan.targets, "handoff")
  }

  private pushSupervisor(round: number): void {
    const supervisor = this.supervisor!
    this.supervisorRound = round
    this.queue.push(
      round === 1
        ? {
            kind: "supervisor",
            character: supervisor,
            // The inbound message itself, with its attachments and speaker,
            // where `RoomRunner` sends "Respond to the user." over a
            // transcript that already holds the composer's text.
            instruction: null,
            promptAddendum: buildSupervisorRoster(this.members, this.slots),
            stepKey: this.stepKeyFor("supervisor"),
          }
        : {
            kind: "synthesis",
            character: supervisor,
            instruction: "Synthesize the final reply.",
            promptAddendum: buildSynthesisAddendum(this.dispatchedReplies),
            stepKey: this.stepKeyFor("synthesis"),
          }
    )
  }

  private afterSupervisor(raw: string): void {
    if (this.supervisorRound >= MAX_SUPERVISOR_ROUNDS) {
      this.ended = { kind: "done", autoStop: null }
      return
    }
    const dispatches = parseDispatches(raw, this.members)
    for (const dispatch of dispatches) {
      // The room muted this member; the supervisor's ask does not outrank that.
      if (this.input.mutedMemberIds.includes(dispatch.characterId)) continue
      const target = this.members.find((member) => member.id === dispatch.characterId)
      if (!target) continue
      const key = `${dispatch.characterId}\u0000${dispatch.task.trim().replace(/\s+/g, " ").toLowerCase()}`
      if (this.seenDispatches.has(key)) continue
      this.seenDispatches.add(key)
      this.queue.push({
        kind: "dispatch",
        character: target,
        instruction: `Dispatch from supervisor:\n${dispatch.task}`,
        promptAddendum: "",
        stepKey: this.stepKeyFor("dispatch"),
      })
      this.dispatchesPending += 1
    }
    if (this.dispatchesPending === 0) this.ended = { kind: "done", autoStop: null }
  }

  private afterDispatches(): void {
    if (this.dispatchedReplies.length === 0) {
      this.ended = { kind: "done", autoStop: null }
      return
    }
    this.pushSupervisor(this.supervisorRound + 1)
  }

  private stepKeyFor(kind: ImRoomStepKind): string {
    this.stepCounter += 1
    return `${kind}-${this.stepCounter}`
  }
}
