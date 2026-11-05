const mockUnsubscribe = jest.fn()
const mockStartOnlineEvalScheduler = jest.fn(async () => mockUnsubscribe)
jest.mock("@/lib/ai/eval/online/scheduler", () => ({
  startOnlineEvalScheduler: () => mockStartOnlineEvalScheduler(),
}))

import { start } from "./online-eval"

describe("online eval runtime", () => {
  it("starts the drain loop and hands back its unsubscribe as the teardown", async () => {
    const teardown = await start()
    expect(mockStartOnlineEvalScheduler).toHaveBeenCalledTimes(1)
    teardown()
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
  })
})
