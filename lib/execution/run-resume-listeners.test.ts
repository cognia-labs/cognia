import { notifyAgentRunResumed, onAgentRunResumed } from "./run-resume-listeners"

describe("run resume listeners", () => {
  it("tells every listener which run resumed, and stops after unsubscribe", async () => {
    const first = jest.fn()
    const second = jest.fn(async () => undefined)
    const offFirst = onAgentRunResumed(first)
    const offSecond = onAgentRunResumed(second)
    await notifyAgentRunResumed("run-1")
    expect(first).toHaveBeenCalledWith("run-1")
    expect(second).toHaveBeenCalledWith("run-1")
    offFirst()
    await notifyAgentRunResumed("run-2")
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenLastCalledWith("run-2")
    offSecond()
  })

  it("rejects with a listener's failure", async () => {
    const off = onAgentRunResumed(async () => {
      throw new Error("inbound resume failed")
    })
    await expect(notifyAgentRunResumed("run-1")).rejects.toThrow("inbound resume failed")
    off()
    await expect(notifyAgentRunResumed("run-1")).resolves.toBeUndefined()
  })
})
