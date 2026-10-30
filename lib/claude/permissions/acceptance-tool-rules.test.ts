import { buildAcceptanceToolRuleset } from "./acceptance-tool-rules"

test("allows only the two evidence tools under both provider name forms", () => {
  expect(buildAcceptanceToolRuleset()).toEqual({
    acceptance_checkpoint: "allow",
    acceptance_complete: "allow",
    "mcp__cognia-plugin-tools__acceptance_checkpoint": "allow",
    "mcp__cognia-plugin-tools__acceptance_complete": "allow",
  })
})
