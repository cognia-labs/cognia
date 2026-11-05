import { MOBILE_RUNTIMES } from "./generated/mobile"
import type { RendererRuntimeEntry } from "./manifest-types"
import { RENDERER_HOST, rendererRuntimes } from "./runtimes.mobile"

describe("mobile module runtimes", () => {
  it("is the Capacitor build's host, over the phone's own registry", () => {
    expect(RENDERER_HOST).toBe("mobile")
    expect(rendererRuntimes("knowledge-agents").map((e) => e.name)).toContain("agent-team-runtime")
    expect(rendererRuntimes().map((e) => e.name)).toContain("online-eval")
    expect(rendererRuntimes().every((e) => MOBILE_RUNTIMES.includes(e))).toBe(true)
  })

  it("starts nothing for an experimental module", () => {
    const dormant: RendererRuntimeEntry = {
      module: "demo",
      stage: "experimental",
      name: "demo",
      criticality: "optional",
      load: async () => ({ start: () => undefined }),
    }
    expect(rendererRuntimes(undefined, [dormant])).toEqual([])
  })
})
