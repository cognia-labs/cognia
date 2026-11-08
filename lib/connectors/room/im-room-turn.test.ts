import type { Character, Team, TeamMember } from "@cognia/agent-config-types"
import { HANDOFF_STOP_TOKEN } from "@/lib/claude/team-router"
import {
  ImRoomTurn,
  primaryRoutingOf,
  visibleRoomReplyText,
  type ImRoomStep,
  type ImRoomTurnInput,
} from "./im-room-turn"

const character = (id: string, name: string): Character =>
  ({ id, name, avatarColor: "x", systemPrompt: "", createdAt: 0, updatedAt: 0 }) as Character

const ana = character("c-ana", "Ana")
const ben = character("c-ben", "Ben")
const cy = character("c-cy", "Cy")

const team = (overrides: Partial<Team> = {}, slots?: TeamMember[]): ImRoomTurnInput["team"] =>
  ({
    members: slots ?? [{ characterId: ana.id }, { characterId: ben.id }, { characterId: cy.id }],
    orchestration: "mention_round_robin",
    ...overrides,
  }) as ImRoomTurnInput["team"]

const turn = (input: Partial<ImRoomTurnInput> = {}) =>
  new ImRoomTurn({
    team: team(),
    characters: [cy, ben, ana],
    userText: "hello",
    messages: [],
    mutedMemberIds: [],
    now: () => 1_000,
    random: () => 1,
    ...input,
  })

/** Run the turn to its end, answering each step with `answer(step)`. */
function drive(room: ImRoomTurn, answer: (step: ImRoomStep) => string): ImRoomStep[] {
  const steps: ImRoomStep[] = []
  for (let step = room.next(); step; step = room.next()) {
    steps.push(step)
    room.record(step, answer(step))
  }
  return steps
}

const who = (steps: readonly ImRoomStep[]) =>
  steps.map((step) => `${step.kind}:${step.character.name}`)

describe("ImRoomTurn: who answers", () => {
  it("answers an unaddressed message with the member who spoke last, in team order", () => {
    const sticky = turn({
      messages: [
        { role: "assistant", metadata: { senderId: ben.id } },
        { role: "user", metadata: {} },
      ],
    })
    expect(who(drive(sticky, () => "Sure."))).toEqual(["reply:Ben"])
    expect(sticky.end).toEqual({ kind: "done", autoStop: null })

    // Nobody spoke yet: the first member the team declares, not the first resolved.
    expect(who(drive(turn(), () => "Sure."))).toEqual(["reply:Ana"])
  })

  it("takes the smart router's pick, unless that member is muted", () => {
    expect(who(drive(turn({ primaryCharacterId: cy.id }), () => "Hi"))).toEqual(["reply:Cy"])
    expect(
      who(drive(turn({ primaryCharacterId: cy.id, mutedMemberIds: [cy.id, ana.id] }), () => "Hi"))
    ).toEqual(["reply:Ben"])
  })

  it("lets an @-mention reach a muted member, and every named member answers", () => {
    const room = turn({ userText: "@Cy and @Ana, thoughts?", mutedMemberIds: [cy.id] })
    expect(who(drive(room, () => "Thoughts."))).toEqual(["reply:Cy", "reply:Ana"])
  })

  it("asks everyone who is not muted in a round-robin team, up to the response cap", () => {
    const all = turn({ team: team({ orchestration: "round_robin" }), mutedMemberIds: [ben.id] })
    expect(who(drive(all, () => "Hi"))).toEqual(["reply:Ana", "reply:Cy"])
    const capped = turn({ team: team({ orchestration: "round_robin", maxResponses: 1 }) })
    expect(who(drive(capped, () => "Hi"))).toEqual(["reply:Ana"])
  })

  it("holds a manual team until somebody is named", () => {
    const room = turn({ team: team({ orchestration: "manual" }) })
    expect(room.next()).toBeNull()
    expect(room.end).toEqual({ kind: "held", reason: "manual" })
    expect(
      who(drive(turn({ team: team({ orchestration: "manual" }), userText: "@Ben?" }), () => "Yes"))
    ).toEqual(["reply:Ben"])
  })

  it("answers a turn addressed to members with them, muted or not, whatever the routing", () => {
    expect(
      who(drive(turn({ targetMemberIds: [ben.id], mutedMemberIds: [ben.id] }), () => "Done."))
    ).toEqual(["reply:Ben"])
    expect(
      who(
        drive(
          turn({ team: team({ orchestration: "manual" }), targetMemberIds: [cy.id, ana.id] }),
          () => "Done."
        )
      )
    ).toEqual(["reply:Cy", "reply:Ana"])
    // A supervisor team hands the floor to the member, not to its supervisor.
    expect(
      who(
        drive(
          turn({
            team: team({ orchestration: "supervisor", supervisorCharacterId: ana.id }),
            targetMemberIds: [ben.id],
          }),
          () => "Done."
        )
      )
    ).toEqual(["reply:Ben"])
    // A target that is no member leaves the room to route the turn itself.
    expect(who(drive(turn({ targetMemberIds: ["c-gone"] }), () => "Hi"))).toEqual(["reply:Ana"])
  })

  it("names its steps so a replay can find them", () => {
    const steps = drive(turn({ team: team({ orchestration: "round_robin" }) }), () => "Hi")
    expect(steps.map((step) => step.stepKey)).toEqual(["reply-1", "reply-2", "reply-3"])
    expect(steps.every((step) => step.instruction === null && step.promptAddendum === "")).toBe(
      true
    )
  })
})

