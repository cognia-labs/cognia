import { PROJECT_COORDINATOR_TOOL_NAMES, PROJECT_THREAD_TOOL_NAMES } from "./agent-tools"
import coordinationModule from "./module"

describe("the project-coordinator manifest", () => {
  const declare = coordinationModule.tools!.declare

  it("declares exactly the coordinator and thread tools", () => {
    expect(Object.keys(declare).sort()).toEqual(
      [
        ...Object.values(PROJECT_COORDINATOR_TOOL_NAMES),
        ...Object.values(PROJECT_THREAD_TOOL_NAMES),
      ].sort()
    )
  })

  it("asks only before changing the project's limits, and reads only list and report", () => {
    for (const [name, declaration] of Object.entries(declare)) {
      expect(declaration.consent).toBe(
        name === PROJECT_COORDINATOR_TOOL_NAMES.setProjectPreference ? "ask" : "allow"
      )
      expect(declaration.effect).toBe(
        name === PROJECT_COORDINATOR_TOOL_NAMES.listThreads ||
          name === PROJECT_COORDINATOR_TOOL_NAMES.readThreadReport
          ? "read"
          : "write"
      )
      // The runners take no cancel signal.
      expect(declaration.cancellable).toBe(false)
    }
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await coordinationModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
  })
})
