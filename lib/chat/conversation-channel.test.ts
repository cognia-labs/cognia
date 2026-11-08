import { loggers } from "@cognia/logging"
import type { HostModuleManifest } from "@/lib/modules/manifest-types"
import { __resetPortsForTesting, __setPortModulesForTesting } from "@/lib/modules/ports"
import type { ConversationChannel } from "@/types/modules/ports/conversation-channel"
import { conversationChannelFor } from "./conversation-channel"

function channel(claims: (key: string) => boolean): ConversationChannel {
  return {
    claimsBinding: (binding) => claims(binding.conversationKey),
    hostCapabilities: jest.fn(),
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
