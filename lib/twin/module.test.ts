import twinModule from "./module"

describe("the twin manifest", () => {
  it("contributes its distillation, reranking and template prompts lazily", async () => {
    const { prompts } = await twinModule.prompts!()
    expect(prompts).toHaveLength(15)
  })

  it("asks for OCR, memory namespaces and eval benchmarks, coping without each", () => {
    expect(twinModule.requires).toEqual(["ocr?", "memory-namespaces?", "eval-benchmarks?"])
  })
})
