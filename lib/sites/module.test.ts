import { DEPLOY_SITE_TOOL_NAME, LIST_SITES_TOOL_NAME, SITES_TOOL_NAMES } from "./agent-tools"
import sitesModule from "./module"

describe("the sites manifest", () => {
  const declare = sitesModule.tools!.declare

  it("declares exactly the Sites tools", () => {
    expect(Object.keys(declare).sort()).toEqual([...SITES_TOOL_NAMES].sort())
  })

  it("allows listing and building, and asks before publishing, which is outbound", () => {
    for (const [name, declaration] of Object.entries(declare)) {
      const deploy = name === DEPLOY_SITE_TOOL_NAME
      expect(declaration.consent).toBe(deploy ? "ask" : "allow")
      expect(declaration.effect).toBe(
        deploy ? "outbound" : name === LIST_SITES_TOOL_NAME ? "read" : "write"
      )
      // None of the runners takes a cancel signal.
      expect(declaration.cancellable).toBe(false)
    }
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await sitesModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
  })
})
