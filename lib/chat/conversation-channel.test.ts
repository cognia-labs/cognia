import { loggers } from "@cognia/logging"
import type { HostModuleManifest } from "@/lib/modules/manifest-types"
import { __resetPortsForTesting, __setPortModulesForTesting } from "@/lib/modules/ports"
import type { ConversationChannel } from "@/types/modules/ports/conversation-channel"
import {
  askUserInConversation,
  conversationChannelFor,
  recordConversationCallbackBinding,
} from "./conversation-channel"

function channel(
  claims: (key: string) => boolean,
  askUser: ConversationChannel["askUser"] = jest.fn(async () => null),
  recordCallbackBinding: ConversationChannel["recordCallbackBinding"] = jest.fn(async () => false)
): ConversationChannel {
  return {
    claimsBinding: (binding) => claims(binding.conversationKey),
    askUser,
    confirmSkill: jest.fn(),
    approveWorkflowRun: jest.fn(),
    approveWorkflowFanout: jest.fn(),
    recordCallbackBinding,
    hostCapabilities: jest.fn(),
    capabilityPrompt: jest.fn(),
    channelCapabilities: jest.fn(),
    waitForAutomation: jest.fn(),
    listSiblingConversations: jest.fn(),
    postText: jest.fn(),
    appendAudit: jest.fn(),
  }
}

function moduleProviding(id: string, load: () => Promise<unknown>): HostModuleManifest {
  return {
    id,
    kind: "module",
    stage: "stable",
    provides: [{ port: "conversation-channel", load }],
  } as unknown as HostModuleManifest
}

let errorLog: jest.SpyInstance
beforeEach(() => {
  errorLog = jest.spyOn(loggers.chat, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  __resetPortsForTesting()
  errorLog.mockRestore()
})

describe("conversationChannelFor", () => {
  it("returns the channel that claims the binding", async () => {
    const im = channel((key) => key.startsWith("lark:"))
    const bot = channel((key) => key.startsWith("bot:"))
    __setPortModulesForTesting([
      moduleProviding("connectors", async () => ({ port: im })),
      moduleProviding("bot", async () => ({ port: bot })),
    ])
    expect(await conversationChannelFor({ conversationKey: "bot:b1:t1" })).toBe(bot)
    expect(await conversationChannelFor({ conversationKey: "lark:a1:c1" })).toBe(im)
  })

  it("is null when no channel claims the binding, or none is active", async () => {
    __setPortModulesForTesting([
      moduleProviding("connectors", async () => ({ port: channel(() => false) })),
    ])
    expect(await conversationChannelFor({ conversationKey: "x" })).toBeNull()
    __resetPortsForTesting()
    __setPortModulesForTesting([])
    expect(await conversationChannelFor({ conversationKey: "lark:a1:c1" })).toBeNull()
  })

  it("logs a binding two channels claim and answers with the first", async () => {
    const first = channel(() => true)
    __setPortModulesForTesting([
      moduleProviding("connectors", async () => ({ port: first })),
      moduleProviding("bot", async () => ({ port: channel(() => true) })),
    ])
    expect(await conversationChannelFor({ conversationKey: "k" })).toBe(first)
    expect(errorLog).toHaveBeenCalledWith("several conversation channels claim one binding", {
      conversationKey: "k",
      modules: ["connectors", "bot"],
    })
  })

  it("logs a channel that fails to load and keeps the others", async () => {
    const im = channel(() => true)
    __setPortModulesForTesting([
      moduleProviding("bot", async () => {
        throw new Error("chunk failed")
      }),
      moduleProviding("connectors", async () => ({ port: im })),
    ])
    expect(await conversationChannelFor({ conversationKey: "k" })).toBe(im)
    expect(errorLog).toHaveBeenCalledWith("conversation channel failed to load", {
      module: "bot",
      error: "Error: chunk failed",
    })
  })
})

describe("askUserInConversation", () => {
  const question = { sessionId: "s_1", toolUseId: "tu_1", args: { question: "Which?" } }

  it("goes to the first channel whose live turn owns the session", async () => {
    const idle = jest.fn(async () => null)
    const owner = jest.fn(async () => ({ result: "Selected: Beta" }))
    const later = jest.fn(async () => ({ result: "never" }))
    __setPortModulesForTesting([
      moduleProviding("bot", async () => ({ port: channel(() => false, idle) })),
      moduleProviding("connectors", async () => ({ port: channel(() => true, owner) })),
      moduleProviding("browser", async () => ({ port: channel(() => false, later) })),
    ])
    expect(await askUserInConversation(question)).toEqual({ result: "Selected: Beta" })
    expect(idle).toHaveBeenCalledWith(question)
    expect(owner).toHaveBeenCalledWith(question)
    expect(later).not.toHaveBeenCalled()
  })

  it("is null when no channel owns the session, or none is active", async () => {
    __setPortModulesForTesting([
      moduleProviding("connectors", async () => ({ port: channel(() => true) })),
    ])
    expect(await askUserInConversation(question)).toBeNull()
    __resetPortsForTesting()
    __setPortModulesForTesting([])
    expect(await askUserInConversation(question)).toBeNull()
  })

  it("asks the loaded channels when another fails to load", async () => {
    const owner = jest.fn(async () => ({ result: "ok" }))
    __setPortModulesForTesting([
      moduleProviding("bot", async () => {
        throw new Error("chunk failed")
      }),
      moduleProviding("connectors", async () => ({ port: channel(() => true, owner) })),
    ])
    expect(await askUserInConversation(question)).toEqual({ result: "ok" })
    expect(errorLog).toHaveBeenCalledWith("conversation channel failed to load", {
      module: "bot",
      error: "Error: chunk failed",
    })
  })
})

describe("recordConversationCallbackBinding", () => {
  const binding = {
    adapterId: "adp_1",
    actionId: "wfapp:1",
    kind: "wf_approve" as const,
    surfaceId: "wfsurf:1",
    payload: {},
    actorScope: { mode: "operators" as const },
  }

  it("goes to the first channel that serves the binding", async () => {
    const other = jest.fn(async () => false)
    const owner = jest.fn(async () => true)
    const later = jest.fn(async () => true)
    __setPortModulesForTesting([
      moduleProviding("bot", async () => ({ port: channel(() => false, undefined, other) })),
      moduleProviding("connectors", async () => ({ port: channel(() => true, undefined, owner) })),
      moduleProviding("browser", async () => ({ port: channel(() => false, undefined, later) })),
    ])
    expect(await recordConversationCallbackBinding(binding)).toBe(true)
    expect(other).toHaveBeenCalledWith(binding)
    expect(owner).toHaveBeenCalledWith(binding)
    expect(later).not.toHaveBeenCalled()
  })

  it("is false when no active channel serves it", async () => {
    __setPortModulesForTesting([
      moduleProviding("connectors", async () => ({ port: channel(() => true) })),
    ])
    expect(await recordConversationCallbackBinding(binding)).toBe(false)
    __resetPortsForTesting()
    __setPortModulesForTesting([])
    expect(await recordConversationCallbackBinding(binding)).toBe(false)
  })
})
