import { MOBILE_QUICK_ACTION_CATALOG } from "./mobile-home"
import { DEFAULT_GLANCE_MOBILE_SHORTCUTS } from "@/lib/glance/mobile-layout"
import { getMobileQuickActionCatalog } from "@/lib/shell/mobile-home-nav"
import enMessages from "@/i18n/messages/en.json"
import zhCnMessages from "@/i18n/messages/zh-CN.json"

/**
 * The shortcut labels are looked up DYNAMICALLY: the quick module and the
 * shortcut editor render `tActions(item.i18nKey)` over the catalog.
 * `lint:i18n` only follows literal keys, so the gate does not check them, and
 * every suite that renders those components stubs `useTranslations` to echo
 * its argument. A missing key would therefore ship as a `MISSING_MESSAGE` on
 * screen with every gate green.
 *
 * This is the catalogue-coverage guard that closes that hole, modelled on
 * `types/shell/sidebar.test.ts`, which does the same job for the desktop rail.
 */
describe("mobile home catalog", () => {
  it("has unique quick-action ids", () => {
    const ids = MOBILE_QUICK_ACTION_CATALOG.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("gives every route-kind action a route, and no other kind one", () => {
    for (const item of MOBILE_QUICK_ACTION_CATALOG) {
      if (item.kind === "route") expect(item.route?.startsWith("/")).toBe(true)
      else expect(item.route).toBeUndefined()
    }
  })

  it("defaults to actions that exist in the catalog", () => {
    const ids = new Set(getMobileQuickActionCatalog().map((m) => m.id))
    for (const id of DEFAULT_GLANCE_MOBILE_SHORTCUTS) expect(ids.has(id)).toBe(true)
  })

  it.each([
    ["en", enMessages],
    ["zh-CN", zhCnMessages],
  ])("defines every dynamic quick-action label in %s", (_locale, messages) => {
    const labels = messages.mobile.home.actions as Record<string, unknown>
    for (const item of MOBILE_QUICK_ACTION_CATALOG) {
      expect(labels[item.i18nKey]).toEqual(expect.any(String))
    }
  })
})
