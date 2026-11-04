/** @jest-environment node */
jest.mock("./agents/generic", () => ({
  RuntimeNotInstalled: class extends Error {},
  runAgentSmoke: jest.fn(),
}))
jest.mock("./agents/vendors/kimi", () => ({ kimi: { runtimeId: "kimi" } }))
jest.mock("./agents/vendors/qoder", () => ({ qoder: { runtimeId: "qoder" } }))
jest.mock("@/cli/src/runtime/external/version-probe", () => ({ probeRuntimeVersion: jest.fn() }))
jest.mock("@/lib/ai/agent/external/config/install-catalog", () => ({
  EXTERNAL_AGENT_RUNTIMES: [],
  runtimeSupportsPlatform: jest.fn(() => true),
}))

import { coveringLane, parseAgentSmokeArgs, VENDORS } from "./agent"

describe("smoke:agent arguments", () => {
  it("parses runtimes and flags", () => {
    expect(parseAgentSmokeArgs(["kimi", "qoder", "--live", "--keep"])).toEqual({
      runtimes: ["kimi", "qoder"],
      list: false,
      installed: false,
      live: true,
      keep: true,
    })
    expect(parseAgentSmokeArgs(["--installed"]).installed).toBe(true)
    expect(parseAgentSmokeArgs(["--list"]).list).toBe(true)
  })

  it("requires a selection and refuses --installed with named runtimes", () => {
    expect(() => parseAgentSmokeArgs([])).toThrow(/Name at least one runtime/)
    expect(() => parseAgentSmokeArgs(["--installed", "kimi"])).toThrow(/--installed selects/)
    expect(() => parseAgentSmokeArgs(["--bogus"])).toThrow(/Unknown option/)
  })
})

describe("coverage map", () => {
  it("names the lane that covers each runtime", () => {
    expect(Object.keys(VENDORS).sort()).toEqual(["kimi", "qoder"])
    expect(coveringLane("kimi", "acp")).toBe("generic + vendor")
    expect(coveringLane("grok", "acp")).toBe("generic")
    expect(coveringLane("pi", "pi-rpc")).toBe("none (pi-rpc)")
  })
})
