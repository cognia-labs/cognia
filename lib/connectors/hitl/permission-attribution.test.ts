import { attributeConnectorDecision } from "./permission-attribution"

const mockGetInterrupt = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ executionRunInterrupts: { get: (id: string) => mockGetInterrupt(id) } }),
}))

function interrupt(status: string, remoteUserId?: string) {
  return {
    id: "tool-interrupt:run-a:approval-a",
    runId: "run-a",
    type: "tool_approval",
    status,
    ...(remoteUserId ? { resolvedBy: { remoteUserId } } : {}),
  }
}

beforeEach(() => mockGetInterrupt.mockReset())

describe("attributeConnectorDecision", () => {
  it.each([
    ["allow", "approved"],
    ["deny", "denied"],
  ] as const)(
    "attributes a %s to the connector user who resolved the card",
    async (decision, status) => {
      mockGetInterrupt.mockResolvedValue(interrupt(status, "operator-a"))
      await expect(
        attributeConnectorDecision("run-a", "approval-a", { decision })
      ).resolves.toEqual({
        decision,
        attribution: { authority: "human", actor: { kind: "connector-user", id: "operator-a" } },
      })
      expect(mockGetInterrupt).toHaveBeenCalledWith("tool-interrupt:run-a:approval-a")
    }
  )

  it("names no actor when the resolver is unknown", async () => {
    mockGetInterrupt.mockResolvedValue(interrupt("approved"))
    const outcome = await attributeConnectorDecision("run-a", "approval-a", { decision: "allow" })
    expect(outcome.attribution).toEqual({ authority: "human", actor: { kind: "connector-user" } })
  })

  it.each([
    [{ decision: "allow" }, undefined, "policy-rule"],
    [{ decision: "deny", message: "failed to surface approval card" }, undefined, "policy-deny"],
    [{ decision: "deny", message: "approval timed out" }, undefined, "timeout"],
    [{ decision: "deny" }, interrupt("expired"), "timeout"],
    [{ decision: "allow" }, interrupt("denied", "operator-a"), "policy-rule"],
    [{ decision: "allow" }, { ...interrupt("approved"), runId: "run-b" }, "policy-rule"],
  ] as const)(
    "does not attribute an automatic decision to a human: %j with %j",
    async (decision, stored, authority) => {
      mockGetInterrupt.mockResolvedValue(stored)
      const outcome = await attributeConnectorDecision("run-a", "approval-a", decision)
      expect(outcome.attribution).toEqual({ authority })
    }
  )

  it("keeps an attribution the decision already names, without reading the interrupt", async () => {
    const attribution = {
      authority: "human" as const,
      actor: { kind: "connector-user" as const, id: "reviewer-a" },
    }
    const outcome = { decision: "allow" as const, attribution }
    await expect(attributeConnectorDecision("run-a", "approval-a", outcome)).resolves.toBe(outcome)
    expect(mockGetInterrupt).not.toHaveBeenCalled()
  })

  it("invents nothing when the interrupt cannot be read", async () => {
    mockGetInterrupt.mockRejectedValue(new Error("db closed"))
    const outcome = { decision: "allow" as const }
    await expect(attributeConnectorDecision("run-a", "approval-a", outcome)).resolves.toBe(outcome)
  })
})
