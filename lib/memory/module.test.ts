import memoryModule from "./module"

describe("the memory manifest", () => {
  it("contributes its writing and reranking prompts lazily", async () => {
    const { prompts } = await memoryModule.prompts!()
    expect(prompts.map((prompt) => prompt.id)).toContain("knowledge.memory.rerank")
    expect(prompts).toHaveLength(6)
  })

  it("contributes no context or tools yet", () => {
    expect("context" in memoryModule).toBe(false)
    expect("tools" in memoryModule).toBe(false)
  })
})
