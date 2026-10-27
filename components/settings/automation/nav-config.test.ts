import {
  AUTOMATION_NAV_GROUPS,
  AUTOMATION_NAV_ITEMS,
  AUTOMATION_PANEL_PARAM,
  DEFAULT_AUTOMATION_PANEL,
  resolveAutomationPanel,
} from "./nav-config"

describe("automation nav config", () => {
  it("groups the panels by what the user came to do", () => {
    expect(AUTOMATION_NAV_GROUPS.map((group) => [group.id, group.items.map((i) => i.id)])).toEqual([
      ["statusGroup", ["overview"]],
      ["configGroup", ["permissions", "accessRules", "behavior"]],
      ["monitorGroup", ["audit"]],
      ["toolsGroup", ["inspector", "diagnostics"]],
    ])
  })

  it("keeps panel ids unique across groups", () => {
    const ids = AUTOMATION_NAV_ITEMS.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("keeps the tab strip's query param so bookmarks still resolve", () => {
    expect(AUTOMATION_PANEL_PARAM).toBe("autoTab")
  })

  it("resolves every current panel id to itself", () => {
    for (const item of AUTOMATION_NAV_ITEMS) {
      expect(resolveAutomationPanel(item.id)).toBe(item.id)
    }
  })

  it("lands the retired tab ids somewhere meaningful", () => {
    expect(resolveAutomationPanel("whitelist")).toBe("accessRules")
    // The sandbox registry moved to Devices; the overview links there.
    expect(resolveAutomationPanel("sandboxes")).toBe("overview")
  })

  it("falls back to the overview for anything unknown", () => {
    expect(DEFAULT_AUTOMATION_PANEL).toBe("overview")
    expect(resolveAutomationPanel(null)).toBe("overview")
    expect(resolveAutomationPanel(undefined)).toBe("overview")
    expect(resolveAutomationPanel("")).toBe("overview")
    expect(resolveAutomationPanel("constructor")).toBe("overview")
    expect(resolveAutomationPanel("nope")).toBe("overview")
  })
})
