/** Evidence recording is allowed only within the human-started child delegation. */
import type { Ruleset } from "./ruleset"

export function buildAcceptanceToolRuleset(): Ruleset {
  const rules: Ruleset = {}
  for (const name of ["acceptance_checkpoint", "acceptance_complete"]) {
    rules[name] = "allow"
    rules[`mcp__cognia-plugin-tools__${name}`] = "allow"
  }
  return rules
}
