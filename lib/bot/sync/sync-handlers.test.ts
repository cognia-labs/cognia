jest.mock("./bot-installations", () => ({ syncBotInstallations: jest.fn() }))
jest.mock("./bot-event-deliveries", () => ({ syncBotEventDeliveries: jest.fn() }))
jest.mock("./bot-definitions", () => ({ syncBotDefinitions: jest.fn() }))

import { syncBotDefinitions } from "./bot-definitions"
import { syncBotEventDeliveries } from "./bot-event-deliveries"
import { syncBotInstallations } from "./bot-installations"
import { syncHandlers } from "./sync-handlers"

describe("bot sync handlers", () => {
  it("contributes the three Bot table pulls and leaves reading to the host", () => {
    expect(syncHandlers).toEqual({
      botInstallations: { pull: syncBotInstallations },
      botEventDeliveries: { pull: syncBotEventDeliveries },
      botDefinitions: { pull: syncBotDefinitions },
    })
  })
})
