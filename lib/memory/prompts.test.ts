import { prompts } from "./prompts"

describe("memory prompt contributions", () => {
  it("lists the memory prompts once each, in the catalog's former order", () => {
    expect(prompts.map((prompt) => prompt.id)).toEqual([
      "knowledge.memory.episodic-distill",
      "knowledge.memory.episodic-distill.request",
      "knowledge.memory.extract",
      "knowledge.memory.project-extract",
      "knowledge.memory.consolidate",
      "knowledge.memory.rerank",
    ])
  })
})
