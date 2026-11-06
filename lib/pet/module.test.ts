import petModule from "./module"

describe("pet module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(petModule).toMatchObject({ id: "pet", kind: "module", stage: "stable" })
    expect(petModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("claims the window routes, the settings section and its own data accessor", () => {
    expect(petModule.owns).toEqual([
      "app/pet-overlay/",
      "app/pet-popup/",
      "components/settings/pet/",
      "lib/db/pet-conversation.ts",
    ])
  })

  it("claims every live pet table, and only those", () => {
    expect(petModule.tables).toHaveLength(10)
    for (const table of petModule.tables ?? []) expect(table).toMatch(/^pet[A-Z]/)
    // Dropped in the schema (`petConversation: null`), so nobody claims it.
    expect(petModule.tables).not.toContain("petConversation")
  })

  it("no longer depends on the radar, which fills the console's Extensions tab instead", () => {
    expect(petModule.dependsOn).not.toContain("radar")
    expect(petModule.dependsOn).toContain("plugin")
  })

  it("puts the Pet destination after Goals, gated on the host operation", () => {
    expect(petModule.nav).toEqual([
      {
        id: "pet",
        route: "/pet",
        label: "pet.nav.label",
        icon: "PawPrint",
        spotIcon: "pet",
        group: "feature",
        category: "agents",
        after: "goals",
        hostOperationGated: true,
      },
    ])
  })
})
