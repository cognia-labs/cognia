import type { HostModuleManifest, UiModuleManifest } from "@/lib/modules/manifest-types"

import { activeUiModules, dormantUiModules } from "./registry"

const host = (id: string, stage: HostModuleManifest["stage"]): HostModuleManifest => ({
  id,
  kind: "module",
  stage,
})
const ui = (id: string): UiModuleManifest => ({ id })

describe("UI module registry", () => {
  it("splits UI manifests by their host module's stage", () => {
    const hosts = [host("live", "stable"), host("lab", "experimental")]
    const uis = [ui("live"), ui("lab")]
    expect(activeUiModules(uis, hosts).map((m) => m.id)).toEqual(["live"])
    expect(dormantUiModules(uis, hosts).map((m) => m.id)).toEqual(["lab"])
  })

  it("refuses a UI manifest without a host manifest instead of guessing", () => {
    expect(() => activeUiModules([ui("orphan")], [])).toThrow(
      "components/orphan/module.ui.ts has no host manifest lib/orphan/module.ts"
    )
  })

  it("reads the generated registries, where squads is active", () => {
    expect(activeUiModules().map((m) => m.id)).toContain("squads")
    expect(dormantUiModules().map((m) => m.id)).not.toContain("squads")
  })
})
