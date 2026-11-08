import {
  __setLarkCliCapabilityDiagnosticsForTests,
  probeLarkCliCapabilities,
  type LarkCliCapabilityDiagnostics,
} from "@/lib/skills/built-in/lark/capabilities"
import { getSharedBuiltInSkillRegistry } from "@/lib/skills/built-in/registry"
import { availability } from "./builtin-skills"
import { larkContribution } from "./contribution"

jest.mock("@/lib/skills/built-in/lark/capabilities", () => ({
  ...jest.requireActual<typeof import("@/lib/skills/built-in/lark/capabilities")>(
    "@/lib/skills/built-in/lark/capabilities"
  ),
  probeLarkCliCapabilities: jest.fn(),
}))
const mockProbe = jest.mocked(probeLarkCliCapabilities)

function diagnostics(
  fields: Partial<LarkCliCapabilityDiagnostics> = {}
): LarkCliCapabilityDiagnostics {
  return {
    certifiedVersion: "1.0.98",
    detectedVersion: "1.0.98",
    ready: true,
    missingCommands: [],
    missingFlags: {},
    affectedSkillIds: [],
    ...fields,
  }
}

beforeEach(() => {
  mockProbe.mockReset().mockResolvedValue(diagnostics())
  __setLarkCliCapabilityDiagnosticsForTests(undefined)
})

describe("Lark's built-in skill families", () => {
  it("registers every family the Lark contribution declares on import", () => {
    const families = new Set(
      getSharedBuiltInSkillRegistry()
        .list()
        .map((skill) => skill.family)
    )
    const declared = larkContribution.builtInSkills?.families ?? []
    expect(declared).toHaveLength(6)
    for (const family of declared) expect(families).toContain(family)
  })

  it("gates the certified Lark skills and nothing else", () => {
    expect(availability.governs("lark.calendar.list_events")).toBe(true)
    expect(availability.governs("im.broadcast")).toBe(false)
  })

  it("starts a probe on the first question and answers unavailable until it finishes", () => {
    expect(availability.isAvailable("lark.calendar.list_events")).toBe(false)
    expect(mockProbe).toHaveBeenCalledTimes(1)

    __setLarkCliCapabilityDiagnosticsForTests(diagnostics())
    expect(availability.isAvailable("lark.calendar.list_events")).toBe(true)
    expect(mockProbe).toHaveBeenCalledTimes(1)

    __setLarkCliCapabilityDiagnosticsForTests(
      diagnostics({ ready: false, affectedSkillIds: ["lark.calendar.list_events"] })
    )
    expect(availability.isAvailable("lark.calendar.list_events")).toBe(false)
  })

  it("settles on desktop and Lark scopes, keyed by what the probe found", async () => {
    mockProbe.mockResolvedValue(
      diagnostics({ detectedVersion: "1.0.99", ready: false, affectedSkillIds: ["b", "a"] })
    )
    const key = await availability.settle({})
    expect(JSON.parse(key ?? "")).toEqual({
      certifiedVersion: "1.0.98",
      detectedVersion: "1.0.99",
      ready: false,
      affectedSkillIds: ["a", "b"],
    })
    await expect(availability.settle({ platform: "lark" })).resolves.toBe(key)
  })

  it("needs nothing for a conversation on another platform", async () => {
    await expect(availability.settle({ platform: "telegram" })).resolves.toBeNull()
    expect(mockProbe).not.toHaveBeenCalled()
  })
})
