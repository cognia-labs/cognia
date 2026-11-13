import type { ConnectorCallbackBindingRow } from "./interaction"

it("serializes the separate marked-person scope without initiator or operator authority", () => {
  const scope: ConnectorCallbackBindingRow["actorScope"] = {
    mode: "marked-person",
    persons: [{ kind: "local-person" }],
  }
  const row: ConnectorCallbackBindingRow = {
    id: "a:action",
    adapterId: "a",
    actionId: "action",
    kind: "personal_disclosure",
    surfaceId: "disclosure",
    actorScope: scope,
    createdAt: 1,
  }
  expect(JSON.parse(JSON.stringify(row)).actorScope).toEqual(scope)
})

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
