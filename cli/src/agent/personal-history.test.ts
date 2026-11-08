/** @jest-environment node */
jest.mock("@/lib/execution/personal-visibility", () => ({
  preparePersonalHistory: jest.fn(),
}))

import type { SendOptions } from "@cognia/agent-config-types"
import { preparePersonalHistory } from "@/lib/execution/personal-visibility"
import { prepareCliPersonalHistory, rebuildCliPersonalHistory } from "./personal-history"
import { appendTranscript, createTransientTranscriptFs } from "./transcript"

const HOME = "/home/u/.cognia"

describe("CLI canonical personal history", () => {
  it("withholds portable marked records without a Host database and keeps stable legacy ids", async () => {
    const fs = createTransientTranscriptFs()
    appendTranscript(
      HOME,
      "s",
      {
        role: "assistant",
        content: "PRIVATE_SNIPPET",
        parts: [{ type: "text", text: "PRIVATE_TOOL_TITLE" }],
        metadata: {
          personalMarks: [{ person: { kind: "local-person" }, source: "lark-user", markedAt: 1 }],
        },
      },
      fs,
      10
    )
    const first = await prepareCliPersonalHistory(HOME, "s", fs)
    const second = await prepareCliPersonalHistory(HOME, "s", fs)
    expect(first.messages[0].content).toMatch(/^\[Withheld:/)
    expect(JSON.stringify(first.messages)).not.toContain("PRIVATE_")
    expect(first.withheldMessageIds).toEqual(["cli:0:10"])
    expect(second.visibilityDigest).toBe(first.visibilityDigest)
    expect(first.entries[0].content).toBe("PRIVATE_SNIPPET")
    expect(preparePersonalHistory).not.toHaveBeenCalled()
  })

  it("uses the Host reader resolution when a Host database exists and never swallows its failure", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} })
    try {
      jest
        .mocked(preparePersonalHistory)
        .mockRejectedValueOnce(new Error("Host binding unavailable"))
      await expect(
        prepareCliPersonalHistory(HOME, "s", createTransientTranscriptFs())
      ).rejects.toThrow("Host binding unavailable")
      expect(preparePersonalHistory).toHaveBeenCalledWith("s", [])
    } finally {
      if (original) Object.defineProperty(globalThis, "indexedDB", original)
      else Reflect.deleteProperty(globalThis, "indexedDB")
    }
  })
})

describe("CLI runtime rebuild", () => {
  const canonical = [
    { role: "assistant" as const, content: "[Withheld: personal content of owner]" },
  ]

  it("clears every native resume selector and replays only filtered canonical text", () => {
    const options: SendOptions = {
      provider: "anthropic",
      resumeSessionId: "stale-sdk",
      forkFromSessionId: "stale-fork",
      claudeAgentSdk: { version: 1, sessionId: "stale-nested", continue: true },
    }
    rebuildCliPersonalHistory(options, canonical, "base instructions")
    expect(options.resumeSessionId).toBeUndefined()
    expect(options.forkFromSessionId).toBeUndefined()
    expect(options.claudeAgentSdk?.sessionId).toBeUndefined()
    expect(options.claudeAgentSdk?.continue).toBeUndefined()
    expect(options.initialConversation).toEqual([])
    expect(options.appendSystemPrompt).toBe(
      "base instructions\n\n[Conversation history]\n\nassistant: [Withheld: personal content of owner]"
    )
    rebuildCliPersonalHistory(options, canonical, "base instructions")
    expect(options.appendSystemPrompt?.match(/Conversation history/g)).toHaveLength(1)
  })

  it("replaces AI SDK runner state with filtered canonical messages", () => {
    const options: SendOptions = {
      provider: "deepseek",
      initialConversation: [{ role: "assistant", content: "STALE_PRIVATE_TOOL_RESULT" }],
    }
    rebuildCliPersonalHistory(options, canonical, undefined)
    expect(options.initialConversation).toEqual(canonical)
    expect(JSON.stringify(options)).not.toContain("STALE_PRIVATE")
  })
})
