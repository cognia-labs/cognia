const executeAgentMock = jest.fn()
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: (...args: unknown[]) => executeAgentMock(...args),
}))
const tryBuildTwinDepsMock = jest.fn()
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: (...args: unknown[]) => tryBuildTwinDepsMock(...args),
}))
const applyTeammateTwinContextMock = jest.fn()
jest.mock("../teammate/twin-context", () => ({
  applyTeammateTwinContext: (...args: unknown[]) => applyTeammateTwinContextMock(...args),
}))
const getTwinMock = jest.fn()
jest.mock("@/lib/db/twins", () => ({
  getTwin: (...args: unknown[]) => getTwinMock(...args),
}))

import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import { port } from "./twin-answer"

const grants: AgentCapabilityGrantV1[] = [
  { schemaVersion: 1, source: { kind: "agent-team" }, instructions: ["cite"] },
]

beforeEach(() => {
  executeAgentMock.mockReset()
  tryBuildTwinDepsMock.mockReset()
  applyTeammateTwinContextMock.mockReset()
  getTwinMock.mockReset()
})

describe("twin-answer port", () => {
  it("answers with the twin's persona and knowledge added to the base instructions", async () => {
    const twinDeps = { vector: true }
    tryBuildTwinDepsMock.mockResolvedValue(twinDeps)
    getTwinMock.mockResolvedValue({ id: "twin-1", name: "Ada" })
    applyTeammateTwinContextMock.mockResolvedValue({ systemPrompt: "base + Ada's persona" })
    executeAgentMock.mockResolvedValue({
      text: "Ada says",
      channel: "sidecar",
      toolsAvailable: true,
    })

    const engine = port.start({
      twinId: "twin-1",
      question: "what now?",
      systemPrompt: "base",
      grants,
    })

    await expect(engine.outcome).resolves.toEqual({ status: "completed", text: "Ada says" })
    expect(applyTeammateTwinContextMock).toHaveBeenCalledWith({
      actorName: "Ada",
      baseSystemPrompt: "base",
      userPrompt: "what now?",
      twinId: "twin-1",
      twinDeps,
      source: "team-delegation",
    })
    expect(executeAgentMock).toHaveBeenCalledWith(
      "what now?",
      expect.objectContaining({ systemPrompt: "base + Ada's persona", capabilityGrants: grants })
    )
  })

  it.each([
    ["the twin runtime is not configured", () => tryBuildTwinDepsMock.mockResolvedValue(undefined)],
    [
      "the twin runtime throws",
      () => tryBuildTwinDepsMock.mockRejectedValue(new Error("no store")),
    ],
  ])("answers on the base instructions when %s", async (_case, arrange) => {
    arrange()
    executeAgentMock.mockResolvedValue({ text: "plain", channel: "text", toolsAvailable: false })
    const engine = port.start({ twinId: "twin-1", question: "q", systemPrompt: "base", grants: [] })
    await expect(engine.outcome).resolves.toEqual({ status: "completed", text: "plain" })
    expect(executeAgentMock).toHaveBeenCalledWith(
      "q",
      expect.objectContaining({ systemPrompt: "base" })
    )
    expect(applyTeammateTwinContextMock).not.toHaveBeenCalled()
  })

  it("never starts an answer stopped while the persona loads", async () => {
    let releaseDeps!: (value: unknown) => void
    tryBuildTwinDepsMock.mockReturnValue(new Promise((resolve) => (releaseDeps = resolve)))
    const engine = port.start({ twinId: "twin-1", question: "q", grants: [] })
    engine.stop("team delegation cancelled")
    releaseDeps(undefined)
    await expect(engine.outcome).resolves.toEqual({
      status: "cancelled",
      error: "team delegation cancelled",
    })
    expect(executeAgentMock).not.toHaveBeenCalled()
  })

  it("aborts an answer that is running", async () => {
    tryBuildTwinDepsMock.mockResolvedValue(undefined)
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    executeAgentMock.mockImplementation(
      (_prompt: string, config: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          config.abortSignal.addEventListener("abort", () => reject(new Error("aborted")))
          started()
        })
    )
    const engine = port.start({ twinId: "twin-1", question: "q", grants: [] })
    await running
    engine.stop("stop")
    await expect(engine.outcome).resolves.toMatchObject({ status: "cancelled" })
  })
})
