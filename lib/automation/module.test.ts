import automationModule from "./module"
import { ACCEPTANCE_TOOL_NAMES, PROPOSE_ACCEPTANCE_TOOL_NAME } from "./agent-tools"

describe("the automation manifest", () => {
  const declare = automationModule.tools!.declare

  it("declares the acceptance evidence tools and the proposal", () => {
    expect(Object.keys(declare).sort()).toEqual(
      [...ACCEPTANCE_TOOL_NAMES, PROPOSE_ACCEPTANCE_TOOL_NAME].sort()
    )
  })

  it("allows all three; only the evidence tools write, and none can be cancelled", () => {
    for (const [name, declaration] of Object.entries(declare)) {
      expect(declaration.consent).toBe("allow")
      expect(declaration.effect).toBe(name === PROPOSE_ACCEPTANCE_TOOL_NAME ? "read" : "write")
      expect(declaration.cancellable).toBe(false)
    }
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await automationModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
  })
})
