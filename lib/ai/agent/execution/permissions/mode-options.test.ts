import enGeneral from "@/i18n/messages/en/settings/general.json"
import zhCnGeneral from "@/i18n/messages/zh-CN/settings/general.json"

import { PERMISSION_MODE_VALUES } from "./mode-options"

describe("PERMISSION_MODE_VALUES", () => {
  it("mirrors the SDK permission-mode union with no duplicates", () => {
    expect(new Set(PERMISSION_MODE_VALUES).size).toBe(PERMISSION_MODE_VALUES.length)
    expect(PERMISSION_MODE_VALUES).toEqual(
      expect.arrayContaining([
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
        "dontAsk",
        "auto",
      ])
    )
  })

  it.each([
    ["en", enGeneral],
    ["zh-CN", zhCnGeneral],
  ])("has a %s label for every permission mode", (_locale, messages) => {
    for (const mode of PERMISSION_MODE_VALUES) {
      expect(messages.permission).toHaveProperty(mode)
    }
  })
})
