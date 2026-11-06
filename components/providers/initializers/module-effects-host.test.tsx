import { render, screen } from "@testing-library/react"

import type { UiModuleManifest } from "@/lib/modules/manifest-types"

jest.mock("@cognia/logging", () => ({ loggers: { ui: { error: jest.fn() } } }))

let mockModules: UiModuleManifest[] = []
jest.mock("@/components/modules/registry", () => ({
  activeUiModules: () => mockModules,
}))

import ModuleEffectsHost, {
  __resetModuleEffectsForTests,
  moduleEffectEntries,
} from "./module-effects-host"

function effect(name: string, text: string) {
  return { name, load: async () => ({ default: () => <span>{text}</span> }) }
}

beforeEach(() => {
  __resetModuleEffectsForTests()
  mockModules = [
    { id: "zeta", effects: [effect("watch", "zeta watch")] },
    { id: "alpha", effects: [effect("mount", "alpha mount"), effect("sync", "alpha sync")] },
    { id: "quiet" },
  ] as unknown as UiModuleManifest[]
})

describe("moduleEffectEntries", () => {
  it("orders effects by module id, then manifest order", () => {
    expect(moduleEffectEntries().map((entry) => entry.key)).toEqual([
      "alpha:mount",
      "alpha:sync",
      "zeta:watch",
    ])
  })

  it("loads each effect once", () => {
    const first = moduleEffectEntries()[0]!.Component
    expect(moduleEffectEntries()[0]!.Component).toBe(first)
  })
})

describe("ModuleEffectsHost", () => {
  it("mounts every active module's effects", async () => {
    render(<ModuleEffectsHost />)
    expect(await screen.findByText("alpha mount")).toBeInTheDocument()
    expect(await screen.findByText("alpha sync")).toBeInTheDocument()
    expect(await screen.findByText("zeta watch")).toBeInTheDocument()
  })

  it("mounts nothing when no active module declares an effect", () => {
    mockModules = []
    const { container } = render(<ModuleEffectsHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps the other effects when one throws", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {})
    mockModules = [
      {
        id: "broken",
        effects: [
          {
            name: "boom",
            load: async () => ({
              default: () => {
                throw new Error("boom")
              },
            }),
          },
        ],
      },
      { id: "zeta", effects: [effect("watch", "zeta watch")] },
    ] as unknown as UiModuleManifest[]
    render(<ModuleEffectsHost />)
    expect(await screen.findByText("zeta watch")).toBeInTheDocument()
    jest.restoreAllMocks()
  })
})
