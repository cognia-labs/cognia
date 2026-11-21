import { readFileSync } from "node:fs"
import { join } from "node:path"

import { GOVERNANCE_PROMPTS, PROMPT_IDS } from "./prompts"

describe("governance prompts", () => {
  it("declares one Prompt Center slot per id", () => {
    expect(GOVERNANCE_PROMPTS.map((prompt) => prompt.id).sort()).toEqual(
      Object.values(PROMPT_IDS).sort()
    )
    for (const prompt of GOVERNANCE_PROMPTS) {
      expect(prompt.defaultBody.length).toBeGreaterThan(0)
      if (prompt.maxChars) expect(prompt.defaultBody.length).toBeLessThanOrEqual(prompt.maxChars)
    }
  })

  // Audits run outside any chat and resolve without a session, so a workspace
  // override of their wording could never apply; the tool-call texts resolve
  // for the call's session and keep it.
  it("offers the workspace scope only where a session is resolved", () => {
    const scopes = Object.fromEntries(
      GOVERNANCE_PROMPTS.map((prompt) => [prompt.id, prompt.scopes])
    )
    expect(scopes[PROMPT_IDS.judge]).toEqual(["account"])
    expect(scopes[PROMPT_IDS.conflicts]).toEqual(["account"])
    expect(scopes[PROMPT_IDS.derive]).toEqual(["account"])
    expect(scopes[PROMPT_IDS.block]).toBeUndefined()
    expect(scopes[PROMPT_IDS.remind]).toBeUndefined()
  })

  it("uses every declared variable in its template", () => {
    for (const prompt of GOVERNANCE_PROMPTS) {
      for (const variable of prompt.variables ?? [])
        expect(prompt.defaultBody).toContain(`{{${variable.name}}}`)
    }
  })

  it("keeps the judgment's patterns and keep list from the vendored method", () => {
    const judge = GOVERNANCE_PROMPTS.find((prompt) => prompt.id === PROMPT_IDS.judge)!.defaultBody
    for (const pattern of [
      "pressure-language",
      "thinking-scaffold",
      "fossil",
      "stale-fact",
      "trigger-enumeration",
    ]) {
      expect(judge).toContain(pattern)
    }
    expect(judge).toMatch(/Keep list/)
    expect(judge).toMatch(/data/)
    const vendored = readFileSync(
      join(__dirname, "..", "vendor", "anthropic-prompt-audit", "prompt-audit.md"),
      "utf8"
    )
    expect(vendored).toMatch(/keep/i)
    const notice = readFileSync(
      join(__dirname, "..", "vendor", "anthropic-prompt-audit", "NOTICE.md"),
      "utf8"
    )
    expect(notice).toMatch(/9d630808e4add0a7146de4af9384155d5dee350a/)
  })
})
