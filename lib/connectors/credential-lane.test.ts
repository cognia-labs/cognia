/** @jest-environment node */
jest.mock("./vendor-contribution", () => ({ connectorVendor: jest.fn() }))
import { connectorVendor } from "./vendor-contribution"
import { connectorTurnLane } from "./credential-lane"

const event = (resolved: boolean) =>
  ({
    platform: "lark",
    adapterId: "a1",
    sender: { remoteUserId: "ou_member" },
    channelData: resolved ? { resolvedPrincipal: { principalId: "p1", accountId: "acc" } } : {},
  }) as never

beforeEach(() => {
  jest.mocked(connectorVendor).mockReturnValue({ delegatedCredentials: {} } as never)
})

it("acts as a resolved requester on a platform with per-person authorizations", () => {
  expect(connectorTurnLane({ type: "lark" }, event(true))).toEqual({
    lane: "delegated",
    actingPrincipal: {
      kind: "platform",
      platform: "lark",
      adapterId: "a1",
      remoteUserId: "ou_member",
      principalId: "p1",
    },
  })
  expect(
    connectorTurnLane({ type: "lark", credentialLane: "delegated" }, event(true))
  ).toMatchObject({ lane: "delegated" })
})

it("stays legacy without a resolved principal or per-person authorizations", () => {
  expect(connectorTurnLane({ type: "lark" }, event(false))).toBeUndefined()
  jest.mocked(connectorVendor).mockReturnValue({} as never)
  expect(connectorTurnLane({ type: "slack" }, event(true))).toBeUndefined()
})

it("runs every turn of a service bot account on service credentials", () => {
  expect(connectorTurnLane({ type: "lark", credentialLane: "service" }, event(true))).toEqual({
    lane: "service",
  })
})
