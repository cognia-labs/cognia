jest.mock("./conversation-overrides", () => ({ syncConversationOverrides: jest.fn() }))

import { syncConversationOverrides } from "./conversation-overrides"
import { syncHandlers } from "./sync-handlers"

describe("connectors sync handlers", () => {
  it("contributes the conversation-override pull and leaves reading to the host", () => {
    expect(syncHandlers).toEqual({ conversationOverrides: { pull: syncConversationOverrides } })
  })
})
