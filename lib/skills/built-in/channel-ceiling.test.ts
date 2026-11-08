import {
  adapterAllowsBuiltInSkill,
  matchesSkillSelector,
  resolveRequireHitlForWrites,
} from "./channel-ceiling"

describe("built-in skill channel ceiling", () => {
  it("matches exact ids and family wildcards", () => {
    expect(
      matchesSkillSelector(
        "lark.calendar.list_events",
        "lark.calendar",
        "lark.calendar.list_events"
      )
    ).toBe(true)
    expect(
      matchesSkillSelector("lark.calendar.list_events", "lark.calendar", "lark.calendar.*")
    ).toBe(true)
    expect(matchesSkillSelector("lark.calendar.list_events", "lark.calendar", "lark.*")).toBe(true)
    expect(matchesSkillSelector("lark.calendar.list_events", "lark.calendar", "lark.doc.*")).toBe(
      false
    )
    expect(
      matchesSkillSelector("lark.calendar.list_events", "lark.calendar", "lark.calendar")
    ).toBe(false)
  })

  it("treats an undefined skill ceiling as unrestricted and supports family wildcards", () => {
    const skill = { id: "lark.calendar.list_events", family: "lark.calendar" }
    expect(adapterAllowsBuiltInSkill(undefined, skill)).toBe(true)
    expect(adapterAllowsBuiltInSkill({ builtInSkillCeiling: [] }, skill)).toBe(false)
    expect(adapterAllowsBuiltInSkill({ builtInSkillCeiling: ["lark.calendar.*"] }, skill)).toBe(
      true
    )
  })

  it("resolves write HITL conversation then adapter then secure default", () => {
    expect(resolveRequireHitlForWrites(undefined, undefined)).toBe(true)
    expect(resolveRequireHitlForWrites({ requireHitlForWrites: false }, undefined)).toBe(false)
    expect(
      resolveRequireHitlForWrites({ requireHitlForWrites: false }, { requireHitlForWrites: true })
    ).toBe(true)
  })
})
