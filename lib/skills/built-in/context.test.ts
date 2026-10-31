const mockSessionGet = jest.fn()
const mockProjectGet = jest.fn()
const mockJobs = jest.fn()
const mockRunGet = jest.fn()
const mockTeamGet = jest.fn()
const mockTeamRunGet = jest.fn()
const mockTeamContext = jest.fn()
jest.mock("@/lib/claude/agents/dispatch-context-registry", () => ({
  getTeamDispatchContext: (...args: unknown[]) => mockTeamContext(...args),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    sessions: { get: (...a: unknown[]) => mockSessionGet(...a) },
    projects: { get: (...a: unknown[]) => mockProjectGet(...a) },
    executionRuns: { get: (...a: unknown[]) => mockRunGet(...a) },
    agentTeams: { get: (...a: unknown[]) => mockTeamGet(...a) },
    agentTeamRuns: { get: (...a: unknown[]) => mockTeamRunGet(...a) },
    connectorInboundJobs: {
      where: () => ({ equals: () => ({ toArray: () => mockJobs() }) }),
    },
  })),
}))

const mockReadForResolution = jest.fn()
jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: (...a: unknown[]) => mockReadForResolution(...a),
}))

const mockGetAdapterInstance = jest.fn()
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: (...a: unknown[]) => mockGetAdapterInstance(...a),
}))

