import { render, screen } from "@testing-library/react"

import type { UiModuleManifest } from "@/lib/modules/manifest-types"

jest.mock("@cognia/logging", () => ({ loggers: { ui: { error: jest.fn() } } }))

import { activeUiModules } from "./registry"
import { ModuleSlotContributions, __resetModuleSlotsForTests, moduleSlotEntries } from "./slots"

function component(text: string) {
  return async () => ({
    default: ({ formFactor, context }: { formFactor: string; context?: object }) => (
      <span>
        {text} {formFactor} {JSON.stringify(context ?? {})}
      </span>
    ),
  })
}

const zeta = {
  id: "zeta",
  slots: { "pet.console.tab": component("zeta") },
} as unknown as UiModuleManifest
const alpha = {
  id: "alpha",
  slots: { "pet.console.tab": component("alpha"), "pet.panel.actions": component("actions") },
} as unknown as UiModuleManifest
const silent = { id: "silent" } as unknown as UiModuleManifest

beforeEach(() => __resetModuleSlotsForTests())

describe("moduleSlotEntries", () => {
  it("lists a point's contributors in module id order, and no one else", () => {
    const entries = moduleSlotEntries("pet.console.tab", [zeta, silent, alpha])
    expect(entries.map((entry) => entry.module)).toEqual(["alpha", "zeta"])
    expect(moduleSlotEntries("pet.panel.actions", [zeta, alpha]).map((e) => e.module)).toEqual([
      "alpha",
    ])
    expect(moduleSlotEntries("chat.input.above", [zeta, alpha])).toEqual([])
  })

  it("loads each contribution once, however often the host renders", () => {
    const first = moduleSlotEntries("pet.console.tab", [alpha])[0]!.Component
    const second = moduleSlotEntries("pet.console.tab", [alpha])[0]!.Component
    expect(second).toBe(first)
  })

  it("has the radar fill the pet console's Extensions tab from the generated registry", () => {
    expect(moduleSlotEntries("pet.console.tab").map((entry) => entry.module)).toContain("radar")
  })

  it("reads the active modules by default, so an experimental module fills nothing", () => {
    const active = new Set(activeUiModules().map((manifest) => manifest.id))
    for (const entry of moduleSlotEntries("pet.console.tab"))
      expect(active.has(entry.module)).toBe(true)
  })
})

describe("ModuleSlotContributions", () => {
  it("renders each contribution lazily with the host's form factor and context", async () => {
    const entries = moduleSlotEntries("pet.console.tab", [zeta, alpha])
    const { container } = render(
      <ModuleSlotContributions entries={entries} formFactor="panel" context={{ level: 3 }} />
    )
    expect(await screen.findByText('alpha panel {"level":3}')).toBeInTheDocument()
    expect(await screen.findByText('zeta panel {"level":3}')).toBeInTheDocument()
    const wrappers = [...container.querySelectorAll("[data-module-slot]")]
    expect(wrappers.map((node) => node.getAttribute("data-module-slot"))).toEqual(["alpha", "zeta"])
  })

  it("keeps the other contributions when one fails to load", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {})
    const broken = {
      id: "broken",
      slots: {
        "pet.console.tab": () => Promise.reject(new Error("chunk failed")),
      },
    } as unknown as UiModuleManifest
    render(
      <ModuleSlotContributions
        entries={moduleSlotEntries("pet.console.tab", [broken, zeta])}
        formFactor="panel"
      />
    )
    expect(await screen.findByText("zeta panel {}")).toBeInTheDocument()
    jest.restoreAllMocks()
  })
})
