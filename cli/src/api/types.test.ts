import { findCommand } from "./catalog"
import { commandForWire } from "./types"
import { buildRequestBody, validateContract } from "./validate"

describe("per-wire contract selection", () => {
  it("keeps service paths and device workspace coordinates distinct", () => {
    const entry = findCommand("git_status")!
    expect(
      buildRequestBody({
        entry: commandForWire(entry, "internal"),
        flags: {},
        data: { repoPath: "/repo" },
      }).ok
    ).toBe(true)
    expect(
      buildRequestBody({
        entry: commandForWire(entry, "http"),
        flags: {},
        data: { workspaceId: "w" },
      }).ok
    ).toBe(true)
    expect(
      buildRequestBody({
        entry: commandForWire(entry, "http"),
        flags: {},
        data: { repoPath: "/repo" },
      }).ok
    ).toBe(false)
  })
  it("retains definitions needed by the domain output schema", () => {
    const entry = commandForWire(findCommand("host_admin_lease_issue")!, "http")
    expect(() =>
      validateContract(entry, { token: "t", operations: [], expiresAt: 1 }, "output")
    ).not.toThrow()
    expect(entry.outputSchema?.required ?? []).not.toContain("requestId")
  })
})
