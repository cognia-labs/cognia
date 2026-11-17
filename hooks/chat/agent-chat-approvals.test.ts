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

function context() {
  const clearApproval = jest.fn()
  const store = { getState: () => ({ clearApproval }) } as unknown as typeof useChatStore
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
