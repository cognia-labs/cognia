import type { PendingApproval } from "@cognia/agent-config-types"
import type { useChatStore } from "@/stores/chat"
import { respondToChatApproval, type AgentChatApprovalContext } from "./agent-chat-approvals"

const authorizeSharedSessionApproval = jest.fn()
jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  authorizeSharedSessionApproval: (...args: unknown[]) => authorizeSharedSessionApproval(...args),
}))

const resolveApproval = jest.fn()
const grantSessionBypass = jest.fn()
jest.mock("@/lib/ai/agent/execution/hitl/approval-registry", () => ({
  resolveApproval: (...args: unknown[]) => resolveApproval(...args),
  grantSessionBypass: (...args: unknown[]) => grantSessionBypass(...args),
}))

const grantDesktopSkillSessionBypass = jest.fn()
jest.mock("@/lib/skills/built-in/desktop-hitl", () => ({
  isBuiltInSkillApprovalRequestId: (id: string) => id.startsWith("builtin-skill:"),
  grantDesktopSkillSessionBypass: (...args: unknown[]) => grantDesktopSkillSessionBypass(...args),
}))

const recordChatToolApprovalDecision = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/policy/action-review/chat-tool-channel", () => ({
  recordChatToolApprovalDecision: (...args: unknown[]) => recordChatToolApprovalDecision(...args),
}))

const approveTool = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/ai/agent/execution/sidecar-client", () => ({
  approveTool: (...args: unknown[]) => approveTool(...args),
}))

const rememberDenial = jest.fn()
jest.mock("@/lib/ai/agent/execution/permissions/session-denials", () => ({
  rememberDenial: (...args: unknown[]) => rememberDenial(...args),
}))

const saveSettings = jest.fn(async (..._args: unknown[]) => undefined)
const toggleAlwaysAllow = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: { agentPermissions: {} },
      save: (...args: unknown[]) => saveSettings(...args),
      toggleAlwaysAllow: (...args: unknown[]) => toggleAlwaysAllow(...args),
    }),
  },
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: async () => false,
}))
jest.mock("@/lib/chat/canonical-sink", () => ({ recordChatCanonicalEvents: jest.fn() }))
jest.mock("@/lib/modules/ports", () => ({ loadPort: async () => null }))
jest.mock("@/lib/ai/agent/external/session/chat-decision-bridge", () => ({
  isExternalAgentApprovalRequestId: () => false,
}))

function approval(requestId: string, extra: Partial<PendingApproval> = {}): PendingApproval {
  return {
    sessionId: "chat",
    requestId,
    toolUseID: "tool-1",
    toolName: "Bash",
    input: {},
    ...extra,
  }
}

function context(pendingApprovals: PendingApproval[] = []) {
  const clearApproval = jest.fn()
  const store = {
    getState: () => ({
      clearApproval,
      setSessionDiagnostic: jest.fn(),
      sessions: { chat: { pendingApprovals } },
      pendingApprovals: [],
    }),
  } as unknown as typeof useChatStore
  const send = jest.fn(async () => true)
  const ctx: AgentChatApprovalContext = {
    store,
    sendRef: { current: send },
    getExecutionHandle: () => undefined,
  }
  return { ctx, clearApproval, send }
}

beforeEach(() => {
  jest.clearAllMocks()
  authorizeSharedSessionApproval.mockImplementation(async (_approval, decision) => decision)
  resolveApproval.mockReturnValue(true)
})

