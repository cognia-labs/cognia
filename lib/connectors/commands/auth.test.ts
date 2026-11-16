/** @jest-environment jsdom */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const stateFor = jest.fn()
const beginAuthorization = jest.fn(async () => "https://auth.test/link")
const revoke = jest.fn(async () => undefined)
let hasHook = true
jest.mock("../vendor-contribution", () => ({
  connectorVendor: () =>
    hasHook ? { delegatedCredentials: { stateFor, beginAuthorization, revoke } } : {},
}))
const forgetAuthorizationOffer = jest.fn()
jest.mock("../delegated-authorization", () => ({
  ...jest.requireActual("../delegated-authorization"),
  forgetAuthorizationOffer: (id: string, p: unknown) => forgetAuthorizationOffer(id, p),
}))

import { authorizationLinkText } from "../delegated-authorization"
import { handleAuthCommand } from "./auth"

const adapterRow = { id: "bot-a", type: "lark" } as AdapterInstanceRow
function event(options: { private?: boolean; registry?: boolean } = {}): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId: "bot-a",
    sender: { remoteUserId: "ou_a" },
    channel: { kind: options.private === false ? "group" : "private" },
    conversationRef: { platform: "lark", adapterId: "bot-a", channelId: "oc_dm" },
    channelData:
      options.registry === false
        ? {}
        : { resolvedPrincipal: { principalId: "p-alice", accountId: "acct" } },
  } as unknown as NormalizedInboundEvent
}
const alice = {
  kind: "platform",
  platform: "lark",
  adapterId: "bot-a",
  remoteUserId: "ou_a",
  principalId: "p-alice",
}

const reply = jest.fn(async () => undefined)
const run = (arg: string, e = event()) => handleAuthCommand({ event: e, arg, adapterRow, reply })

beforeEach(() => {
  hasHook = true
  stateFor.mockReset().mockResolvedValue({ status: "needs-authorization" })
  beginAuthorization.mockClear()
  revoke.mockClear()
  forgetAuthorizationOffer.mockClear()
  reply.mockClear()
})

it("sends the sender a link only they can complete", async () => {
  await run("")
  expect(beginAuthorization).toHaveBeenCalledWith(adapterRow, alice)
  expect(reply).toHaveBeenCalledWith(authorizationLinkText("https://auth.test/link"), "applied", {
    op: "link",
  })
})

it("tells an authorized sender how to revoke instead of sending a link", async () => {
  stateFor.mockResolvedValue({ status: "authorized", epoch: 3 })
  await run("")
  expect(beginAuthorization).not.toHaveBeenCalled()
  expect(reply).toHaveBeenCalledWith(expect.stringContaining("/auth revoke"), "applied", {
    op: "status",
  })
})

it("revokes the sender's own authorization and lets them authorize again at once", async () => {
  await run("Revoke")
  expect(revoke).toHaveBeenCalledWith(adapterRow, alice)
  expect(forgetAuthorizationOffer).toHaveBeenCalledWith("bot-a", alice)
  expect(reply).toHaveBeenCalledWith(expect.any(String), "applied", { op: "revoke" })
})

it.each([
  ["an unknown argument", "status", event(), "unknown", undefined],
  ["a group chat", "", event({ private: false }), "denied", { reason: "not_private" }],
  ["the registry off", "", event({ registry: false }), "denied", { reason: "registry_off" }],
])("refuses %s without touching any authorization", async (_name, arg, e, outcome, extra) => {
  await run(arg, e)
  expect(reply).toHaveBeenCalledWith(expect.any(String), outcome, ...(extra ? [extra] : []))
  expect(beginAuthorization).not.toHaveBeenCalled()
  expect(revoke).not.toHaveBeenCalled()
})

it("refuses on a platform without per-person authorizations", async () => {
  hasHook = false
  await run("")
  expect(reply).toHaveBeenCalledWith(expect.any(String), "unknown", { reason: "unsupported" })
})