import { resolveBuiltInSkillContext } from "./context"
import { assertLarkActingIdentity } from "./lark/acting-identity"
import { resolveLarkAuth } from "./lark/auth-bridge"
import { connectorsKeyringGet, connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { larkUserRequest } from "@/lib/connectors/adapters/lark/http"
import { getDb } from "@/lib/db/schema"
import { z } from "zod"
import { runBuiltInSkill } from "./dispatcher"
import { registerBuiltInSkill, getSharedBuiltInSkillRegistry } from "./registry"

jest.mock("@/lib/db/connector-audit", () => ({ append: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(),
  connectorsLarkUserAuth: jest.fn(),
  connectorsHttpRequest: jest.fn(),
}))
import {
  registerSubagentApprovalRoute,
  __clearAllSubagentApprovalRoutesForTesting,
} from "@/lib/claude/agents/subagent-approval-routes"

beforeEach(() => {
  jest.clearAllMocks()
  mockTeamContext.mockReturnValue(undefined)
  __clearAllSubagentApprovalRoutesForTesting()
  mockGetAdapterInstance.mockResolvedValue(undefined)
  mockJobs.mockResolvedValue([])
  mockRunGet.mockResolvedValue({ sessionId: "s1" })
})

describe("acting IM senders", () => {
  const binding = { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc_1" }
  const job = (remoteUserId: string, extra: Record<string, unknown> = {}) => ({
    adapterId: "a1",
    status: "running",
    executionRunId: "run-1",
    receivedAt: 1,
    createdAt: 1,
    event: {
      sender: { remoteUserId },
      channelData: { identityScope: { unionId: `union-${remoteUserId}` } },
    },
    ...extra,
  })

  beforeEach(() => mockSessionGet.mockResolvedValue({ id: "s1", platformBinding: binding }))

  it("hydrates the running sender and principal", async () => {
    mockJobs.mockResolvedValue([job("owner", { principalId: "principal-1" })])
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toEqual([
      { remoteUserId: "owner", principalId: "principal-1", unionId: "union-owner" },
    ])
  })

  it("includes completed messages merged into the same execution, excluding earlier turns", async () => {
    mockJobs.mockResolvedValue([
      job("owner"),
      job("other", { status: "completed" }),
      job("earlier", { status: "completed", executionRunId: "old-run" }),
    ])
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toEqual([
      { remoteUserId: "owner", unionId: "union-owner" },
      { remoteUserId: "other", unionId: "union-other" },
    ])
  })

  it("keeps unresolved steering handoffs unknown", async () => {
    mockJobs.mockResolvedValue([job("owner"), job("other", { status: "steering" })])
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
  })

  it("does not borrow the owner's running job for another session's unattended run", async () => {
    mockJobs.mockResolvedValue([job("owner")])
    mockRunGet.mockResolvedValue({ sessionId: "another-session" })
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
    mockRunGet.mockResolvedValue(undefined)
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
    mockRunGet.mockRejectedValue(new Error("run lookup failed"))
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
  })

  it("uses local intake time for a late-delivered unattributed steer", async () => {
    mockJobs.mockResolvedValue([
      job("owner", { receivedAt: 100, createdAt: 10 }),
      job("late", {
        status: "completed",
        dispatchMode: "steer",
        executionRunId: undefined,
        receivedAt: 2,
        createdAt: 11,
      }),
    ])
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
  })

  it("ignores replay-waiting steers but refuses live handoffs", async () => {
    const replay = job("other", {
      status: "steering",
      event: { sender: { remoteUserId: "other" }, channelData: { dispatchIntent: "steer-replay" } },
    })
    mockJobs.mockResolvedValue([job("owner"), replay])
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toEqual([
      { remoteUserId: "owner", unionId: "union-owner" },
    ])
    mockJobs.mockResolvedValue([
      job("owner"),
      { ...replay, event: { sender: { remoteUserId: "other" } } },
    ])
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
  })

  it("keeps missing run ids and unattributed completed steers unknown", async () => {
    mockJobs.mockResolvedValue([job("owner", { executionRunId: undefined })])
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
    mockJobs.mockResolvedValue([
      job("owner"),
      job("other", { status: "completed", dispatchMode: "steer", executionRunId: undefined }),
    ])
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
  })

  it("ignores unattributed steers from earlier turns and messages queued for the next turn", async () => {
    mockJobs.mockResolvedValue([
      job("owner", { receivedAt: 5, createdAt: 5 }),
      job("earlier", {
        status: "completed",
        dispatchMode: "steer",
        executionRunId: undefined,
        receivedAt: 2,
        createdAt: 2,
      }),
      job("other", { status: "queued", dispatchMode: "queue", receivedAt: 6 }),
    ])
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toEqual([
      { remoteUserId: "owner", unionId: "union-owner" },
    ])
  })

  it("uses unknown when no job exists or the lookup fails", async () => {
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
    mockJobs.mockRejectedValue(new Error("read failed"))
    expect((await resolveBuiltInSkillContext("s1")).actingSenders).toBe("unknown")
  })
})

describe("resolveBuiltInSkillContext", () => {
  it("keeps non-renderer callers without a session store on the bare lane, but refuses known lineage", async () => {
    jest.mocked(getDb).mockImplementationOnce(() => {
      throw new Error("Session store unavailable")
    })
    await expect(resolveBuiltInSkillContext("workflow:run")).resolves.toEqual({
      sessionId: "workflow:run",
    })
    registerSubagentApprovalRoute("foreground", {
      parentSessionId: "root",
      runId: "run",
      subagentId: "agent",
      backgrounded: false,
    })
    jest.mocked(getDb).mockImplementationOnce(() => {
      throw new Error("Session store unavailable")
    })
    await expect(resolveBuiltInSkillContext("foreground")).rejects.toThrow(
      "Session store unavailable"
    )
  })
  it("resolves teammates through the current run, never the team's creation session", async () => {
    mockTeamContext.mockImplementation((id) =>
      id === "teammate" ? { teamId: "team", runId: "team-run" } : undefined
    )
    mockTeamGet.mockResolvedValue({ sessionId: "creation-session" })
    mockRunGet.mockResolvedValue({ sessionId: "s1" })
    mockTeamRunGet.mockResolvedValue(undefined)
    const binding = { platform: "lark", adapterId: "a1", conversationKey: "chat" }
    mockSessionGet.mockImplementation(async (id) =>
      id === "s1" ? { platformBinding: binding } : { kind: "team" }
    )
    expect((await resolveBuiltInSkillContext("teammate")).imBinding).toEqual(binding)
    mockRunGet.mockResolvedValue(undefined)
    expect(await resolveBuiltInSkillContext("teammate")).toEqual({
      sessionId: "teammate",
      personalLane: "unverified",
    })
    expect(mockTeamGet).not.toHaveBeenCalled()
  })

  it("uses a durable squad's IM origin and refuses conflicting teammate lineage", async () => {
    mockTeamContext.mockImplementation((id) =>
      id === "teammate" ? { teamId: "team", runId: "run" } : undefined
    )
    mockRunGet.mockResolvedValue(undefined)
    mockTeamRunGet.mockResolvedValue({
      executionConstraints: { triggeredFrom: { source: "im", sessionId: "root" } },
    })
    const binding = { platform: "lark", adapterId: "a1", conversationKey: "chat" }
    mockSessionGet.mockImplementation(async (id) =>
      id === "root" ? { platformBinding: binding } : { kind: "team" }
    )
    expect((await resolveBuiltInSkillContext("teammate")).imBinding).toEqual(binding)
    mockRunGet.mockResolvedValue({ sessionId: "another-chat" })
    await expect(resolveBuiltInSkillContext("teammate")).rejects.toThrow("parent ambiguous")
  })

  it.each([
    { source: "ui" },
    { source: "api", deviceId: "paired-client" },
    { source: "ui", parentRunId: "settled-run" },
  ])("runs a non-personal built-in skill for a session-less Squad: %j", async (launch) => {
    mockTeamContext.mockImplementation((id) =>
      id === "teammate" ? { teamId: "team", runId: "run" } : undefined
    )
    mockSessionGet.mockResolvedValue({ id: "teammate", kind: "team" })
    mockRunGet.mockResolvedValue({ id: "execution:team:run", parentRunId: launch.parentRunId })
    mockTeamRunGet.mockResolvedValue({
      executionConstraints: { origin: "interactive", triggeredFrom: launch },
    })
    const execute = jest.fn(async () => ({ ok: true }))
    registerBuiltInSkill({
      id: "test.local_read",
      family: "test",
      label: { en: "Read", "zh-CN": "读取" },
      description: { en: "Read", "zh-CN": "读取" },
      platforms: [],
      mutation: "read",
      imAccess: "blocked",
      mcpToolName: "test_local_read",
      inputSchema: z.object({}),
      execute,
    })
    try {
      const context = await resolveBuiltInSkillContext("teammate")
      expect(context).toEqual({ sessionId: "teammate", personalLane: "unverified" })
      expect(await runBuiltInSkill("test.local_read", {}, context)).toMatchObject({ status: "ok" })
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      getSharedBuiltInSkillRegistry().unregister("test.local_read")
    }
  })

  it.each(["im", "connector"])(
    "keeps a session-less %s-claimed Squad unverified",
    async (source) => {
      mockTeamContext.mockReturnValue({ teamId: "team", runId: "run" })
      mockSessionGet.mockResolvedValue({ id: "teammate", kind: "team" })
      mockRunGet.mockResolvedValue({ id: "execution:team:run" })
      mockTeamRunGet.mockResolvedValue({
        executionConstraints: { origin: "im", triggeredFrom: { source, adapterId: "a1" } },
      })
      const context = await resolveBuiltInSkillContext("teammate")
      expect(context).toEqual({ sessionId: "teammate", personalLane: "unverified" })
      await expect(assertLarkActingIdentity("a1", context)).rejects.toThrow(
        "sender_not_token_owner"
      )
    }
  )

  it("keeps row-less UI teammates bare and refuses the Lark personal gate", async () => {
    mockTeamContext.mockReturnValue({ teamId: "team", runId: "run" })
    mockSessionGet.mockResolvedValue(undefined)
    mockRunGet.mockResolvedValue({ id: "execution:team:run" })
    mockTeamRunGet.mockResolvedValue({
      executionConstraints: { origin: "interactive", triggeredFrom: { source: "ui" } },
    })
    const context = await resolveBuiltInSkillContext("teammate")
    expect(context).toEqual({ sessionId: "teammate", personalLane: "unverified" })
    await expect(assertLarkActingIdentity("a1", context)).rejects.toThrow("sender_not_token_owner")
  })

  it.each([
    { origin: "scheduler", triggeredFrom: { source: "ui" } },
    { origin: "scheduler", triggeredFrom: { source: "schedule" } },
    { origin: "interactive", triggeredFrom: { source: "workflow" } },
    { origin: "interactive", triggeredFrom: { source: "ui", adapterId: "a1" } },
  ])("does not infer personal authority from an origin: %j", async (executionConstraints) => {
    mockTeamContext.mockImplementation((id) =>
      id === "teammate" ? { teamId: "team", runId: "run" } : undefined
    )
    mockSessionGet.mockImplementation(async (id) =>
      id === "teammate" ? { id, kind: "team" } : undefined
    )
    mockRunGet.mockResolvedValue({ id: "execution:team:run" })
    mockTeamRunGet.mockResolvedValue({ executionConstraints })
    const context = await resolveBuiltInSkillContext("teammate")
    expect(context.personalLane).toBe("unverified")
    expect(context.imBinding).toBeUndefined()
    await expect(assertLarkActingIdentity("a1", context)).rejects.toThrow("sender_not_token_owner")
  })

  it.each(["execution", "durable", "both"])(
    "keeps a session-less UI Squad with missing %s rows unverified",
    async (missing) => {
      mockTeamContext.mockReturnValue({ teamId: "team", runId: "run" })
      mockSessionGet.mockResolvedValue({ id: "teammate", kind: "team" })
      mockRunGet.mockResolvedValue(missing === "durable" ? {} : undefined)
      mockTeamRunGet.mockResolvedValue(
        missing === "execution"
          ? { executionConstraints: { origin: "interactive", triggeredFrom: { source: "ui" } } }
          : undefined
      )
      const context = await resolveBuiltInSkillContext("teammate")
      expect(context.personalLane).toBe("unverified")
      await expect(assertLarkActingIdentity("a1", context)).rejects.toThrow(
        "sender_not_token_owner"
      )
    }
  )

  it("inherits the root IM binding for a row-less foreground dispatch with an approval route", async () => {
    registerSubagentApprovalRoute("child", {
      parentSessionId: "s1",
      rootSessionId: "s1",
      runId: "run",
      subagentId: "agent",
      backgrounded: false,
    })
    const binding = { platform: "lark", adapterId: "a1", conversationKey: "chat" }
    mockSessionGet.mockImplementation(async (id) =>
      id === "s1" ? { platformBinding: binding } : undefined
    )
    expect((await resolveBuiltInSkillContext("child")).imBinding).toEqual(binding)
    mockSessionGet.mockResolvedValue(undefined)
    await expect(resolveBuiltInSkillContext("child")).rejects.toThrow("parent missing")
  })

  it("inherits row-less team member lineage from the host registry", async () => {
    mockTeamContext.mockImplementation((id) =>
      id === "row-less" ? { teamId: "team", runId: "run" } : undefined
    )
    mockRunGet.mockResolvedValue({ sessionId: "root" })
    mockTeamRunGet.mockResolvedValue(undefined)
    const binding = { platform: "lark", adapterId: "a1", conversationKey: "chat" }
    mockSessionGet.mockImplementation(async (id) =>
      id === "root" ? { platformBinding: binding } : undefined
    )
    expect((await resolveBuiltInSkillContext("row-less")).imBinding).toEqual(binding)
  })

  it("inherits row-less room member lineage from the host session-id codec", async () => {
    const binding = { platform: "lark", adapterId: "a1", conversationKey: "chat" }
    mockSessionGet.mockImplementation(async (id) =>
      id === "root" ? { platformBinding: binding } : undefined
    )
    expect((await resolveBuiltInSkillContext("root::char::member::turn")).imBinding).toEqual(
      binding
    )
  })

  it("permits 32 parent edges but refuses a longer chain", async () => {
    mockSessionGet.mockImplementation(async (id) =>
      Number(id) < 32 ? { parentSessionId: String(Number(id) + 1) } : {}
    )
    await expect(resolveBuiltInSkillContext("0")).resolves.toEqual({
      sessionId: "0",
      personalLane: "local-session",
    })
    mockSessionGet.mockImplementation(async (id) =>
      Number(id) < 33 ? { parentSessionId: String(Number(id) + 1) } : {}
    )
    await expect(resolveBuiltInSkillContext("0")).rejects.toThrow("depth exceeded")
  })

  it("keeps a child of a verified local root local", async () => {
    mockSessionGet.mockImplementation(async (id) =>
      id === "child" ? { parentSessionId: "root", kind: "subagent" } : { id: "root" }
    )
    await expect(resolveBuiltInSkillContext("child")).resolves.toEqual({
      sessionId: "child",
      personalLane: "local-session",
    })
    await expect(assertLarkActingIdentity("a1", { sessionId: "child" })).resolves.toBeUndefined()
  })

  it.each(["desktop", "background-child"])(
    "allows the personal token through a real local root: %s",
    async (sessionId) => {
      mockSessionGet.mockImplementation(async (id) =>
        id === "background-child"
          ? { id, kind: "subagent", parentSessionId: "desktop", visibility: "embedded" }
          : { id: "desktop" }
      )
      mockGetAdapterInstance.mockResolvedValue({
        id: "a1",
        type: "lark",
        enabled: true,
        settings: {},
      })
      jest
        .mocked(connectorsKeyringGet)
        .mockImplementation(async (_adapter, key) =>
          key === "user_token" ? "personal-token" : "app-credential"
        )
      const context = await resolveBuiltInSkillContext(sessionId)
      expect(context.personalLane).toBe("local-session")
      await expect(resolveLarkAuth({ adapterId: "a1", context })).resolves.toMatchObject({
        ok: true,
        env: { LARKSUITE_CLI_USER_ACCESS_TOKEN: "personal-token" },
      })
      expect(connectorsKeyringGet).toHaveBeenCalledWith("a1", "user_token")
    }
  )

  it("refuses a plugin's IM runTeam launch claiming interactive/ui before any personal-token read", async () => {
    // ctx.agent.runTeam forwards the plugin-selected origin without the calling
    // IM session; the manager persists these rows and registers this teammate.
    mockSessionGet.mockImplementation(async (id) =>
      id === "im-chat"
        ? { id, platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "chat" } }
        : { id, kind: "team" }
    )
    mockTeamContext.mockReturnValue({ teamId: "team", runId: "plugin-run" })
    mockRunGet.mockResolvedValue({ id: "execution:team:plugin-run" })
    mockTeamRunGet.mockResolvedValue({
      executionConstraints: { origin: "interactive", triggeredFrom: { source: "ui" } },
    })
    mockGetAdapterInstance.mockResolvedValue({
      id: "a1",
      type: "lark",
      enabled: true,
      settings: {},
    })
    jest
      .mocked(connectorsKeyringGet)
      .mockImplementation(async (_adapter, key) =>
        key === "user_token" ? "owner-token" : "app-credential"
      )
    const context = await resolveBuiltInSkillContext("teammate")
    expect(context).toEqual({ sessionId: "teammate", personalLane: "unverified" })
    // A caller-carried positive flag is not evidence either.
    context.personalLane = "local-session"
    await expect(assertLarkActingIdentity("a1", context)).rejects.toMatchObject({
      name: "LarkActingIdentityError",
    })
    await expect(resolveLarkAuth({ adapterId: "a1", context })).resolves.toMatchObject({
      ok: false,
      reason: "sender_not_token_owner",
    })
    await expect(
      larkUserRequest(
        "a1",
        { appId: "app", appSecret: "secret" },
        "GET",
        "/test",
        undefined,
        context
      )
    ).rejects.toMatchObject({ name: "LarkActingIdentityError" })
    expect(connectorsKeyringGet).not.toHaveBeenCalledWith("a1", "user_token")
    expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
  })

  it.each([
    { agentTurnOwner: { kind: "plugin", id: "plugin" } },
    { agentTurnOwner: { kind: "bot", id: "bot" } },
    { kind: "team", programmaticCreator: "workflow" },
    { programmaticCreator: "plugin-agent-sdk" },
    { programmaticCreator: "plugin-agent-executor" },
    { origin: { kind: "gateway-api" } },
    { title: "Plugin Agent Session" },
    { title: "Plugin Agent" },
    { integrationBinding: { kind: "legacy" } },
    { collaboration: { sessionId: "remote-shared-session" } },
    { kind: "subagent", visibility: "embedded" },
    { projectRole: "thread" },
  ])(
    "keeps non-desktop roots unverified without blocking non-personal context: %j",
    async (row) => {
      mockSessionGet.mockResolvedValue({ id: "root", ...row })
      const context = await resolveBuiltInSkillContext("root")
      expect(context.personalLane).toBe("unverified")
      await expect(assertLarkActingIdentity("a1", context)).rejects.toThrow(
        "sender_not_token_owner"
      )
    }
  )

  it.each([{ sessionId: "missing" }, { triggeredFrom: { sessionId: "missing" } }])(
    "refuses a team run naming a missing session: %j",
    async (executionConstraints) => {
      mockTeamContext.mockReturnValue({ teamId: "team", runId: "run" })
      mockSessionGet.mockImplementation(async (id) =>
        id === "teammate" ? { id, kind: "team" } : undefined
      )
      mockRunGet.mockResolvedValue({})
      mockTeamRunGet.mockResolvedValue({ executionConstraints })
      await expect(resolveBuiltInSkillContext("teammate")).rejects.toThrow("parent missing")
    }
  )

  it.each([
    { parentSessionId: "s1", kind: "subagent", visibility: "embedded" },
    { attachedChild: { parentSessionId: "s1" } },
    { surfaceBinding: { kind: "session", sessionId: "s1" } },
    { parentSessionId: "middle", platformBinding: { conversationKey: "forged" } },
  ])("inherits the root's IM gates and run actors for child %j", async (child) => {
    const binding = { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc_1" }
    mockSessionGet.mockImplementation(async (id) => {
      if (id === "child") return { id, workingDir: "/child", ...child }
      if (id === "middle") return { id, parentSessionId: "s1" }
      return { id: "s1", platformBinding: binding }
    })
    mockReadForResolution.mockResolvedValue({ allowedBuiltInSkillIds: [] })
    mockJobs.mockResolvedValue([
      {
        adapterId: "a1",
        status: "running",
        executionRunId: "root-run",
        receivedAt: 1,
        event: { sender: { remoteUserId: "other" } },
      },
    ])
    mockRunGet.mockResolvedValue({ sessionId: "s1" })
    const ctx = await resolveBuiltInSkillContext("child")
    expect(ctx).toMatchObject({
      sessionId: "child",
      workspaceRoot: "/child",
      imBinding: binding,
      imOverrideRow: { allowedBuiltInSkillIds: [] },
      actingSenders: [{ remoteUserId: "other" }],
    })
    expect(mockRunGet).toHaveBeenCalledWith("root-run")
    mockRunGet.mockResolvedValue({ sessionId: "child" })
    expect((await resolveBuiltInSkillContext("child")).actingSenders).toBe("unknown")
  })

  it.each(["missing", "cycle", "depth", "conflicting"])(
    "refuses unresolved child ancestry: %s",
    async (reason) => {
      mockSessionGet.mockImplementation(async (id: string) => {
        if (reason === "missing") return id === "child" ? { parentSessionId: "gone" } : undefined
        if (reason === "cycle") return { parentSessionId: id === "child" ? "parent" : "child" }
        if (reason === "conflicting")
          return { parentSessionId: "one", attachedChild: { parentSessionId: "two" } }
        return { parentSessionId: `${id}:next` }
      })
      await expect(resolveBuiltInSkillContext("child")).rejects.toThrow()
      expect(mockJobs).not.toHaveBeenCalled()
    }
  )

  it("returns a bare context for a row-less workflow run without host lineage", async () => {
    mockSessionGet.mockResolvedValue(undefined)
    await expect(resolveBuiltInSkillContext("workflow:run")).resolves.toEqual({
      sessionId: "workflow:run",
    })
  })

  it("hydrates imBinding + imOverrideRow for a platform-bound session", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      platformBinding: {
        platform: "lark",
        adapterId: "a1",
        conversationKey: "lark:a1:oc_1",
      },
    })
    mockReadForResolution.mockResolvedValue({ requireHitlForWrites: true })
    mockGetAdapterInstance.mockResolvedValue({
      builtInSkillCeiling: ["lark.calendar.list_events"],
      requireHitlForWrites: false,
    })
    const ctx = await resolveBuiltInSkillContext("s1")
    expect(ctx.sessionId).toBe("s1")
    expect(ctx.imBinding).toEqual({
      adapterId: "a1",
      platform: "lark",
      conversationKey: "lark:a1:oc_1",
    })
    expect(ctx.imOverrideRow).toEqual({ requireHitlForWrites: true })
    expect(ctx.imAdapterRow).toEqual({
      builtInSkillCeiling: ["lark.calendar.list_events"],
      requireHitlForWrites: false,
    })
    expect(mockReadForResolution).toHaveBeenCalledWith("lark:a1:oc_1")
    expect(mockGetAdapterInstance).toHaveBeenCalledWith("a1")
  })

  it("returns a bare context for desktop (non-bound) sessions", async () => {
    mockSessionGet.mockResolvedValue({ id: "s1" })
    const ctx = await resolveBuiltInSkillContext("s1")
    expect(ctx).toEqual({ sessionId: "s1", personalLane: "local-session" })
    expect(mockReadForResolution).not.toHaveBeenCalled()
  })

  it("uses the session working directory as the desktop workspace root", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      workingDir: " /workspace/session ",
      projectId: "project-1",
    })

    await expect(resolveBuiltInSkillContext("s1")).resolves.toMatchObject({
      sessionId: "s1",
      workspaceRoot: "/workspace/session",
    })
    expect(mockProjectGet).not.toHaveBeenCalled()
  })

  it("falls back to the linked project's primary root", async () => {
    mockSessionGet.mockResolvedValue({ id: "s1", projectId: "project-1" })
    mockProjectGet.mockResolvedValue({
      id: "project-1",
      roots: [
        { id: "secondary", path: "/workspace/secondary" },
        { id: "primary", path: "/workspace/primary", isPrimary: true },
      ],
    })

    await expect(resolveBuiltInSkillContext("s1")).resolves.toMatchObject({
      sessionId: "s1",
      workspaceRoot: "/workspace/primary",
    })
    expect(mockProjectGet).toHaveBeenCalledWith("project-1")
  })

  it("keeps hydrating connector context when the linked project cannot be read", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      projectId: "project-1",
      platformBinding: {
        platform: "lark",
        adapterId: "a1",
        conversationKey: "lark:a1:oc_1",
      },
    })
    mockProjectGet.mockRejectedValue(new Error("project table unavailable"))
    mockReadForResolution.mockResolvedValue(null)

    await expect(resolveBuiltInSkillContext("s1")).resolves.toMatchObject({
      sessionId: "s1",
      imBinding: { adapterId: "a1", conversationKey: "lark:a1:oc_1" },
    })
  })

  it("keeps the binding when the override read fails (best-effort)", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc_1" },
    })
    mockReadForResolution.mockRejectedValue(new Error("dexie down"))
    const ctx = await resolveBuiltInSkillContext("s1")
    expect(ctx.imBinding?.adapterId).toBe("a1")
    expect(ctx.imOverrideRow).toBeUndefined()
  })

  it("keeps the binding when the adapter read fails (best-effort)", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc_1" },
    })
    mockReadForResolution.mockResolvedValue(null)
    mockGetAdapterInstance.mockRejectedValue(new Error("adapter table unavailable"))
    const ctx = await resolveBuiltInSkillContext("s1")
    expect(ctx.imBinding?.adapterId).toBe("a1")
    expect(ctx.imAdapterRow).toBeUndefined()
  })

  it("fails closed when the session lookup throws", async () => {
    mockSessionGet.mockRejectedValue(new Error("no db"))
    await expect(resolveBuiltInSkillContext("s1")).rejects.toThrow("no db")
  })

  it("treats a missing override row (null) as undefined", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc_1" },
    })
    mockReadForResolution.mockResolvedValue(null)
    const ctx = await resolveBuiltInSkillContext("s1")
    expect(ctx.imOverrideRow).toBeUndefined()
  })
})

// A persisted desktop team root proves the same local authority as a direct chat.
it("allows a local team member to use the personal lane through its persisted root", async () => {
  mockSessionGet.mockImplementation(async (id) =>
    id === "local-team" ? { id, kind: "team" } : undefined
  )
  const { subSessionId } = await import("@/lib/claude/team-session-id")
  const context = await resolveBuiltInSkillContext(subSessionId("local-team", "member", "turn"))
  expect(context.personalLane).toBe("local-session")
  await expect(assertLarkActingIdentity("a1", context)).resolves.toBeUndefined()
})