it("does nothing when a shared session refuses this person's answer", async () => {
  authorizeSharedSessionApproval.mockResolvedValue(null)
  const { ctx, clearApproval, send } = context()

  await respondToChatApproval(ctx, approval("external-tool-host:1"), "allow")

  expect(resolveApproval).not.toHaveBeenCalled()
  expect(approveTool).not.toHaveBeenCalled()
  expect(clearApproval).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it("answers a renderer tool host approval in the renderer and keeps the session bypass", async () => {
  const { ctx, clearApproval } = context()

  await respondToChatApproval(ctx, approval("external-tool-host:1"), "allow_always")

  expect(grantSessionBypass).toHaveBeenCalledWith("chat", "Bash")
  expect(resolveApproval).toHaveBeenCalledWith("chat", "external-tool-host:1", {
    decision: "allow_always",
  })
  expect(recordChatToolApprovalDecision).toHaveBeenCalled()
  expect(clearApproval).toHaveBeenCalledWith("external-tool-host:1", "chat")
  expect(approveTool).not.toHaveBeenCalled()
})

it("never turns an approval that forbids a standing rule into always-allow", async () => {
  const { ctx } = context()

  await respondToChatApproval(
    ctx,
    approval("external-tool-host:2", { suppressAlwaysAllowRule: true }),
    "allow_always"
  )

  expect(authorizeSharedSessionApproval).toHaveBeenCalledWith(expect.anything(), "allow")
  expect(grantSessionBypass).not.toHaveBeenCalled()
  expect(resolveApproval).toHaveBeenCalledWith("chat", "external-tool-host:2", {
    decision: "allow",
  })
})

it("denies a built-in skill consent in the renderer and sends the reason as a follow-up", async () => {
  const { ctx, clearApproval, send } = context()

  await respondToChatApproval(ctx, approval("builtin-skill:7"), "deny", {
    message: "  back it up first  ",
  })

  expect(grantDesktopSkillSessionBypass).not.toHaveBeenCalled()
  expect(resolveApproval).toHaveBeenCalledWith("chat", "builtin-skill:7", { decision: "deny" })
  expect(clearApproval).toHaveBeenCalledWith("builtin-skill:7", "chat")
  expect(send).toHaveBeenCalledWith("back it up first", undefined, { sessionId: "chat" })
  expect(approveTool).not.toHaveBeenCalled()
})

describe("an answer that arrives after its ask is gone", () => {
  it("a late always-allow on a renderer ask grants nothing and only takes the card down", async () => {
    resolveApproval.mockReturnValue(false)
    const { ctx, clearApproval } = context()

    await respondToChatApproval(ctx, approval("external-tool-host:late"), "allow_always")

    expect(grantSessionBypass).not.toHaveBeenCalled()
    expect(recordChatToolApprovalDecision).not.toHaveBeenCalled()
    expect(clearApproval).toHaveBeenCalledWith("external-tool-host:late", "chat")
  })

  it("a late denial with a reason sends no follow-up into the next turn", async () => {
    resolveApproval.mockReturnValue(false)
    const { ctx, clearApproval, send } = context()

    await respondToChatApproval(ctx, approval("external-tool-host:gone"), "deny", {
      message: "do it differently",
    })
    await respondToChatApproval(ctx, approval("builtin-skill:gone"), "deny", {
      message: "do it differently",
    })

    expect(send).not.toHaveBeenCalled()
    expect(recordChatToolApprovalDecision).not.toHaveBeenCalled()
    expect(clearApproval).toHaveBeenCalledTimes(2)
  })

  it("a late always-allow on a built-in skill ask grants no session bypass", async () => {
    resolveApproval.mockReturnValue(false)
    const { ctx } = context()

    await respondToChatApproval(ctx, approval("builtin-skill:late"), "allow_always")

    expect(grantDesktopSkillSessionBypass).not.toHaveBeenCalled()
  })

  it("an interrupted card is dismissed, never dispatched or remembered", async () => {
    const interrupted = approval("sidecar-1", { status: "interrupted" })
    const { ctx, clearApproval } = context([interrupted])

    // The caller's snapshot predates the interrupt; the store's entry decides.
    await respondToChatApproval(ctx, approval("sidecar-1"), "allow_always")

    expect(approveTool).not.toHaveBeenCalled()
    expect(saveSettings).not.toHaveBeenCalled()
    expect(toggleAlwaysAllow).not.toHaveBeenCalled()
    expect(recordChatToolApprovalDecision).not.toHaveBeenCalled()
    expect(clearApproval).toHaveBeenCalledWith("sidecar-1", "chat")
  })

  it("a dispatch the runtime refuses leaves no standing rule or remembered denial", async () => {
    const { ctx, clearApproval } = context()
    approveTool.mockRejectedValueOnce(new Error("stale request"))
    await expect(
      respondToChatApproval(
        ctx,
        approval("sidecar-2", { input: { command: "git status" } }),
        "allow_always"
      )
    ).rejects.toThrow("stale request")

    approveTool.mockRejectedValueOnce(new Error("stale request"))
    await expect(respondToChatApproval(ctx, approval("sidecar-3"), "deny")).rejects.toThrow(
      "stale request"
    )

    expect(saveSettings).not.toHaveBeenCalled()
    expect(toggleAlwaysAllow).not.toHaveBeenCalled()
    expect(rememberDenial).not.toHaveBeenCalled()
    expect(recordChatToolApprovalDecision).not.toHaveBeenCalled()
    expect(clearApproval).not.toHaveBeenCalled()
  })

  it("an accepted always-allow writes its rule after the runtime took the answer", async () => {
    const order: string[] = []
    approveTool.mockImplementationOnce(async () => {
      order.push("dispatch")
    })
    saveSettings.mockImplementationOnce(async () => {
      order.push("rule")
    })
    toggleAlwaysAllow.mockImplementationOnce(async () => {
      order.push("rule")
    })
    const { ctx, clearApproval } = context()

    await respondToChatApproval(
      ctx,
      approval("sidecar-4", { input: { command: "git status" } }),
      "allow_always"
    )

    expect(order).toEqual(["dispatch", "rule"])
    expect(approveTool).toHaveBeenCalledWith("chat", "sidecar-4", "allow")
    expect(clearApproval).toHaveBeenCalledWith("sidecar-4", "chat")
  })
})
