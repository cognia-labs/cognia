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

  it("has no page or rail destination: the console is its settings section", () => {
    // ADR-0058 D16: Settings → Pet (`components/pet/module.ui.ts`).
    expect("nav" in petModule).toBe(false)
  })

  it("offers the console's href to the modules that open it", () => {
    expect(petModule.api).toContain("lib/pet/console-tabs.ts")
  })
})