describe("ImRoomTurn: hand-offs", () => {
  const handoffTeam = team({ maxAutoRounds: 2 })

  it("runs the member a reply hands the floor to, and stops when the chain ends", () => {
    const room = turn({ team: handoffTeam })
    const steps = drive(room, (step) =>
      step.character.id === ana.id ? "@Ben can you check the numbers?" : "Checked, they add up."
    )
    expect(who(steps)).toEqual(["reply:Ana", "handoff:Ben"])
    expect(room.end).toEqual({ kind: "done", autoStop: "no-handoff" })
  })

  it("ends the chain on the stop token, which the reader never sees", () => {
    const room = turn({ team: handoffTeam })
    const steps = drive(room, () => `@Ben done here. ${HANDOFF_STOP_TOKEN}`)
    expect(who(steps)).toEqual(["reply:Ana"])
    expect(room.end).toEqual({ kind: "done", autoStop: "token" })
    expect(visibleRoomReplyText(steps[0]!, `@Ben done here. ${HANDOFF_STOP_TOKEN}`)).toBe(
      "@Ben done here."
    )
  })

  it("does not pass the floor on an idle acknowledgement or to a muted member", () => {
    const idle = turn({ team: handoffTeam })
    expect(who(drive(idle, () => "@Ben waiting for tasks"))).toEqual(["reply:Ana"])
    const muted = turn({ team: handoffTeam, mutedMemberIds: [ben.id] })
    expect(who(drive(muted, () => "@Ben can you check the numbers?"))).toEqual(["reply:Ana"])
  })

  it("never hands off when the team runs no extra rounds", () => {
    const room = turn()
    expect(who(drive(room, () => "@Ben can you check the numbers?"))).toEqual(["reply:Ana"])
    expect(room.end).toEqual({ kind: "done", autoStop: null })
  })
})

describe("ImRoomTurn: a supervisor team", () => {
  const supervised = (overrides: Partial<Team> = {}) =>
    team({ orchestration: "supervisor", supervisorCharacterId: ana.id, ...overrides })

  it("dispatches, then synthesises from what the members said", () => {
    const room = turn({ team: supervised(), mutedMemberIds: [cy.id] })
    const steps = drive(room, (step) => {
      if (step.kind === "supervisor") {
        return [
          'Let me ask. <dispatch to="Ben">Price it</dispatch>',
          '<dispatch to="ben">  price   IT </dispatch>',
          '<dispatch to="Cy">Draw it</dispatch>',
        ].join("\n")
      }
      if (step.kind === "dispatch") return "About 40."
      return "It costs about 40."
    })
    expect(who(steps)).toEqual(["supervisor:Ana", "dispatch:Ben", "synthesis:Ana"])
    expect(steps[0]!.promptAddendum).toContain("Ben")
    expect(steps[0]!.instruction).toBeNull()
    expect(steps[1]!.instruction).toBe("Dispatch from supervisor:\nPrice it")
    expect(steps[2]!.instruction).toBe("Synthesize the final reply.")
    expect(steps[2]!.promptAddendum).toContain("Ben replied: About 40.")
    expect(room.end).toEqual({ kind: "done", autoStop: null })
    expect(
      visibleRoomReplyText(steps[0]!, 'Let me ask. <dispatch to="Ben">Price it</dispatch>')
    ).toBe("Let me ask.")
  })

  it("lets the supervisor answer alone when it dispatches nobody", () => {
    const room = turn({ team: supervised() })
    expect(who(drive(room, () => "Easy: 42."))).toEqual(["supervisor:Ana"])
    expect(room.end).toEqual({ kind: "done", autoStop: null })
  })

  it("skips the synthesis when no dispatched member answered", () => {
    const room = turn({ team: supervised() })
    const steps = drive(room, (step) =>
      step.kind === "supervisor" ? '<dispatch to="Ben">Price it</dispatch>' : ""
    )
    expect(who(steps)).toEqual(["supervisor:Ana", "dispatch:Ben"])
  })

  it("counts every supervised run against the response cap", () => {
    const room = turn({ team: supervised({ maxResponses: 2 }) })
    const steps = drive(room, (step) =>
      step.kind === "supervisor"
        ? '<dispatch to="Ben">a</dispatch><dispatch to="Cy">b</dispatch>'
        : "done"
    )
    expect(who(steps)).toEqual(["supervisor:Ana", "dispatch:Ben"])
    expect(room.end).toEqual({ kind: "done", autoStop: "cap" })
  })

  it("says so when the supervisor is not on the team", () => {
    const room = turn({ team: supervised({ supervisorCharacterId: "c-gone" }) })
    expect(room.next()).toBeNull()
    expect(room.end).toEqual({ kind: "no-supervisor" })
  })
})

describe("primaryRoutingOf", () => {
  const base = {
    team: team(),
    characters: [ana, ben, cy],
    userText: "hello",
    messages: [{ role: "assistant", metadata: { senderId: cy.id } }],
    mutedMemberIds: [ana.id],
  }

  it("asks the router among the members the room may pick, telling it who spoke last", () => {
    expect(primaryRoutingOf(base)).toEqual({ candidates: [ben, cy], sticky: cy })
  })

  it("has nothing to ask when a member is named or the team picks no primary", () => {
    expect(primaryRoutingOf({ ...base, userText: "@Ben hi" })).toBeNull()
    expect(primaryRoutingOf({ ...base, team: team({ orchestration: "round_robin" }) })).toBeNull()
    expect(primaryRoutingOf({ ...base, mutedMemberIds: [ana.id, ben.id, cy.id] })).toBeNull()
    expect(primaryRoutingOf({ ...base, targetMemberIds: [ben.id] })).toBeNull()
  })
})
