import { getPromptDefinition } from "@/lib/prompts/catalog"

import {
  INTERRUPTED_TURN_RESUME_PROMPT,
  interruptedTurnMayRepeatEffects,
  interruptedTurnResumeMessage,
} from "./interrupted-turn"

describe("interrupted turn continuation", () => {
  it.each(["observed-tool-activity", "ambiguous-side-effects", "unconfirmed-attempt"])(
    "asks for confirmation when the turn was parked for %s",
    (reason) => {
      // The turn may already have acted; continuing can repeat it.
      expect(interruptedTurnMayRepeatEffects(reason)).toBe(true)
    }
  )

  it.each([undefined, "corrupt-canonical-log", "missing_frozen_input", "no-candidates"])(
    "continues without asking when the reason (%s) says nothing about effects",
    (reason) => {
      expect(interruptedTurnMayRepeatEffects(reason)).toBe(false)
    }
  )

  it("tells the agent to carry on rather than start over, and to check before acting", () => {
    const text = interruptedTurnResumeMessage()
    expect(text).toContain("Continue that same task from where it stopped")
    expect(text).toContain("do not repeat steps that already completed")
    expect(text).toContain("check its current state")
  })

  it("is listed in the Prompt Center catalog", () => {
    expect(getPromptDefinition(INTERRUPTED_TURN_RESUME_PROMPT.id)).toBe(
      INTERRUPTED_TURN_RESUME_PROMPT
    )
  })
})
