jest.mock("@/lib/i18n/runtime-translator", () => ({
  currentLocale: jest.fn(async () => "en"),
}))
jest.mock("@/lib/execution/acting-authority", () => ({
  ...jest.requireActual("@/lib/execution/acting-authority"),
  snapshotActingAuthority: jest.fn(async () => undefined),
  observeActingAuthority: jest.fn(async () => ({ ok: true })),
}))
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: jest.fn(),
  listExecutionRuns: jest.fn(),
}))
import { getExecutionRun, listExecutionRuns } from "@/lib/db/execution-runs"
import { observeActingAuthority, snapshotActingAuthority } from "@/lib/execution/acting-authority"
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/db/adapter-instances", () => ({ getAdapterInstance: jest.fn() }))
jest.mock("../context", () => ({
  ...jest.requireActual("../context"),
  resolveBuiltInSkillTurnActors: jest.fn(),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(async () => "owner-token"),
  connectorsLarkUserAuth: jest.fn(),
  connectorsHttpRequest: jest.fn(),
}))

import { getDb } from "@/lib/db/schema"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { resolveBuiltInSkillTurnActors } from "../context"
import { assertLarkActingIdentity } from "./acting-identity"
import type { BuiltInSkillActingSenders } from "../types"
import { connectorsLarkUserAuth, connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { larkUserRequest } from "@/lib/connectors/adapters/lark/http"
import {
  registerSubagentApprovalRoute,
  __clearAllSubagentApprovalRoutesForTesting,
} from "@/lib/claude/agents/subagent-approval-routes"

const sessionGet = jest.fn()
const runGet = jest.fn()
const localRun = {
  id: "desktop-run",
  sessionId: "s1",
  status: "running",
  actingIdentity: {
    schemaVersion: 1,
    rootRunId: "desktop-run",
    lane: "legacy",
    trigger: "local",
    authorizingPrincipal: { kind: "local-person" },
    requesters: [],
    authorityRevision: 0,
  },
}
const binding = { platform: "lark", adapterId: "a1", conversationKey: "chat" }

beforeEach(() => {
  jest.clearAllMocks()
  __clearAllSubagentApprovalRoutesForTesting()
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
    accountLabel: "Alice",
  } as never)
  jest
    .mocked(getDb)
    .mockReturnValue({ sessions: { get: sessionGet }, executionRuns: { get: runGet } } as never)
  jest
    .mocked(listExecutionRuns)
    .mockImplementation(
      async (options) => [{ ...localRun, sessionId: options?.sessionId ?? "s1" }] as never
    )
  jest.mocked(getExecutionRun).mockImplementation(async (id) => runGet(id))
  runGet.mockImplementation(async (id) => (id === localRun.id ? localRun : undefined))
  sessionGet.mockResolvedValue({ platformBinding: binding })
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: { connectedUser: { openId: "owner", unionId: "union-owner", name: "Alice" } },
  } as never)
  jest
    .mocked(resolveBuiltInSkillTurnActors)
    .mockResolvedValue({ actingSenders: [{ remoteUserId: "owner", unionId: "union-owner" }] })
})

it("allows the connected owner, including an available matching unionId", async () => {
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
  })
  expect(connectorsLarkUserAuth).toHaveBeenCalledTimes(1)
  expect(resolveBuiltInSkillTurnActors).toHaveBeenCalledWith("chat", "a1", "s1")
})

it("refuses Alice after Bob's token is published but before connectedUser is rewritten", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: {
      connectedUser: { openId: "owner", name: "Alice", authorizationEpoch: "auth-alice" },
    },
  } as never)
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "bob-token",
    authorizationEpoch: "auth-bob",
    accountLabel: "Bob",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("requires the atomic account label to match for legacy rows without an epoch", async () => {
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "bob-token",
    authorizationEpoch: "auth-bob",
    accountLabel: "Bob",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
    accountLabel: null,
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("returns the matching stamped authorization and fails closed on missing native state", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: { connectedUser: { openId: "owner", authorizationEpoch: "auth-owner" } },
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
  })
  jest.mocked(connectorsLarkUserAuth).mockResolvedValueOnce({
    configured: false,
    accessToken: null,
    authorizationEpoch: "auth-owner",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
  jest.mocked(connectorsLarkUserAuth).mockRejectedValueOnce(new Error("native lookup failed"))
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("compares a nameless legacy account using its openId", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: { connectedUser: { openId: "owner" } },
  } as never)
  jest.mocked(connectorsLarkUserAuth).mockResolvedValueOnce({
    configured: true,
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
    accountLabel: "owner",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
  })
})

