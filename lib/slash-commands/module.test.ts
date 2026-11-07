import { SLASH_COMMAND_TOOL_NAME } from "./agent-tools"
import slashCommands from "./module"

describe("the slash-commands manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(slashCommands).toMatchObject({ id: "slash-commands", kind: "module", stage: "stable" })
    expect(slashCommands.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("declares SlashCommand without a tier, as a write the runner cannot cancel", async () => {
    expect(slashCommands.tools!.declare).toEqual({
      [SLASH_COMMAND_TOOL_NAME]: { consent: "default", effect: "write", cancellable: false },
    })
    const { toolFamily } = await slashCommands.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
  })

  it("contributes the workflow Copilot prompts lazily", async () => {
    const { prompts } = await slashCommands.prompts!()
    expect(prompts.length).toBeGreaterThan(0)
  })
})
