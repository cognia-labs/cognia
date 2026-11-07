import { KNOWLEDGE_TOOL_NAMES } from "./agent-tools"
import knowledgeBaseModule from "./module"

describe("the knowledge-base manifest", () => {
  const declare = knowledgeBaseModule.tools!.declare

  it("declares exactly the tools the family offers, all reads on the default permission path", () => {
    expect(Object.keys(declare).sort()).toEqual([...KNOWLEDGE_TOOL_NAMES].sort())
    for (const name of KNOWLEDGE_TOOL_NAMES)
      expect(declare[name]).toEqual({ consent: "default", effect: "read" })
  })

  it("loads its tool family and context contributions lazily", async () => {
    const { toolFamily } = await knowledgeBaseModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
    const { contributions } = await knowledgeBaseModule.context!.load()
    expect(contributions.map((contribution) => contribution.id)).toEqual(["reader", "retrieval"])
  })
})
