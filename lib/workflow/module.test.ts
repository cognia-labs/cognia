import workflow from "./module"

describe("the workflow manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(workflow).toMatchObject({ id: "workflow", kind: "module", stage: "stable" })
    expect(workflow.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("asks for OCR and, optionally, knowledge-base revision pinning through ports", () => {
    expect(workflow.requires).toEqual(["ocr", "knowledge-base-revisions?"])
  })

  it("contributes its prompts lazily", async () => {
    const { prompts } = await workflow.prompts!()
    expect(prompts.length).toBeGreaterThan(0)
  })
})
