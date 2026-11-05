import { DESKTOP_RUNTIMES } from "./generated/desktop"
import type { RendererRuntimeEntry } from "./manifest-types"
import { RENDERER_HOST, rendererRuntimes } from "./runtimes"

const runtime = (over: Partial<RendererRuntimeEntry>): RendererRuntimeEntry => ({
  module: "demo",
  stage: "stable",
  name: "demo-runtime",
  criticality: "optional",
  load: async () => ({ start: () => undefined }),
  ...over,
})

describe("desktop module runtimes", () => {
  it("is the desktop build's host", () => {
    expect(RENDERER_HOST).toBe("desktop")
  })

  it("gives each mount the runtimes of its boot group, in registry order", () => {
    const entries = [
      runtime({ name: "main-a" }),
      runtime({ name: "squad", boot: "knowledge-agents" }),
      runtime({ name: "main-b" }),
    ]
    expect(rendererRuntimes(undefined, entries).map((e) => e.name)).toEqual(["main-a", "main-b"])
    expect(rendererRuntimes("knowledge-agents", entries).map((e) => e.name)).toEqual(["squad"])
    expect(rendererRuntimes("integrations", entries)).toEqual([])
  })

  // Rule 7: an experimental module is dormant on every host.
  it("starts nothing for an experimental module", () => {
    expect(rendererRuntimes(undefined, [runtime({ stage: "experimental" })])).toEqual([])
  })

  it("holds eval's online drain in the main cluster and the Squad bootstrap in its group", () => {
    expect(rendererRuntimes().map((e) => [e.module, e.name])).toContainEqual([
      "eval",
      "online-eval",
    ])
    expect(rendererRuntimes("knowledge-agents").map((e) => [e.module, e.name])).toContainEqual([
      "squads",
      "agent-team-runtime",
    ])
    expect(new Set(DESKTOP_RUNTIMES.map((e) => e.name)).size).toBe(DESKTOP_RUNTIMES.length)
  })
})
