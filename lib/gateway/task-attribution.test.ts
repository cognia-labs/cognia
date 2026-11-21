import {
  GATEWAY_TASK_ATTRIBUTION_GRACE_MS,
  GATEWAY_TASK_ATTRIBUTION_LIMIT,
  gatewayTaskConversation,
  gatewayTaskIdOfSession,
  gatewayTaskProjectId,
  registerGatewayTaskAttribution,
  resetGatewayTaskAttributions,
} from "./task-attribution"

const mockSessions = new Map<string, { projectId?: string }>()
const mockGetSession = jest.fn(async (id: string) => mockSessions.get(id))
jest.mock("@/lib/db/sessions", () => ({
  getSession: (id: string) => mockGetSession(id),
}))

beforeEach(() => {
  jest.useFakeTimers()
  resetGatewayTaskAttributions()
  mockSessions.clear()
  mockGetSession.mockClear()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("gatewayTaskIdOfSession", () => {
  it("reads a desktop ticket's session as the task id", () => {
    expect(gatewayTaskIdOfSession("0b6f…task")).toBe("0b6f…task")
  })

  it("reads the task out of a Host or remote lease scope", () => {
    expect(gatewayTaskIdOfSession(JSON.stringify(["host-task", "", "t1"]))).toBe("t1")
    expect(gatewayTaskIdOfSession(JSON.stringify(["remote-task", "tenant", "dev", "t2"]))).toBe(
      "t2"
    )
  })

  it("names no task for anything else", () => {
    expect(gatewayTaskIdOfSession(undefined)).toBeUndefined()
    expect(gatewayTaskIdOfSession(null)).toBeUndefined()
    expect(gatewayTaskIdOfSession("")).toBeUndefined()
    expect(gatewayTaskIdOfSession("[not json")).toBeUndefined()
    expect(gatewayTaskIdOfSession(JSON.stringify(["person", "x", "y"]))).toBeUndefined()
    expect(gatewayTaskIdOfSession(JSON.stringify(["host-task", "dev", 3]))).toBeUndefined()
  })
})

describe("gateway task attribution", () => {
  it("resolves a registered task to its conversation's workspace", async () => {
    mockSessions.set("chat-1", { projectId: "proj-1" })
    registerGatewayTaskAttribution("t1", { chatSessionId: "chat-1" })
    expect(gatewayTaskConversation("t1")).toBe("chat-1")
    await expect(gatewayTaskProjectId("t1")).resolves.toBe("proj-1")
    await expect(gatewayTaskProjectId(JSON.stringify(["host-task", "dev", "t1"]))).resolves.toBe(
      "proj-1"
    )
  })

  it("answers nothing for an unknown task, a conversation without a workspace, or a failed read", async () => {
    await expect(gatewayTaskProjectId("missing")).resolves.toBeUndefined()
    expect(mockGetSession).not.toHaveBeenCalled()
    registerGatewayTaskAttribution("t1", { chatSessionId: "chat-1" })
    mockSessions.set("chat-1", {})
    await expect(gatewayTaskProjectId("t1")).resolves.toBeUndefined()
    mockGetSession.mockRejectedValueOnce(new Error("db closed"))
    await expect(gatewayTaskProjectId("t1")).resolves.toBeUndefined()
  })

  it("keeps a released task for the grace window, then forgets it", () => {
    const release = registerGatewayTaskAttribution("t1", { chatSessionId: "chat-1" })
    release()
    jest.advanceTimersByTime(GATEWAY_TASK_ATTRIBUTION_GRACE_MS - 1)
    expect(gatewayTaskConversation("t1")).toBe("chat-1")
    jest.advanceTimersByTime(1)
    expect(gatewayTaskConversation("t1")).toBeUndefined()
  })

  it("a stale release never drops the task's newer registration", () => {
    const stale = registerGatewayTaskAttribution("t1", { chatSessionId: "chat-1" })
    stale()
    registerGatewayTaskAttribution("t1", { chatSessionId: "chat-2" })
    stale()
    jest.advanceTimersByTime(GATEWAY_TASK_ATTRIBUTION_GRACE_MS * 2)
    expect(gatewayTaskConversation("t1")).toBe("chat-2")
  })

  it("holds a bounded number of tasks, dropping the oldest", () => {
    for (let i = 0; i <= GATEWAY_TASK_ATTRIBUTION_LIMIT; i += 1)
      registerGatewayTaskAttribution(`t${i}`, { chatSessionId: `chat-${i}` })
    expect(gatewayTaskConversation("t0")).toBeUndefined()
    expect(gatewayTaskConversation("t1")).toBe("chat-1")
    expect(gatewayTaskConversation(`t${GATEWAY_TASK_ATTRIBUTION_LIMIT}`)).toBe(
      `chat-${GATEWAY_TASK_ATTRIBUTION_LIMIT}`
    )
  })
})
