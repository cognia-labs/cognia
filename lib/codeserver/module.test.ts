import {
  EDITOR_WRITE_TOOL_NAMES,
  READ_ACTIVE_EDITOR_TOOL_NAME,
  SAVE_EDITOR_BUFFERS_TOOL_NAME,
} from "./agent-tools"
import codeserverModule from "./module"

describe("the codeserver manifest", () => {
  const declare = codeserverModule.tools!.declare

  it("declares the read and the five Pro IDE write tools", () => {
    expect(Object.keys(declare).sort()).toEqual(
      [READ_ACTIVE_EDITOR_TOOL_NAME, ...EDITOR_WRITE_TOOL_NAMES].sort()
    )
  })

  it("leaves the read to the run's approval, asks to save, and allows the viewport-only writes", () => {
    for (const [name, declaration] of Object.entries(declare)) {
      expect(declaration.consent).toBe(
        name === READ_ACTIVE_EDITOR_TOOL_NAME
          ? "default"
          : name === SAVE_EDITOR_BUFFERS_TOOL_NAME
            ? "ask"
            : "allow"
      )
      expect(declaration.effect).toBe(name === READ_ACTIVE_EDITOR_TOOL_NAME ? "read" : "write")
      expect(declaration.cancellable).toBe(false)
    }
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await codeserverModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
  })
})
