/**
 * @jest-environment node
 */
import { BRAIN_RUNTIMES } from "@/lib/modules/generated/brain"
import type { BrainRuntimeEntry } from "@/lib/modules/manifest-types"

import { __resetHeadlessRuntimesForTesting, listHeadlessRuntimes } from "../registry"
import type { HeadlessRuntimeContext } from "../types"
import { registerModuleRuntimes } from "./modules"

const entry = (over: Partial<BrainRuntimeEntry>): BrainRuntimeEntry => ({
  module: "demo",
  stage: "stable",
  name: "demo-runtime",
  criticality: "optional",
  hosts: ["brain"],
  load: async () => ({ start: () => undefined }),
  ...over,
})

beforeEach(() => __resetHeadlessRuntimesForTesting())

describe("module runtimes on the brain", () => {
  it("registers each brain adapter under its manifest's name, criticality and hosts", async () => {
    const teardown = jest.fn()
    const start = jest.fn(() => teardown)
    registerModuleRuntimes([
      entry({
        name: "member-thing",
        criticality: "required",
        hosts: ["brain", "person-brain"],
        load: async () => ({ start }),
      }),
    ])
    const [runtime] = listHeadlessRuntimes()
    expect(runtime).toMatchObject({
      name: "member-thing",
      criticality: "required",
      hosts: ["brain", "person-brain"],
    })
    const ctx = { host: "brain" } as HeadlessRuntimeContext
    await expect(runtime!.start(ctx)).resolves.toBe(teardown)
    expect(start).toHaveBeenCalledWith(ctx)
  })

  it("loads an adapter only when its runtime starts", () => {
    const load = jest.fn(async () => ({ start: () => undefined }))
    registerModuleRuntimes([entry({ load })])
    expect(load).not.toHaveBeenCalled()
  })

  // Rule 7: an experimental module is dormant on the brain too.
  it("registers nothing for an experimental module", () => {
    registerModuleRuntimes([entry({ stage: "experimental" })])
    expect(listHeadlessRuntimes()).toEqual([])
  })

  it("carries the Squad bootstrap from the squads manifest, on the Host brain only", () => {
    expect(BRAIN_RUNTIMES.map((e) => [e.module, e.name, e.hosts])).toContainEqual([
      "squads",
      "agent-team-runtime",
      ["brain"],
    ])
    // Eval's online drain has no brain adapter; its manifest says why.
    expect(BRAIN_RUNTIMES.map((e) => e.name)).not.toContain("online-eval")
  })
})
