import { AGENT_BUILDER_TOOL_NAMES } from "./agent-tools"
import agentBuilderModule from "./module"

describe("the agent-builder manifest", () => {
  const declare = agentBuilderModule.tools!.declare

  it("declares exactly the tools the family offers", () => {
    expect(Object.keys(declare).sort()).toEqual(Object.values(AGENT_BUILDER_TOOL_NAMES).sort())
  })

  it("allows reading and writing the draft and asks before creating the agent", () => {
    expect(declare[AGENT_BUILDER_TOOL_NAMES.getDraft]).toEqual({
      consent: "allow",
      effect: "read",
      cancellable: false,
    })
    expect(declare[AGENT_BUILDER_TOOL_NAMES.listCatalog]).toEqual({
      consent: "allow",
      effect: "read",
      cancellable: false,
    })
    expect(declare[AGENT_BUILDER_TOOL_NAMES.updateDraft]).toEqual({
      consent: "allow",
      effect: "write",
      cancellable: false,
    })
    expect(declare[AGENT_BUILDER_TOOL_NAMES.createAgent]).toEqual({
      consent: "ask",
      effect: "write",
      cancellable: false,
    })
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await agentBuilderModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
  })
})
