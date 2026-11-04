import { defineHostModule, defineUiModule } from "./define"

describe("defineHostModule", () => {
  it("returns the manifest unchanged, keeping its literal types", () => {
    const manifest = {
      id: "pet",
      kind: "module",
      stage: "stable",
      dependsOn: ["chat"],
      runtimes: [
        {
          name: "pet-proactive",
          criticality: "optional",
          adapters: { desktop: () => import("./manifest-types") },
        },
      ],
    } as const
    const declared = defineHostModule(manifest)
    expect(declared).toBe(manifest)
    // `const` generics keep the literal, so a generated registry can key by it.
    const id: "pet" = declared.id
    expect(id).toBe("pet")
  })

  it("rejects a manifest outside the schema at compile time", () => {
    // @ts-expect-error -- `kind` is "kernel" or "module", never "plugin".
    defineHostModule({ id: "x", kind: "plugin", stage: "stable" })
    // @ts-expect-error -- `stage` is required.
    defineHostModule({ id: "x", kind: "module" })
    defineHostModule({
      id: "x",
      kind: "module",
      stage: "beta",
      runtimes: [
        {
          name: "r",
          criticality: "optional",
          adapters: {
            // @ts-expect-error -- adapters exist only for the hosts registries are generated for.
            web: () => import("./define"),
          },
        },
      ],
    })
    expect(true).toBe(true)
  })
})

describe("defineUiModule", () => {
  it("returns the manifest unchanged", () => {
    const manifest = {
      id: "pet",
      nav: [{ route: "/pet", icon: "paw-print" }],
      effects: [{ name: "pet-window-title", load: () => import("./define") }],
    }
    expect(defineUiModule(manifest)).toBe(manifest)
  })

  it("rejects a slot that is not a canonical extension point at compile time", () => {
    // @ts-expect-error -- slot names come from CANONICAL_EXTENSION_POINTS.
    defineUiModule({ id: "x", slots: { "not.a.real.point": () => import("./define") } })
    expect(true).toBe(true)
  })
})
