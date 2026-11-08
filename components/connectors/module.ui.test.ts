import connectorsUi from "./module.ui"

jest.mock("@/lib/connectors/notifications/inbound-bridge", () => ({
  installConnectorNotificationBridge: jest.fn(),
}))

describe("connectors UI manifest", () => {
  it("mounts the inbound notification bridge as an effect", async () => {
    expect(connectorsUi.effects.map((effect) => effect.name)).toEqual([
      "inbound-notification-bridge",
    ])
    for (const effect of connectorsUi.effects) {
      const loaded = await effect.load()
      expect(typeof loaded.default).toBe("function")
    }
  })
})
