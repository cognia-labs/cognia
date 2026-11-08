import type {
  HostModuleManifest,
  ModuleAcceptance,
  ModuleHost,
  ModuleSettingsSection,
  ModuleSlashCommand,
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
      provides: [{ port: "glance.slice", load: async () => ({ port: {} }) }],
      requires: ["ocr?"],
      runtimes: [
        {
          name: "pet-proactive",
          criticality: "optional",
          boot: "knowledge-agents",
          adapters: {
            brain: { module: "./runtime/brain", hosts: ["brain", "person-brain"] },
            desktop: "./runtime/desktop",
          },
          absent: { mobile: "The phone has no pet window." },
        },
      ],
      settings: { keys: ["petSettings"] },
      tables: ["petModels"],
      tools: {
        declare: { pet_feed: { consent: "allow", effect: "write", cancellable: false } },
        load: async () => ({
          toolFamily: { surface: () => null, run: async () => ({ ok: true }) },
        }),
      },
      capabilityContributions: { load: async () => ({ contributions: [] }) },
      taskExecutors: { load: () => import("./define") },
      builtinSkills: { load: async () => ({ builtInSkillFamilies: [] }) },
      pluginApi: { namespaces: ["pet"], load: () => import("./define") },
      workflowNodes: { load: async () => ({ workflowNodeKinds: [] }) },
      searchProviders: async () => ({ searchProviders: [] }),
      slashCommands: [
        {
          name: "pet",
          description: "Check on your pet.",
          category: "system",
          argumentHint: "<status | feed>",
          argumentOptions: ["status", "feed"],
          load: async () => ({ run: () => undefined }),
        },
      ],
      nav: [
        {
          id: "pet",
          route: "/pet",
          label: "pet.nav.label",
          aliases: "pet.nav.aliases",
          icon: "PawPrint",
          spotIcon: "pet",
          group: "feature",
          category: "agents",
          after: "goals",
          goMenuAfter: "goals",
          fullViewport: true,
          mobileShortcut: { after: "twin" },
        },
      ],
      prompts: async () => ({ prompts: [] }),
      flags: { proactiveChat: { default: false } },
      messages: "pet",
    }
    // Adapters are specifiers; the generator writes each host's lazy import.
    expect(manifest.runtimes?.[0]?.adapters.desktop).toBe("./runtime/desktop")
  })

  it("accepts a UI manifest", () => {
    const manifest: UiModuleManifest = {
      id: "pet",
      settingsSections: [
        {
          id: "pet",
          group: "appearance",
          icon: "PawPrint",
          label: "pet.settingsSection.label",
          description: "pet.settingsSection.description",
          after: "appearance",
          requires: ["keyring"],
          profiles: ["desktop"],
          layout: "fill",
          hostOperation: "pet_get",
          keywords: ["pet", "宠物"],
          load: async () => ({ default: () => null }),
        },
      ],
      effects: [{ name: "pet-window-title", load: async () => ({ default: () => null }) }],
    }
    expect(manifest.settingsSections).toHaveLength(1)
  })

  it("loads a slash command's handler and a section's component, nothing else", () => {
    const command: ModuleSlashCommand = {
      name: "pet",
      description: "Check on your pet.",
      // @ts-expect-error -- `load` brings `{ run }`, not a bare function.
      load: async () => () => undefined,
    }
    const section: ModuleSettingsSection = {
      id: "pet",
      group: "appearance",
      icon: "PawPrint",
      label: "pet.settingsSection.label",
      description: "pet.settingsSection.description",
      // @ts-expect-error -- a host profile, not a capability.
      requires: ["desktop"],
      load: async () => ({ default: () => null }),
    }
    expect([command.name, section.id]).toEqual(["pet", "pet"])
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
