import { connectorVendor, connectorVendors } from "./vendor-contribution"
import { CONNECTOR_VENDORS } from "./adapters/_vendors"
import { larkContribution } from "./adapters/lark/contribution"

describe("connector vendor lookup", () => {
  it("lists the catalog in order", () => {
    expect(connectorVendors()).toBe(CONNECTOR_VENDORS)
  })

  it("finds a contribution by platform", () => {
    expect(connectorVendor("lark")).toBe(larkContribution)
  })

  it("returns undefined for a platform whose vendor contributes nothing", () => {
    expect(connectorVendor("telegram")).toBeUndefined()
    expect(connectorVendor("")).toBeUndefined()
  })
})
