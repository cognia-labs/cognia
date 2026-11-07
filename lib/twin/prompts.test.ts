import { prompts } from "./prompts"

describe("twin prompt contributions", () => {
  it("lists the twin prompts once each, in the catalog's former order", () => {
    expect(prompts.map((prompt) => prompt.id)).toEqual([
      "twin.distill.style",
      "twin.distill.playbook",
      "twin.distill.knowledge",
      "twin.distill.synthesizer",
      "twin.distill.evaluator",
      "twin.distill.entity-merge",
      "twin.runtime.rerank",
      "twin.runtime.rerank-request",
      "twin.runtime.system-template.identity",
      "twin.runtime.system-template.voice",
      "twin.runtime.system-template.entities",
      "twin.runtime.system-template.playbooks",
      "twin.runtime.system-template.decisions",
      "twin.runtime.system-template.retrieved",
      "twin.runtime.system-template.style",
    ])
  })
})