it("uses the stamped epoch even when two users have the same display name", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: {
      connectedUser: { openId: "owner", name: "Alice", authorizationEpoch: "auth-alice" },
    },
  } as never)
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "bob-token",
    authorizationEpoch: "auth-bob",
    accountLabel: "Alice",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

const refusedActors: BuiltInSkillActingSenders[] = [
  [{ remoteUserId: "other" }],
  [{ remoteUserId: "owner" }, { remoteUserId: "other" }],
  "unknown",
  [],
  [{ remoteUserId: "owner", unionId: "wrong-union" }],
]
it.each(refusedActors.map((actingSenders) => ({ actingSenders })))(
  "refuses non-owner, mixed, unknown, empty, or mismatching union actors: %j",
  async ({ actingSenders }) => {
    jest.mocked(resolveBuiltInSkillTurnActors).mockResolvedValue({ actingSenders })
    await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
      reason: "sender_not_token_owner",
    })
  }
)

it("refuses adapters without a connected user", async () => {
  jest
    .mocked(getAdapterInstance)
    .mockResolvedValue({ type: "lark", enabled: true, settings: {} } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("fails closed on session and adapter lookup failures", async () => {
  sessionGet.mockRejectedValueOnce(new Error("read failed"))
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
  jest.mocked(getAdapterInstance).mockRejectedValueOnce(new Error("read failed"))
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("allows local sessions without a platform binding", async () => {
  sessionGet.mockResolvedValue({ id: "s1" })
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toBeUndefined()
  expect(getAdapterInstance).not.toHaveBeenCalled()
  expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
})

it("allows the HTTP personal-token path inside the recorded desktop run", async () => {
  sessionGet.mockResolvedValue({ id: "s1" })
  jest.mocked(connectorsHttpRequest).mockResolvedValueOnce({
    status: 200,
    body: JSON.stringify({ code: 0, data: { ok: true } }),
  } as never)
  await expect(
    larkUserRequest("a1", { appId: "app", appSecret: "secret" }, "GET", "/test", undefined, {
      sessionId: "s1",
    })
  ).resolves.toMatchObject({ code: 0, data: { ok: true } })
})

it.each([[], [localRun, { ...localRun, id: "sibling" }]].map((runs) => ({ runs })))(
  "refuses absent or ambiguous active runs: %j",
  async ({ runs }) => {
    sessionGet.mockResolvedValue({ id: "s1" })
    jest.mocked(listExecutionRuns).mockResolvedValue(runs as never)
    await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
      name: "LarkActingIdentityError",
    })
  }
)

it.each(["external-event", "schedule", "child", "requester"])(
  "refuses synced Bot/plugin and forked programmatic sessions with a %s run",
  async (trigger) => {
    sessionGet.mockResolvedValue({ id: "s1" })
    jest
      .mocked(listExecutionRuns)
      .mockResolvedValue([
        { ...localRun, actingIdentity: { ...localRun.actingIdentity, trigger } },
      ] as never)
    await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
      name: "LarkActingIdentityError",
    })
  }
)

it("requires a recorded local authorizer and fails closed on run read failures", async () => {
  sessionGet.mockResolvedValue({ id: "s1" })
  jest.mocked(listExecutionRuns).mockResolvedValue([
    {
      ...localRun,
      actingIdentity: { ...localRun.actingIdentity, authorizingPrincipal: undefined },
    },
  ] as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    name: "LarkActingIdentityError",
  })
  jest.mocked(listExecutionRuns).mockRejectedValueOnce(new Error("read failed"))
  await expect(
    larkUserRequest("a1", { appId: "app", appSecret: "secret" }, "GET", "/test", undefined, {
      sessionId: "s1",
    })
  ).rejects.toMatchObject({ name: "LarkActingIdentityError" })
  expect(connectorsHttpRequest).not.toHaveBeenCalled()
})

it("refuses an absent context before reading the personal authorization", async () => {
  await expect(assertLarkActingIdentity("a1")).rejects.toMatchObject({
    name: "LarkActingIdentityError",
  })
  expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
})

