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
    const [runtime] = backgroundTasks.runtimes ?? []
    expect(runtime).toMatchObject({
      name: "background-job-delivery",
      criticality: "optional",
      adapters: { brain: { module: "./runtime-brain", hosts: ["brain"] } },
    })
    expect(Object.keys(runtime!.adapters)).toEqual(["brain"])
    expect(runtime!.absent?.desktop).toMatch(/BackgroundTaskInitializer/)
    expect(runtime!.absent?.mobile).toMatch(/BackgroundTaskInitializer/)
  })

  it("delivers a room's Squad results wherever the room runs, and says why a phone never does", () => {
    const runtimes = backgroundTasks.runtimes ?? []
    expect(runtimes.map((runtime) => runtime.name)).toEqual([
      "background-job-delivery",
      "room-result-delivery",
    ])
    const room = runtimes[1]!
    expect(room).toMatchObject({
      criticality: "optional",
      adapters: {
        brain: { module: "./runtime-room-lane", hosts: ["brain"] },
        desktop: "./runtime-room-lane",
      },
    })
    expect(room.absent?.mobile).toMatch(/never orchestrates a room/)
    expect(backgroundTasks.api).toContain("lib/background-tasks/squad-handoff-outbox.ts")
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
