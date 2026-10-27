import {
  PET_CONSOLE_DESTINATIONS,
  PET_CONSOLE_LEGACY_TABS,
  PET_CONSOLE_SECTIONS,
  PET_CONSOLE_TABS,
  isPetConsoleSection,
  isPetConsoleTab,
  petConsoleHref,
  petConsoleSegmentSection,
  petConsoleTargetFromParams,
  resolvePetConsoleTarget,
} from "./console-tabs"

describe("console-tabs", () => {
  it("accepts every destination and every legacy id", () => {
    for (const tab of PET_CONSOLE_TABS) expect(isPetConsoleTab(tab)).toBe(true)
    for (const legacy of Object.keys(PET_CONSOLE_LEGACY_TABS)) {
      expect(isPetConsoleTab(legacy)).toBe(true)
    }
  })

  it("rejects unknown values and non-strings", () => {
    expect(isPetConsoleTab("settings")).toBe(false)
    expect(isPetConsoleTab("")).toBe(false)
    expect(isPetConsoleTab(42)).toBe(false)
    expect(isPetConsoleTab(null)).toBe(false)
    expect(isPetConsoleTab(undefined)).toBe(false)
  })

  it("has five places plus the plugins tab", () => {
    expect(PET_CONSOLE_SECTIONS).toEqual([
      "home",
      "chat",
      "shop",
      "collection",
      "activity",
      "plugins",
    ])
    expect(isPetConsoleSection("activity")).toBe(true)
    expect(isPetConsoleSection("dex")).toBe(false)
  })

  it("resolves every destination to a place the console has", () => {
    for (const destination of PET_CONSOLE_DESTINATIONS) {
      const target = resolvePetConsoleTarget(destination)
      if (target.view === "main") expect(PET_CONSOLE_SECTIONS).toContain(target.section)
    }
  })

  it("opens segments inside their section", () => {
    expect(resolvePetConsoleTarget("dex")).toEqual({
      view: "main",
      section: "collection",
      segment: "dex",
    })
    expect(resolvePetConsoleTarget("achievements")).toEqual({
      view: "main",
      section: "collection",
      segment: "achievements",
    })
    expect(resolvePetConsoleTarget("journal")).toEqual({
      view: "main",
      section: "activity",
      segment: "journal",
    })
    expect(resolvePetConsoleTarget("insights")).toEqual({
      view: "main",
      section: "activity",
      segment: "insights",
    })
    expect(petConsoleSegmentSection("insights")).toBe("activity")
    expect(petConsoleSegmentSection("dex")).toBe("collection")
  })

  it("maps the earlier layout's ids onto the new places", () => {
    expect(resolvePetConsoleTarget("nurture")).toEqual({ view: "main", section: "home" })
    expect(resolvePetConsoleTarget("customize")).toEqual({ view: "appearance" })
    expect(resolvePetConsoleTarget("binding")).toEqual({ view: "appearance", focus: "binding" })
  })

  it("reads the sub-page address and the tab parameter", () => {
    expect(petConsoleTargetFromParams(null, "appearance")).toEqual({ view: "appearance" })
    expect(petConsoleTargetFromParams("binding", "appearance")).toEqual({
      view: "appearance",
      focus: "binding",
    })
    expect(petConsoleTargetFromParams("shop", null)).toEqual({ view: "main", section: "shop" })
    expect(petConsoleTargetFromParams("nope", null)).toBeUndefined()
    expect(petConsoleTargetFromParams(null, null)).toBeUndefined()
  })

  it("writes canonical hrefs that read back to the same place", () => {
    expect(petConsoleHref()).toBe("/pet")
    expect(petConsoleHref("nurture")).toBe("/pet")
    expect(petConsoleHref("customize")).toBe("/pet?view=appearance")
    expect(petConsoleHref("binding")).toBe("/pet?view=appearance&tab=binding")
    expect(petConsoleHref("insights")).toBe("/pet?tab=insights")
    for (const tab of PET_CONSOLE_TABS) {
      const url = new URL(petConsoleHref(tab), "https://app.test")
      const target =
        petConsoleTargetFromParams(url.searchParams.get("tab"), url.searchParams.get("view")) ??
        resolvePetConsoleTarget("home")
      expect(target).toEqual(resolvePetConsoleTarget(tab))
    }
  })
})
