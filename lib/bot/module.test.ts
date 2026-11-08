import bot from "./module"

describe("the bot manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(bot).toMatchObject({ id: "bot", kind: "module", stage: "stable" })
    expect(bot.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("provides bot-dispatch, so the connectors, the workflow plane and the pet do not depend on it", async () => {
    expect(bot.provides?.map((provision) => provision.port)).toEqual(["bot-dispatch"])
    const { port } = (await bot.provides![0]!.load()) as { port: object }
    expect(Object.keys(port).sort()).toEqual([
      "cancelConversationDeliveries",
      "connectorInbound",
      "desktopEvent",
      "watchDesktopEventTypes",
      "workflowCompleted",
    ])
    expect(bot.dependsOn).toEqual(expect.arrayContaining(["connectors", "squads", "workflow"]))
  })

  it("owns the Bot tables' companion pulls", async () => {
    expect(bot.syncHandlers?.tables).toEqual([
      "botInstallations",
      "botEventDeliveries",
      "botDefinitions",
    ])
    const { syncHandlers } = await bot.syncHandlers!.load()
    expect(Object.keys(syncHandlers).sort()).toEqual([
      "botDefinitions",
      "botEventDeliveries",
      "botInstallations",
    ])
  })
})
