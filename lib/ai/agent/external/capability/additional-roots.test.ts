import { acceptsAdditionalRoots } from "./additional-roots"

const profile = (level: "native" | "equivalent" | "unsupported" | "unknown") => ({
  effective: {
    "workspace.additional-roots": { level, evidence: "adapter-code" as const },
  } as never,
})

describe("acceptsAdditionalRoots", () => {
  it("hands extra roots only to an agent that takes them", () => {
    expect(acceptsAdditionalRoots(profile("native"))).toBe(true)
    expect(acceptsAdditionalRoots(profile("equivalent"))).toBe(true)
  })

  it("keeps a refusing or unmeasured agent on the primary repository", () => {
    expect(acceptsAdditionalRoots(profile("unsupported"))).toBe(false)
    expect(acceptsAdditionalRoots(profile("unknown"))).toBe(false)
    expect(acceptsAdditionalRoots(null)).toBe(false)
    expect(acceptsAdditionalRoots({ effective: {} as never })).toBe(false)
  })
})
