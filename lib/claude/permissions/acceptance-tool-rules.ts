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

/** The proposal only reads deliveries and a price; it cannot spend, so it never asks. */
export function buildAcceptanceProposalToolRuleset(): Ruleset {
  return {
    propose_acceptance: "allow",
    "mcp__cognia-plugin-tools__propose_acceptance": "allow",
  }
}
