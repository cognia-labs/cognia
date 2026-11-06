import { HATCH_PET_SPRITE_PROMPT } from "./hatch-prompt"
import { PET_PROMPTS } from "./llm/persona"
import petModule from "./module"
import { prompts } from "./prompts"
import { PET_SOUL_REQUEST_PROMPT, PET_SOUL_SYSTEM_PROMPT } from "./soul/generate-soul"

describe("pet prompts", () => {
  it("lists every prompt the pet defines, once", () => {
    expect(prompts).toEqual([
      ...Object.values(PET_PROMPTS),
      PET_SOUL_SYSTEM_PROMPT,
      PET_SOUL_REQUEST_PROMPT,
      HATCH_PET_SPRITE_PROMPT,
    ])
    expect(new Set(prompts.map((def) => def.id)).size).toBe(prompts.length)
  })

  it("is what the manifest contributes to the prompt catalog", async () => {
    expect((await petModule.prompts()).prompts).toBe(prompts)
  })
})