it("checks the root's live senders for a hidden child, including newly steered non-owners", async () => {
  sessionGet.mockImplementation(async (id) =>
    id === "child"
      ? { parentSessionId: "s1", kind: "subagent", visibility: "embedded" }
      : { platformBinding: binding }
  )
  await expect(assertLarkActingIdentity("a1", { sessionId: "child" })).resolves.toMatchObject({
    accessToken: "owner-token",
  })
  expect(resolveBuiltInSkillTurnActors).toHaveBeenCalledWith("chat", "a1", "s1")
  jest
    .mocked(resolveBuiltInSkillTurnActors)
    .mockResolvedValue({ actingSenders: [{ remoteUserId: "other" }] })
  await expect(assertLarkActingIdentity("a1", { sessionId: "child" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it.each(["cycle", "missing", "depth"])(
  "refuses invalid hidden-child ancestry: %s",
  async (reason) => {
    sessionGet.mockImplementation(async (id) => {
      if (reason === "cycle") return { parentSessionId: id }
      if (reason === "depth") return { parentSessionId: `${id}:next` }
      return id === "child" ? { parentSessionId: "gone" } : undefined
    })
    await expect(assertLarkActingIdentity("a1", { sessionId: "child" })).rejects.toMatchObject({
      reason: "sender_not_token_owner",
    })
    expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
  }
)

it("refuses a row-less session without lineage in both personal entrypoints", async () => {
  sessionGet.mockResolvedValue(undefined)
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "dispatch:placeholder" })
  ).rejects.toMatchObject({ reason: "sender_not_token_owner" })
  await expect(
    larkUserRequest("a1", { appId: "app", appSecret: "secret" }, "GET", "/test", undefined, {
      sessionId: "workflow:run",
    })
  ).rejects.toMatchObject({ reason: "sender_not_token_owner" })
  expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
  expect(connectorsHttpRequest).not.toHaveBeenCalled()
})

it("checks the root owner for a row-less foreground child with host lineage", async () => {
  registerSubagentApprovalRoute("foreground", {
    parentSessionId: "s1",
    runId: "run",
    subagentId: "agent",
    backgrounded: false,
  })
  sessionGet.mockImplementation(async (id) =>
    id === "s1" ? { platformBinding: binding } : undefined
  )
  // Host lineage names the exact admitted child run; it inherits the root.
  runGet.mockImplementation(async (id) =>
    id === "execution:job:run"
      ? { ...localRun, id, sessionId: "s1" }
      : id === localRun.id
        ? localRun
        : undefined
  )
  await expect(assertLarkActingIdentity("a1", { sessionId: "foreground" })).resolves.toMatchObject({
    accessToken: "owner-token",
  })
  expect(resolveBuiltInSkillTurnActors).toHaveBeenCalledWith("chat", "a1", "s1")
  jest
    .mocked(resolveBuiltInSkillTurnActors)
    .mockResolvedValue({ actingSenders: [{ remoteUserId: "other" }] })
  await expect(assertLarkActingIdentity("a1", { sessionId: "foreground" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("uses the explicit verified clicker on confirmation, never the running job", async () => {
  jest
    .mocked(resolveBuiltInSkillTurnActors)
    .mockResolvedValue({ actingSenders: [{ remoteUserId: "other" }] })
  await expect(
    assertLarkActingIdentity("a1", {
      sessionId: "s1",
      hitlBypass: true,
      actingSenders: [{ remoteUserId: "owner" }],
    })
  ).resolves.toEqual({ accessToken: "owner-token", authorizationEpoch: "auth-owner" })
  expect(resolveBuiltInSkillTurnActors).not.toHaveBeenCalled()
})

it("ignores an earlier owner snapshot when another sender is now acting", async () => {
  jest
    .mocked(resolveBuiltInSkillTurnActors)
    .mockResolvedValue({ actingSenders: [{ remoteUserId: "other" }] })
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "s1", actingSenders: [{ remoteUserId: "owner" }] })
  ).rejects.toMatchObject({ reason: "sender_not_token_owner" })
})

it.each([
  undefined,
  { platformBinding: { ...binding, platform: "slack" } },
  { platformBinding: { ...binding, adapterId: "another-app" } },
  { platformBinding: { ...binding, conversationKey: "" } },
])(
  "refuses missing sessions and bindings that cannot prove same-app identity: %j",
  async (session) => {
    sessionGet.mockResolvedValue(session)
    await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
      reason: "sender_not_token_owner",
    })
  }
)

it.each(
  [undefined, "unknown", []].map((actingSenders) => ({
    actingSenders: actingSenders as BuiltInSkillActingSenders | undefined,
  }))
)("refuses a Confirm re-fire without verified senders: %j", async ({ actingSenders }) => {
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "s1", hitlBypass: true, actingSenders })
  ).rejects.toMatchObject({ reason: "sender_not_token_owner" })
})

