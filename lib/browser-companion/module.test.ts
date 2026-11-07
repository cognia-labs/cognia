import companionModule from "./module"

describe("browser-companion module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(companionModule).toMatchObject({
      id: "browser-companion",
      kind: "module",
      stage: "stable",
    })
    expect(companionModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("opens only the socket and the agent runtime to other modules", () => {
    expect(companionModule.api).toEqual([
      "lib/browser-companion/host-dispatch.ts",
      "lib/browser-companion/host-transport.ts",
    ])
  })

  it("contributes its agent-mode grant and its prompts", () => {
    expect(typeof companionModule.capabilityContributions.load).toBe("function")
    expect(typeof companionModule.prompts).toBe("function")
  })
})
