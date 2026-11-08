/** @jest-environment node */
import type { UIMessage } from "ai"
import { ROOM_HANDOFF_BRIEF_MAX_CHARS } from "@/types/squads/room-handoff"
import {
  decisionFromOutput,
  findRoomHandoffProposal,
  handoffDecisionOf,
  isRoomHandoffToolPart,
  parseRoomHandoffArgs,
  parseRoomHandoffOutput,
  withHandoffDecision,
} from "./proposal"

const reply = (parts: unknown[], metadata: Record<string, unknown> = { senderId: "ava" }) =>
  ({ id: "m1", role: "assistant", parts, metadata }) as unknown as UIMessage

const call = (extra: Record<string, unknown> = {}) => ({
  type: "tool-room_handoff_to_squad",
  toolCallId: "tu-1",
  state: "output-available",
  input: { brief: "  Write a hello script  ", squadId: "sq-1" },
  ...extra,
})

const declined = { status: "declined", decidedAt: 5, decidedBy: { kind: "local" } } as const

describe("isRoomHandoffToolPart", () => {
  it("recognises both name forms and the dynamic shape, and nothing else", () => {
    expect(isRoomHandoffToolPart({ type: "tool-room_handoff_to_squad" })).toBe(true)
    expect(
      isRoomHandoffToolPart({ type: "tool-mcp__cognia-plugin-tools__room_handoff_to_squad" })
    ).toBe(true)
    expect(isRoomHandoffToolPart({ type: "dynamic-tool", toolName: "room_handoff_to_squad" })).toBe(
      true
    )
    expect(isRoomHandoffToolPart({ type: "tool-team_delegate" })).toBe(false)
    expect(isRoomHandoffToolPart({ type: "text" })).toBe(false)
    expect(isRoomHandoffToolPart(null)).toBe(false)
  })
})

describe("parseRoomHandoffArgs", () => {
  it("trims the brief and the squad id, caps the brief, and refuses an empty one", () => {
    expect(parseRoomHandoffArgs({ brief: " go ", squadId: " sq " })).toEqual({
      ok: true,
      args: { brief: "go", squadId: "sq" },
    })
    expect(parseRoomHandoffArgs({ brief: "go", squadId: "  " })).toEqual({
      ok: true,
      args: { brief: "go" },
    })
    const long = parseRoomHandoffArgs({ brief: "x".repeat(ROOM_HANDOFF_BRIEF_MAX_CHARS + 5) })
    expect(long.ok && long.args.brief).toHaveLength(ROOM_HANDOFF_BRIEF_MAX_CHARS)
    expect(parseRoomHandoffArgs({ brief: "  " })).toEqual({ ok: false, reason: "brief_required" })
    expect(parseRoomHandoffArgs(undefined)).toEqual({ ok: false, reason: "brief_required" })
  })
})

describe("parseRoomHandoffOutput", () => {
  it("reads an object or a JSON string, and nothing that is no output of this tool", () => {
    const output = { status: "proposed", proposalId: "tu-1", brief: "go" }
    expect(parseRoomHandoffOutput(output)).toEqual(output)
    expect(parseRoomHandoffOutput(JSON.stringify(output))).toEqual(output)
    expect(parseRoomHandoffOutput("Error: no")).toBeNull()
    expect(parseRoomHandoffOutput({ status: "done", proposalId: "x", brief: "go" })).toBeNull()
  })
})

describe("findRoomHandoffProposal", () => {
  it("finds the call by id with its proposer, arguments, member run and decision", () => {
    const messages = [
      { id: "u1", role: "user", parts: [] } as unknown as UIMessage,
      reply(
        [
          { type: "text", text: "On it" },
          call({
            output: { status: "proposed", proposalId: "tu-1", brief: "x", memberRunId: "r1" },
          }),
        ],
        { senderId: "ava", squadHandoffs: { "tu-1": declined } }
      ),
    ]
    expect(findRoomHandoffProposal(messages, "tu-1")).toEqual({
      messageId: "m1",
      proposerId: "ava",
      toolUseId: "tu-1",
      args: { brief: "Write a hello script", squadId: "sq-1" },
      memberRunId: "r1",
      decision: declined,
    })
    expect(findRoomHandoffProposal(messages, "tu-2")).toBeNull()
  })

  it("reads an auto call's decision from its output when the reply holds none", () => {
    const output = {
      status: "started",
      proposalId: "tu-1",
      brief: "x",
      squadId: "sq-1",
      squadName: "Builders",
      delegationRunId: "execution:delegation:room-handoff:tu-1",
      squadRunId: "execution:team:r1",
      decidedAt: 9,
    }
    expect(findRoomHandoffProposal([reply([call({ output })])], "tu-1")?.decision).toEqual(
      decisionFromOutput(output as never)
    )
    expect(decisionFromOutput(output as never)).toMatchObject({
      status: "started",
      decidedBy: { kind: "auto" },
      squadRunId: "execution:team:r1",
    })
  })

  it("is no proposal without a brief, without a proposer, or on a user row", () => {
    expect(findRoomHandoffProposal([reply([call({ input: {} })])], "tu-1")).toBeNull()
    expect(findRoomHandoffProposal([reply([call()], {})], "tu-1")).toBeNull()
    const user = { id: "u", role: "user", parts: [call()], metadata: { senderId: "x" } }
    expect(findRoomHandoffProposal([user as unknown as UIMessage], "tu-1")).toBeNull()
  })
})

describe("withHandoffDecision", () => {
  it("records the decision beside others, once, and returns the reply as it is afterwards", () => {
    const original = reply([call()], { senderId: "ava", squadHandoffs: { other: declined } })
    const patch = withHandoffDecision("tu-1", { ...declined, decidedAt: 7 })
    const once = patch(original)
    expect(handoffDecisionOf(once, "tu-1")).toEqual({ ...declined, decidedAt: 7 })
    expect(handoffDecisionOf(once, "other")).toEqual(declined)
    expect((once as { metadata?: Record<string, unknown> }).metadata?.senderId).toBe("ava")
    expect(patch(once)).toBe(once)
    // A later decision never replaces the first.
    expect(withHandoffDecision("tu-1", { ...declined, decidedAt: 8 })(once)).toBe(once)
  })
})