it.each(["missing", "revision_advanced"] as const)(
  "observes %s without changing the existing owner gate",
  async (reason) => {
    jest.mocked(snapshotActingAuthority).mockResolvedValueOnce({ runId: "run", revision: 2 })
    jest.mocked(observeActingAuthority).mockResolvedValueOnce({ ok: false, reason })
    await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
      accessToken: "owner-token",
      authorizationEpoch: "auth-owner",
    })
    await Promise.resolve()
    expect(observeActingAuthority).toHaveBeenCalledWith("run", 2, "lark-personal-token")
  }
)

it("does not wait for the observe-only personal-token check", async () => {
  jest.mocked(snapshotActingAuthority).mockResolvedValueOnce({ runId: "run", revision: 0 })
  jest.mocked(observeActingAuthority).mockReturnValueOnce(new Promise(() => {}))
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
  })
})

it("checks the root authority on a confirmed child replay after child cleanup", async () => {
  sessionGet.mockImplementation(async (id: string) =>
    id === "root" ? { platformBinding: binding } : undefined
  )
  await expect(
    assertLarkActingIdentity("a1", {
      sessionId: "gone-child",
      imAuthoritySessionId: "root",
      workspaceRoot: "/workspace-b",
      hitlBypass: true,
      actingSenders: [{ remoteUserId: "owner", unionId: "union-owner" }],
    })
  ).resolves.toMatchObject({ accessToken: "owner-token" })
  expect(sessionGet).toHaveBeenCalledWith("root")
  await expect(
    assertLarkActingIdentity("a1", {
      sessionId: "gone-child",
      imAuthoritySessionId: "root",
      actingSenders: [{ remoteUserId: "owner" }],
    })
  ).rejects.toMatchObject({ reason: "sender_not_token_owner" })
})

it.each(["bot", "plugin"])(
  "refuses an IM-bound %s external event even when the sender owns the token",
  async (kind) => {
    const run = {
      ...localRun,
      actingIdentity: {
        ...localRun.actingIdentity,
        trigger: "external-event",
        authorizingPrincipal: undefined,
      },
    }
    // The decision comes from the run, independent of session creator markers.
    jest.mocked(listExecutionRuns).mockResolvedValue([run] as never)
    runGet.mockResolvedValue(run)
    const context = {
      sessionId: "s1",
      ...(kind === "plugin"
        ? { outboundAuthorization: { kind: "plugin" as const, pluginId: "review-plugin" } }
        : {}),
    }
    await expect(assertLarkActingIdentity("a1", context)).rejects.toThrow(/phases 4 and 5/i)
    await expect(
      larkUserRequest(
        "a1",
        { appId: "app", appSecret: "secret" },
        "GET",
        "/search",
        undefined,
        context
      )
    ).rejects.toThrow(/phases 4 and 5/i)
    expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
    expect(connectorsHttpRequest).not.toHaveBeenCalled()
  }
)

it.each([[], [localRun, { ...localRun, id: "ambiguous" }]].map((runs) => ({ runs })))(
  "refuses IM personal access without an unambiguous recorded run: %j",
  async ({ runs }) => {
    jest.mocked(listExecutionRuns).mockResolvedValue(runs as never)
    await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
      name: "LarkActingIdentityError",
    })
    expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
  }
)

it("uses the shared Chinese refusal catalog when the runtime translator selects it", async () => {
  const { currentLocale } = await import("@/lib/i18n/runtime-translator")
  jest.mocked(currentLocale).mockResolvedValueOnce("zh-CN")
  jest.mocked(listExecutionRuns).mockResolvedValue([])
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toThrow(
    "个人访问需要 phase 4"
  )
  expect(currentLocale).toHaveBeenCalled()
})
