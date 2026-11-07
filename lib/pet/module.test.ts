import { PET_SHOW_TOOL_NAME, PET_STATUS_TOOL_NAME, PET_TOOL_NAMES } from "./agent-tools"
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
      "lib/db/pet-media-packs.ts",
      "lib/db/pet-sprite-packs.ts",
      "lib/tauri/pet-window.ts",
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

  it("claims its settings key and offers the view other modules read it through", () => {
    expect(petModule.settings).toEqual({ keys: ["petSettings"] })
    expect(petModule.api).toContain("lib/pet/settings.ts")
  })

  it("exports none of the window plumbing the platform owns now", () => {
    // ADR-0250 M2 dependency inversion: the window role, the overlay reveal,
    // the document-visibility hook and the idempotency ledger were generic
    // helpers the shell and other modules had to reach into pet for.
    for (const moved of [
      "lib/pet/window-role.ts",
      "lib/pet/reveal.ts",
      "hooks/pet/use-document-visible.ts",
      "lib/pet/remote/idempotency.ts",
    ]) {
      expect(petModule.api).not.toContain(moved)
    }
  })

  it("lists /pet itself, loading the handler only when it runs", async () => {
    const [command] = petModule.slashCommands ?? []
    expect(command).toMatchObject({ name: "pet", category: "system" })
    expect(command?.argumentOptions).toEqual(
      expect.arrayContaining(["status", "feed", "play", "pet", "sleep", "clean", "treat"])
    )
    const handler = await command!.load()
    expect(typeof handler.run).toBe("function")
  })

  it("declares exactly the agent's pet tools, and asks only before showing the pet", async () => {
    const declare = petModule.tools!.declare
    expect(Object.keys(declare).sort()).toEqual([...PET_TOOL_NAMES].sort())
    for (const [name, declaration] of Object.entries(declare)) {
      expect(declaration.consent).toBe(name === PET_SHOW_TOOL_NAME ? "ask" : "allow")
      expect(declaration.effect).toBe(name === PET_STATUS_TOOL_NAME ? "read" : "write")
      // The runners take no cancel signal.
      expect(declaration.cancellable).toBe(false)
    }
    const { toolFamily } = await petModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
  })
})
