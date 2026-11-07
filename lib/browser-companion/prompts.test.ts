import { BROWSER_COMPANION_AGENT_PROMPT } from "./agent-grant"
import {
  BROWSER_CONTEXT_MULTI_PAGE_PREAMBLE_PROMPT,
  BROWSER_CONTEXT_PREAMBLE_PROMPT,
} from "./build-prompt"
import companionModule from "./module"
import { prompts } from "./prompts"

describe("browser-companion prompts", () => {
  it("lists the agent-mode instruction and both browser-context preambles", () => {
    expect(prompts).toEqual([
      BROWSER_COMPANION_AGENT_PROMPT,
      BROWSER_CONTEXT_PREAMBLE_PROMPT,
      BROWSER_CONTEXT_MULTI_PAGE_PREAMBLE_PROMPT,
    ])
  })

  it("is what the manifest contributes to the prompt catalog", async () => {
    expect((await companionModule.prompts()).prompts).toBe(prompts)
  })
})
