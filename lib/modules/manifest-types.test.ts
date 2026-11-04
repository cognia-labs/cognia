import type {
  HostModuleManifest,
  ModuleAcceptance,
  ModuleHost,
  ModuleStage,
  UiModuleManifest,
} from "./manifest-types"

// The schema is types only; these cases pin it through the typecheck, and the
// runtime assertions keep the suite honest about what each case builds.

describe("manifest-types", () => {
  it("accepts a full host manifest", () => {
    const manifest: HostModuleManifest = {
      id: "pet",
      kind: "module",
      stage: "stable",
      owner: "@MaxQian888",
      acceptance: { evidence: "docs/evidence/pet.md", realSmoke: "passed:2026-11-05" },
      owns: ["lib/db/pet-models.ts"],
      dependsOn: ["chat"],
      api: ["lib/pet/api/status.ts"],
      provides: [{ port: "glance.slice", load: () => import("./define") }],
      requires: ["ocr?"],
      runtimes: [
        {
          name: "pet-proactive",
          criticality: "optional",
          adapters: { desktop: () => import("./define") },
        },
      ],
      settings: { keys: ["petEnabled"] },
      tables: ["petModels"],
      tools: { load: () => import("./define") },
      capabilityContributions: { load: () => import("./define") },
      taskExecutors: { load: () => import("./define") },
      builtinSkills: { load: () => import("./define") },
      pluginApi: { namespaces: ["pet"], load: () => import("./define") },
      workflowNodes: { load: () => import("./define") },
      searchProviders: () => import("./define"),
      slashCommands: () => import("./define"),
      prompts: () => import("./define"),
      flags: { proactiveChat: { default: false } },
      messages: "pet",
    }
    expect(manifest.runtimes?.[0]?.adapters.desktop).toBeInstanceOf(Function)
  })

  it("accepts a UI manifest", () => {
    const manifest: UiModuleManifest = {
      id: "pet",
      settingsSections: [
        {
          id: "pet",
          group: "appearance",
          icon: "paw-print",
          requires: ["desktop"],
          load: () => import("./define"),
        },
      ],
      nav: [{ route: "/pet", icon: "paw-print" }],
      effects: [{ name: "pet-window-title", load: () => import("./define") }],
    }
    expect(manifest.settingsSections).toHaveLength(1)
  })

  it("keeps acceptance to pending or a dated pass", () => {
    const pending: ModuleAcceptance = { realSmoke: "pending" }
    const passed: ModuleAcceptance = { realSmoke: "passed:2026-11-05" }
    // @ts-expect-error -- a bare "passed" carries no date.
    const undated: ModuleAcceptance = { realSmoke: "passed" }
    expect([pending, passed, undated].map((a) => a.realSmoke)).toEqual([
      "pending",
      "passed:2026-11-05",
      "passed",
    ])
  })

  it("names the hosts and stages the gate and generator use", () => {
    const hosts: ModuleHost[] = ["brain", "desktop", "mobile"]
    const stages: ModuleStage[] = ["kernel", "stable", "beta", "experimental", "deprecated"]
    expect(hosts).toHaveLength(3)
    expect(stages).toHaveLength(5)
  })
})
