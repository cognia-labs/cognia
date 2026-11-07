import memoryModule from "./module"

describe("the memory manifest", () => {
  it("contributes its writing and reranking prompts lazily", async () => {
    const { prompts } = await memoryModule.prompts!()
    expect(prompts.map((prompt) => prompt.id)).toContain("knowledge.memory.rerank")
    expect(prompts).toHaveLength(6)
  })

  it("contributes recall and project continuity as context, lazily, and no tools", async () => {
    const { contributions } = await memoryModule.context!.load()
    expect(contributions.map((contribution) => contribution.id)).toEqual(["recall", "continuity"])
    expect("tools" in memoryModule).toBe(false)
  })
})
