import type { AgentPlan } from "@/types/agent/plan"

import { isChatHandoffPlan, readChatHandoff, settlePlanChatHandoffAfterTurn } from "./chat-handoff"

const getExecutingPlanForSession = jest.fn()
const settleChatHandoff = jest.fn()
jest.mock("./runtime", () => ({
  getPlanRuntime: () => ({
    getExecutingPlanForSession: (...a: unknown[]) => getExecutingPlanForSession(...a),
    settleChatHandoff: (...a: unknown[]) => settleChatHandoff(...a),
  }),
}))

const handoff = { prompt: "go", mode: "acceptEdits", startedAt: 100, bootId: "b1" }
const plan = (metadata?: Record<string, unknown>) => ({ id: "p1", metadata }) as AgentPlan

beforeEach(() => jest.clearAllMocks())

describe("readChatHandoff", () => {
  it("reads a well-formed record", () => {
    expect(readChatHandoff(plan({ chatHandoff: handoff }))).toEqual(handoff)
    expect(isChatHandoffPlan(plan({ chatHandoff: handoff }))).toBe(true)
  })

  it.each([
    ["no metadata", undefined],
    ["no record", {}],
    ["an empty prompt", { chatHandoff: { ...handoff, prompt: " " } }],
    ["an unknown mode", { chatHandoff: { ...handoff, mode: "bypassPermissions" } }],
    ["no start time", { chatHandoff: { ...handoff, startedAt: "x" } }],
    ["no boot id", { chatHandoff: { ...handoff, bootId: 1 } }],
  ])("rejects %s", (_label, metadata) => {
    expect(readChatHandoff(plan(metadata))).toBeNull()
  })
})

describe("settlePlanChatHandoffAfterTurn", () => {
  it("settles the executing handed-off plan with the turn's outcome", async () => {
    getExecutingPlanForSession.mockResolvedValue(plan({ chatHandoff: handoff }))
    await settlePlanChatHandoffAfterTurn("s1", "cancelled", 150, "stopped")
    expect(getExecutingPlanForSession).toHaveBeenCalledWith("s1")
    expect(settleChatHandoff).toHaveBeenCalledWith("p1", "cancelled", "stopped")
  })

  it("ignores a turn that started before the handoff", async () => {
    getExecutingPlanForSession.mockResolvedValue(plan({ chatHandoff: handoff }))
    await settlePlanChatHandoffAfterTurn("s1", "completed", 99)
    expect(settleChatHandoff).not.toHaveBeenCalled()
  })

  it("ignores plans run any other way, and sessions without one", async () => {
    getExecutingPlanForSession.mockResolvedValue(plan({}))
    await settlePlanChatHandoffAfterTurn("s1", "completed", 150)
    getExecutingPlanForSession.mockResolvedValue(undefined)
    await settlePlanChatHandoffAfterTurn("s1", "completed", 150)
    expect(settleChatHandoff).not.toHaveBeenCalled()
  })

  it("never throws into the turn's teardown", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    getExecutingPlanForSession.mockRejectedValue(new Error("db down"))
    await expect(settlePlanChatHandoffAfterTurn("s1", "failed", 150)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
