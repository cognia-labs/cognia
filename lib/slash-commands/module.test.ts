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

  it("contributes no prompts: the workflow Copilot turns are the workflow module's", () => {
    expect("prompts" in slashCommands).toBe(false)
  })
})
