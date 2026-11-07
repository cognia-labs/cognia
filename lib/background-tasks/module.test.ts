/** @jest-environment node */
import backgroundTasks from "./module"

describe("the background-tasks manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(backgroundTasks).toMatchObject({
      id: "background-tasks",
      kind: "module",
      stage: "stable",
    })
    expect(backgroundTasks.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("starts job-end delivery on the brain only, saying why a window has no adapter", () => {
    const [runtime, ...rest] = backgroundTasks.runtimes ?? []
    expect(rest).toEqual([])
    expect(runtime).toMatchObject({
      name: "background-job-delivery",
      criticality: "optional",
      adapters: { brain: { module: "./runtime-brain", hosts: ["brain"] } },
    })
    expect(runtime!.adapters.desktop).toBeUndefined()
    expect(runtime!.adapters.mobile).toBeUndefined()
    expect(runtime!.absent?.desktop).toMatch(/BackgroundTaskInitializer/)
    expect(runtime!.absent?.mobile).toMatch(/BackgroundTaskInitializer/)
  })

  it("publishes the delivery path a window's lane registers with", () => {
    expect(backgroundTasks.api).toEqual(
      expect.arrayContaining([
        "lib/background-tasks/result-delivery.ts",
        "lib/background-tasks/job-settlement-consumer.ts",
        "lib/background-tasks/registry-core.ts",
      ])
    )
    expect(backgroundTasks.api).not.toContain("lib/background-tasks/host-delivery-lane.ts")
  })
})
