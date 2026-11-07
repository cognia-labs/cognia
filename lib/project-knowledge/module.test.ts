import projectKnowledgeModule from "./module"

describe("the project-knowledge manifest", () => {
  it("contributes the workspace retrieval as context, lazily", async () => {
    const { contributions } = await projectKnowledgeModule.context!.load()
    expect(contributions.map((contribution) => contribution.id)).toEqual(["retrieval"])
  })

  it("contributes no tools", () => {
    expect("tools" in projectKnowledgeModule).toBe(false)
  })
})
