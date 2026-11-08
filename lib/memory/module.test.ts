import memoryModule from "./module"

describe("the memory manifest", () => {
  it("contributes its writing and reranking prompts lazily", async () => {
    const { prompts } = await memoryModule.prompts!()
    expect(prompts.map((prompt) => prompt.id)).toContain("knowledge.memory.rerank")
    expect(prompts).toHaveLength(6)
  })

  it("contributes recall and project continuity as context, lazily", async () => {
    const { contributions } = await memoryModule.context!.load()
    expect(contributions.map((contribution) => contribution.id)).toEqual(["recall", "continuity"])
  })

  it("declares project_history_search as a read tool its runner cannot cancel", async () => {
    expect(memoryModule.tools!.declare).toEqual({
      project_history_search: { consent: "default", effect: "read", cancellable: false },
    })
    const { toolFamily } = await memoryModule.tools!.load()
    expect(typeof toolFamily.run).toBe("function")
  })

  it("owns the encrypted memories mirror through its sync handlers", async () => {
    expect(memoryModule.syncHandlers?.tables).toEqual(["memories"])
    const { syncHandlers } = await memoryModule.syncHandlers!.load()
    expect(Object.keys(syncHandlers).sort()).toEqual(["memories"])
  })
})
