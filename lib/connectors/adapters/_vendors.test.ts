import { CONNECTOR_VENDORS } from "./_vendors"
import { larkContribution } from "./lark/contribution"

describe("connector vendor catalog", () => {
  it("lists each vendor contribution once", () => {
    const platforms = CONNECTOR_VENDORS.map((vendor) => vendor.platform)
    expect(new Set(platforms).size).toBe(platforms.length)
    expect(CONNECTOR_VENDORS).toContain(larkContribution)
  })
})
