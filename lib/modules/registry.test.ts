import type { HostModuleManifest } from "./manifest-types"
import { activeHostModules, hostModules, isActiveModule } from "./registry"

const manifest = (id: string, stage: HostModuleManifest["stage"]): HostModuleManifest => ({
  id,
  kind: stage === "kernel" ? "kernel" : "module",
  stage,
})

describe("module registry", () => {
  it("keeps an experimental module's contributions away from every shell (Rule 7)", () => {
    expect(isActiveModule({ stage: "experimental" })).toBe(false)
    for (const stage of ["kernel", "stable", "beta", "deprecated"] as const)
      expect(isActiveModule({ stage })).toBe(true)
  })

  it("filters a list to its active modules, keeping their order", () => {
    const modules = [
      manifest("a", "stable"),
      manifest("b", "experimental"),
      manifest("c", "deprecated"),
    ]
    expect(activeHostModules(modules).map((m) => m.id)).toEqual(["a", "c"])
  })

  it("reads the generated registry, which holds the squads pilot", () => {
    const ids = hostModules().map((m) => m.id)
    expect(ids).toContain("squads")
    expect([...ids].sort()).toEqual(ids)
    expect(activeHostModules().map((m) => m.id)).toContain("squads")
  })
})
