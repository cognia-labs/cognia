import type { UIMessage } from "ai"
import type { SendOptions } from "@cognia/agent-config-types"
import { sessionExternalLane, setSessionExternalLane } from "@/lib/chat/steer-runtime"
import type { SessionCoalescingRegistry } from "@/lib/chat/stream-coalescing"
import type { useChatStore } from "@/stores/chat"
import { runExternalAgentTurn, type ExternalAgentTurnContext } from "./agent-chat-external-turn"

const ensureExternalAgentReady = jest.fn()
jest.mock("@/lib/agent/ensure-external-agent-ready", () => ({
  ensureExternalAgentReady: (...args: unknown[]) => ensureExternalAgentReady(...args),
}))

const userRow: UIMessage = { id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }
const earlier: UIMessage = {
  id: "assistant-0",
  role: "assistant",
  parts: [{ type: "text", text: "before" }],
}

function lane(overrides: Partial<ExternalAgentTurnContext> = {}) {
  const replaceSessionMessages = jest.fn()
  const store = {
    getState: () => ({ replaceSessionMessages, sessions: {} }),
  } as unknown as typeof useChatStore
  const refuseTurn = jest.fn(async () => false)
  const ctx: ExternalAgentTurnContext = {
    store,
    tDiagnostics: ((key: string) => key) as unknown as ExternalAgentTurnContext["tDiagnostics"],
    tPiPackages: ((key: string) => key) as unknown as ExternalAgentTurnContext["tPiPackages"],
    warnUndeliveredAttachments: jest.fn(),
    activeRef: { current: "chat" },
    ownedContinuationRef: { current: null },
    externalGatewayAbortRef: { current: new Map() },
    externalTurnSettlementsRef: { current: new Map() },
    externalToolHostsRef: { current: new Map() },
    releaseExternalToolHost: jest.fn(async () => undefined),
    registry: {} as SessionCoalescingRegistry,
    transcriptFenceRef: { current: null },
    opts: undefined,
    callOptions: undefined,
    sessionId: "chat",
    disarmBranch: jest.fn(),
    claimReplyBranch: jest.fn(() => ({})),
    rejectSend: jest.fn(() => false),
    session: undefined,
    isSessionAside: false,
    chatRunId: 1,
    executionRunId: "run-1",
    sendOptions: {} as SendOptions,
    turnManifest: undefined,
    previousMessages: [earlier],
    userMsg: userRow,
    skipAppend: false,
    next: [earlier, userRow],
    displayContent: "hello",
    personalAsideRequiresRebuild: false,
    personalAsideSourceDigest: undefined,
    externalTurn: {
      request: "hello",
      prompt: "hello",
      images: [],
      omitted: { attachments: [], unnamed: 0 },
    },
    executionContext: undefined,
    routeStamp: undefined,
    delegation: null,
    turnRuntimeRef: { kind: "external", agentId: "codex" },
    routedExternalAgentId: "codex",
    refuseTurn,
    boundWorkspaceRoot: undefined,
    takeArmedOwner: jest.fn(() => null),
    ...overrides,
  }
  return { ctx, replaceSessionMessages, refuseTurn }
}

beforeEach(() => {
  ensureExternalAgentReady.mockReset()
  setSessionExternalLane("chat", null)
})

it("refuses a turn no agent was routed to and rolls back the optimistic user row", async () => {
  const { ctx, replaceSessionMessages, refuseTurn } = lane({ routedExternalAgentId: undefined })

  await expect(runExternalAgentTurn(ctx)).resolves.toBe(false)

  expect(replaceSessionMessages).toHaveBeenCalledWith("chat", [earlier])
  expect(refuseTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      errorCode: "external_agent_not_selected",
      finishRun: true,
      diagnostic: expect.objectContaining({ code: "externalAgentNotSelected" }),
    })
  )
  // Nothing ran, so the session is not put on an external lane.
  expect(sessionExternalLane("chat")).toBeNull()
  expect(ensureExternalAgentReady).not.toHaveBeenCalled()
})

it("refuses before dispatch when the local agent cannot be readied, naming the gate's reason", async () => {
  ensureExternalAgentReady.mockResolvedValue({
    ok: false,
    reason: "blocked",
    detail: "environment refused",
  })
  const { ctx, replaceSessionMessages, refuseTurn } = lane({
    session: { id: "chat", projectId: "project-1" } as ExternalAgentTurnContext["session"],
    boundWorkspaceRoot: "/work/repo",
  })

  await expect(runExternalAgentTurn(ctx)).resolves.toBe(false)

  expect(ensureExternalAgentReady).toHaveBeenCalledWith(
    "codex",
    expect.objectContaining({
      deferConnect: false,
      environment: expect.objectContaining({
        projectId: "project-1",
        executionRoot: "/work/repo",
        surface: "interactive",
      }),
    })
  )
  expect(replaceSessionMessages).toHaveBeenCalledWith("chat", [earlier])
  expect(refuseTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      errorCode: "external_agent_unavailable",
      finishRun: true,
      diagnostic: expect.objectContaining({
        code: "externalAgentNotReady",
        message: "environment refused",
      }),
    })
  )
  // The lane is recorded before readiness, so a follow-up typed meanwhile
  // steers this agent; the refusal's own settle clears it.
  expect(sessionExternalLane("chat")).toBe("codex")
})
