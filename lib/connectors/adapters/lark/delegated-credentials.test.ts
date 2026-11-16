/** @jest-environment jsdom */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { larkUserKey } from "@/lib/auth-providers/feishu/user-key"

let stored: AdapterInstanceRow | undefined
const updateAdapterInstance = jest.fn(async (_id: string, patch: Partial<AdapterInstanceRow>) => {
  stored = { ...(stored as AdapterInstanceRow), ...patch }
})
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: async () => stored,
  updateAdapterInstance: (id: string, patch: Partial<AdapterInstanceRow>) =>
    updateAdapterInstance(id, patch),
}))
const connectorsLarkUserAuth = jest.fn()
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsLarkUserAuth: (input: unknown) => connectorsLarkUserAuth(input),
}))
let ingressBase: string | null = "https://ingress.test"
jest.mock("@/lib/connectors/server-transport", () => ({
  connectorOAuthRelayPath: (vendor: string) => `/oauth/${vendor}/relay`,
  resolveConnectorsIngressBase: () => ingressBase,
  resolveConnectorApiBase: () => "",
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
const beginLarkOAuth = jest.fn(async (_input: unknown) => ({
  authorizeUrl: "https://open.feishu.cn/a?state=s",
}))
jest.mock("@/lib/auth-providers/feishu/oauth-begin", () => ({
  beginLarkOAuth: (input: unknown) => beginLarkOAuth(input),
}))
const reconcileLarkConnection = jest.fn(async (_id: string, _principal: string) => undefined)
jest.mock("@/lib/auth-providers/feishu/host-auth", () => ({
  reconcileLarkConnection: (id: string, principal: string) =>
    reconcileLarkConnection(id, principal),
}))

import {
  beginLarkDelegatedAuthorization,
  larkDelegatedState,
  listLarkDelegatedAuthorizations,
  revokeLarkDelegatedAuthorization,
} from "./delegated-credentials"

const person = (openId: string, adapterId = "bot") =>
  ({ kind: "platform", platform: "lark", adapterId, remoteUserId: openId }) as const
let aliceKey: string
let ownerKey: string

function row(settings: Record<string, unknown> = {}): AdapterInstanceRow {
  return { id: "bot", type: "lark", settings } as AdapterInstanceRow
}

beforeAll(async () => {
  aliceKey = await larkUserKey("ou_alice")
  ownerKey = await larkUserKey("ou_owner")
})

beforeEach(() => {
  ingressBase = "https://ingress.test"
  connectorsLarkUserAuth.mockReset()
  beginLarkOAuth.mockClear()
  reconcileLarkConnection.mockClear()
  updateAdapterInstance.mockClear()
})

describe("larkDelegatedState", () => {
  it("is authorized only with a record and a live token under the person's key", async () => {
    const r = row({ authorizedUsers: { [aliceKey]: { openId: "ou_alice" } } })
    connectorsLarkUserAuth.mockResolvedValue({
      configured: true,
      accessToken: "u-token",
      authorizationEpoch: 4,
    })
    expect(await larkDelegatedState(r, person("ou_alice"))).toEqual({
      status: "authorized",
      epoch: 4,
    })
    expect(connectorsLarkUserAuth).toHaveBeenCalledWith({
      action: "snapshot",
      adapterId: "bot",
      principal: aliceKey,
    })
    connectorsLarkUserAuth.mockResolvedValue({ configured: true, authorizationEpoch: 4 })
    expect(await larkDelegatedState(r, person("ou_alice"))).toEqual({
      status: "needs-authorization",
    })
  })

  it("needs authorization without a record, whatever the store holds", async () => {
    expect(await larkDelegatedState(row(), person("ou_alice"))).toEqual({
      status: "needs-authorization",
    })
    expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
  })

  it("refuses another adapter's person", async () => {
    await expect(larkDelegatedState(row(), person("ou_alice", "other"))).rejects.toThrow(
      "lark_person_foreign"
    )
  })
})

describe("beginLarkDelegatedAuthorization", () => {
  it("issues a sign-in to exactly that person on the saved redirect", async () => {
    const url = await beginLarkDelegatedAuthorization(
      row({ redirectUri: " https://saved.test/cb ", brand: "lark" }),
      person("ou_alice")
    )
    expect(url).toBe("https://open.feishu.cn/a?state=s")
    expect(beginLarkOAuth).toHaveBeenCalledWith({
      adapterId: "bot",
      issuedTo: aliceKey,
      redirectUri: "https://saved.test/cb",
      brand: "lark",
    })
  })

  it("falls back to the deployment's relay, and refuses without one", async () => {
    await beginLarkDelegatedAuthorization(row(), person("ou_alice"))
    expect(beginLarkOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "https://ingress.test/oauth/lark/relay",
        brand: "feishu",
      })
    )
    ingressBase = null
    await expect(beginLarkDelegatedAuthorization(row(), person("ou_alice"))).rejects.toThrow(
      "redirect_uri_unresolved"
    )
  })
})

it("lists everyone who authorized, with name and time when known", async () => {
  const list = await listLarkDelegatedAuthorizations(
    row({
      authorizedUsers: {
        [aliceKey]: { openId: "ou_alice", name: "Alice", authorizedAtMs: 7 },
        [ownerKey]: { openId: "ou_owner", unionId: "on_owner" },
        notakey: { openId: "ou_junk" },
      },
    })
  )
  expect(list).toEqual([
    { person: person("ou_alice"), name: "Alice", authorizedAt: 7 },
    { person: { ...person("ou_owner"), unionId: "on_owner" } },
  ])
})

describe("revokeLarkDelegatedAuthorization", () => {
  it("disconnects at the current epoch and drops only that person's record", async () => {
    stored = row({
      connectedUser: { openId: "ou_owner" },
      sendAsUser: true,
      authorizedUsers: {
        [aliceKey]: { openId: "ou_alice" },
        [ownerKey]: { openId: "ou_owner" },
      },
    })
    connectorsLarkUserAuth.mockResolvedValueOnce({ configured: true, authorizationEpoch: 9 })
    connectorsLarkUserAuth.mockResolvedValueOnce({ configured: false })
    await revokeLarkDelegatedAuthorization(stored, person("ou_alice"))
    expect(connectorsLarkUserAuth).toHaveBeenLastCalledWith({
      action: "disconnect",
      adapterId: "bot",
      principal: aliceKey,
      expectedAuthorizationEpoch: 9,
    })
    expect(stored?.settings).toEqual({
      connectedUser: { openId: "ou_owner" },
      sendAsUser: true,
      authorizedUsers: { [ownerKey]: { openId: "ou_owner" } },
    })
    expect(reconcileLarkConnection).toHaveBeenCalledWith("bot", aliceKey)
  })

  it("signs the connector out of the owner's identity when the owner revokes", async () => {
    stored = row({
      connectedUser: { openId: "ou_owner" },
      sendAsUser: true,
      authorizedUsers: { [ownerKey]: { openId: "ou_owner" } },
    })
    connectorsLarkUserAuth.mockResolvedValue({ configured: false })
    await revokeLarkDelegatedAuthorization(stored, person("ou_owner"))
    expect(connectorsLarkUserAuth).toHaveBeenCalledTimes(1)
    expect(stored?.settings).toEqual({ authorizedUsers: {} })
    expect(reconcileLarkConnection).toHaveBeenCalledWith("bot", ownerKey)
  })

  it("leaves the row alone for a person with nothing recorded", async () => {
    stored = row({ authorizedUsers: {} })
    connectorsLarkUserAuth.mockResolvedValue({ configured: false })
    await revokeLarkDelegatedAuthorization(stored, person("ou_alice"))
    expect(updateAdapterInstance).not.toHaveBeenCalled()
    expect(reconcileLarkConnection).toHaveBeenCalledWith("bot", aliceKey)
  })
})
