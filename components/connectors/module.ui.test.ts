import connectorsUi from "./module.ui"

jest.mock("@/lib/connectors/notifications/inbound-bridge", () => ({
  installConnectorNotificationBridge: jest.fn(),
}))
jest.mock("./connector-deep-link-router", () => ({ __esModule: true, default: () => null }))

describe("connectors UI manifest", () => {
  it("mounts the inbound notification bridge and the deep-link router as effects", async () => {
    expect(connectorsUi.effects.map((effect) => effect.name)).toEqual([
      "inbound-notification-bridge",
      "deep-link-router",
    ])
    for (const effect of connectorsUi.effects) {
      const loaded = await effect.load()
      expect(typeof loaded.default).toBe("function")
    }
  })
})
