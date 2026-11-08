import type { ConnectorVendorContribution } from "../vendor-contribution"

const mockVendors: ConnectorVendorContribution[] = []
jest.mock("../vendor-contribution", () => ({ connectorVendors: () => mockVendors }))

import { port } from "./identity-principal-links"

function vendor(
  platform: string,
  principalLinks?: ConnectorVendorContribution["principalLinks"]
): ConnectorVendorContribution {
  return { platform, ...(principalLinks ? { principalLinks } : {}) }
}

const attachInput = { userId: "u1", logtoSubject: "sub", identities: [] }
const unlinkInput = { localAccountId: "acct", userId: "u1" }

beforeEach(() => {
  mockVendors.length = 0
})

describe("identity-principal-links (connectors member)", () => {
  it("asks every vendor with a principal registry, in catalog order, and merges what they report", async () => {
    const order: string[] = []
    const lark = {
      attachSignIn: jest.fn(async () => {
        order.push("lark")
        return { attached: ["fp_1"], foreign: ["fp_x"] }
      }),
      unlinkSelfBound: jest.fn(async () => ["fp_1"]),
    }
    const slack = {
      attachSignIn: jest.fn(async () => {
        order.push("slack")
        return { attached: ["sp_1"], foreign: [] }
      }),
      unlinkSelfBound: jest.fn(async () => ["sp_1", "sp_2"]),
    }
    mockVendors.push(vendor("lark", lark), vendor("discord"), vendor("slack", slack))
    await expect(port.attachSignIn(attachInput)).resolves.toEqual({
      attached: ["fp_1", "sp_1"],
      foreign: ["fp_x"],
    })
    expect(order).toEqual(["lark", "slack"])
    expect(lark.attachSignIn).toHaveBeenCalledWith(attachInput)
    await expect(port.unlinkSelfBound(unlinkInput)).resolves.toEqual(["fp_1", "sp_1", "sp_2"])
    expect(slack.unlinkSelfBound).toHaveBeenCalledWith(unlinkInput)
  })

  it("reports nothing when no vendor keeps a registry", async () => {
    mockVendors.push(vendor("discord"))
    await expect(port.attachSignIn(attachInput)).resolves.toEqual({ attached: [], foreign: [] })
    await expect(port.unlinkSelfBound(unlinkInput)).resolves.toEqual([])
  })

  it("lets a vendor's failure reach the identity plane's reader", async () => {
    mockVendors.push(
      vendor("lark", {
        attachSignIn: async () => {
          throw new Error("profile changed")
        },
        unlinkSelfBound: async () => [],
      })
    )
    await expect(port.attachSignIn(attachInput)).rejects.toThrow("profile changed")
  })
})
