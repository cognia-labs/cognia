import {
  __resetChatMiddlewareFlagForTesting,
  isChatMiddlewareExecutionEnabled,
  setChatMiddlewareExecutionEnabled,
} from "./feature-flag"

describe("chat middleware execution flag", () => {
  afterEach(() => __resetChatMiddlewareFlagForTesting())

  it("ships off", () => {
    expect(isChatMiddlewareExecutionEnabled()).toBe(false)
  })

  it("follows the last toggle", () => {
    setChatMiddlewareExecutionEnabled(true)
    expect(isChatMiddlewareExecutionEnabled()).toBe(true)
    setChatMiddlewareExecutionEnabled(false)
    expect(isChatMiddlewareExecutionEnabled()).toBe(false)
  })

  it("resets to the shipped default", () => {
    setChatMiddlewareExecutionEnabled(true)
    __resetChatMiddlewareFlagForTesting()
    expect(isChatMiddlewareExecutionEnabled()).toBe(false)
  })
})
