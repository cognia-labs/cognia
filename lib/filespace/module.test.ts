import { FILESPACE_SHARING_TOOL_NAMES, FILESPACE_TOOL_NAMES } from "./agent-tools"
import filespaceModule from "./module"

describe("the filespace manifest", () => {
  const declare = filespaceModule.tools!.declare

  it("declares exactly the tools the family offers", () => {
    expect(Object.keys(declare).sort()).toEqual(Object.values(FILESPACE_TOOL_NAMES).sort())
  })

  it("asks on every call before giving access away, and counts it as outbound", () => {
    for (const [name, declaration] of Object.entries(declare)) {
      const sharing = FILESPACE_SHARING_TOOL_NAMES.has(name)
      expect(declaration.consent).toBe(sharing ? "per-call" : "allow")
      expect(declaration.effect).toBe(
        sharing ? "outbound" : name === FILESPACE_TOOL_NAMES.list ? "read" : "write"
      )
      // The runners take no cancel signal.
      expect(declaration.cancellable).toBe(false)
    }
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await filespaceModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
  })
})
