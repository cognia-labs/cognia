import type { ConnectorCallbackBindingRow } from "./interaction"

it("retains dispatcher provenance across callback-row persistence without requiring it on legacy rows", () => {
  const legacy: ConnectorCallbackBindingRow = {
    id: "a:action",
    adapterId: "a",
    actionId: "action",
    kind: "skill_invoke",
    surfaceId: "s",
    createdAt: 1,
  }
  expect(legacy.skillConfirmationNonce).toBeUndefined()
  const issued: ConnectorCallbackBindingRow = { ...legacy, skillConfirmationNonce: "a".repeat(32) }
  expect(JSON.parse(JSON.stringify(issued)).skillConfirmationNonce).toBe(
    issued.skillConfirmationNonce
  )
})
