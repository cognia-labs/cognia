import { EXECUTION_ENHANCE_PROMPT } from "./from-execution/enhance"
import { A2UI_CREATE_APP_PROMPT, A2UI_EDIT_APP_PROMPT } from "./generate-prompts"
import { A2UI_PROTOCOL_PROMPT } from "./prompts"
import { prompts } from "./prompts-contribution"

describe("a2ui prompt contribution", () => {
  it("lists the protocol, app generation and execution-page prompts", () => {
    expect(prompts).toEqual([
      A2UI_PROTOCOL_PROMPT,
      A2UI_CREATE_APP_PROMPT,
      A2UI_EDIT_APP_PROMPT,
      EXECUTION_ENHANCE_PROMPT,
    ])
  })
})
