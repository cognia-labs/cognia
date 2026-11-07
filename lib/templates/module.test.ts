import { TEMPLATE_TOOL_NAMES } from "./agent-tools"
import templatesModule from "./module"

describe("the templates manifest", () => {
  const declare = templatesModule.tools!.declare

  it("declares exactly the tools the family offers", () => {
    expect(Object.keys(declare).sort()).toEqual(Object.values(TEMPLATE_TOOL_NAMES).sort())
  })

  it("allows every tool, since instantiating asks the consent broker itself", () => {
    for (const [name, declaration] of Object.entries(declare)) {
      expect(declaration.consent).toBe("allow")
      expect(declaration.effect).toBe(name === TEMPLATE_TOOL_NAMES.instantiate ? "write" : "read")
      // The runners take no cancel signal.
      expect(declaration.cancellable).toBe(false)
    }
  })

  it("reaches the Squad side through the optional squad-templates port", () => {
    expect(templatesModule.requires).toEqual(["squad-templates?"])
    expect(templatesModule.dependsOn).not.toContain("squads")
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await templatesModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
  })
})
