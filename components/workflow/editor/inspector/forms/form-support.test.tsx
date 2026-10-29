import enForms from "@/i18n/messages/en/workflows/forms.json"
import zhForms from "@/i18n/messages/zh-CN/workflows/forms.json"
import { PLAN_STATUS_VALUES } from "@/lib/workflow/nodes/params-schemas"
import {
  clampNumberInput,
  INERT_PLAN_REFINEMENT_TRIGGER,
  parseArrayJson,
  parseObjectJson,
  PLAN_REFINEMENT_TRIGGERS,
  PLAN_STATUSES,
} from "./form-support"

describe("workflow form support", () => {
  it("normalizes shared JSON and number inputs", () => {
    expect(parseObjectJson('{"ok":true}')).toEqual({ ok: true })
    expect(parseArrayJson("[1,2]")).toEqual([1, 2])
    expect(clampNumberInput("99", 0, 10, 5)).toBe(10)
  })
})

describe("PLAN_STATUSES", () => {
  it("is the schema's derived status list, so the terminal rejected status is offered", () => {
    expect(PLAN_STATUSES).toBe(PLAN_STATUS_VALUES)
    expect(PLAN_STATUSES).toContain("rejected")
  })

  it.each([
    ["en", enForms],
    ["zh-CN", zhForms],
  ])("%s labels every plan-list status option", (_locale, forms) => {
    const options = forms.planList.status.options as Record<string, string>
    expect(PLAN_STATUSES.filter((status) => !options[status])).toEqual([])
  })
})

describe("PLAN_REFINEMENT_TRIGGERS", () => {
  it("does not offer the inert judge_deviation trigger", () => {
    expect(PLAN_REFINEMENT_TRIGGERS).toEqual(["manual", "step_failure"])
    expect(PLAN_REFINEMENT_TRIGGERS).not.toContain(INERT_PLAN_REFINEMENT_TRIGGER)
  })

  it("keeps a label for every trigger a saved node may still hold", () => {
    const en: Record<string, string> = enForms.planRefine.trigger.options
    const zh: Record<string, string> = zhForms.planRefine.trigger.options
    for (const trigger of [...PLAN_REFINEMENT_TRIGGERS, INERT_PLAN_REFINEMENT_TRIGGER]) {
      expect(en[trigger]).toBeTruthy()
      expect(zh[trigger]).toBeTruthy()
    }
  })
})
