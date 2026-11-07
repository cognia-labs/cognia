import {
  __resetRunStopsForTesting,
  hasRunStop,
  registerRunStop,
  stopRegisteredRun,
} from "./run-stops"

afterEach(() => __resetRunStopsForTesting())

describe("run stops", () => {
  it("stops a registered run with the reason and awaits its stop", async () => {
    let persisted = false
    const stop = jest.fn(async (_reason?: string) => {
      await Promise.resolve()
      persisted = true
    })
    registerRunStop("execution:job:a", stop)
    expect(hasRunStop("execution:job:a")).toBe(true)
    await expect(stopRegisteredRun("execution:job:a", "why")).resolves.toBe(true)
    expect(stop).toHaveBeenCalledWith("why")
    expect(persisted).toBe(true)
  })

  it("answers false for a run with no stop in this process", async () => {
    await expect(stopRegisteredRun("execution:job:none")).resolves.toBe(false)
  })

  it("answers false for a stop that threw, and keeps it for another press", async () => {
    const stop = jest
      .fn()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue(undefined)
    registerRunStop("execution:job:b", stop)
    await expect(stopRegisteredRun("execution:job:b")).resolves.toBe(false)
    await expect(stopRegisteredRun("execution:job:b")).resolves.toBe(true)
  })

  it("unregisters only its own registration", () => {
    const first = registerRunStop("execution:job:c", () => undefined)
    const second = registerRunStop("execution:job:c", () => undefined)
    first()
    expect(hasRunStop("execution:job:c")).toBe(true)
    second()
    expect(hasRunStop("execution:job:c")).toBe(false)
  })

  it("keeps an existing stop when asked to register only if absent", async () => {
    const owner = jest.fn()
    registerRunStop("execution:job:d", owner)
    const unregister = registerRunStop("execution:job:d", jest.fn(), { ifAbsent: true })
    unregister()
    await stopRegisteredRun("execution:job:d")
    expect(owner).toHaveBeenCalled()
  })
})
