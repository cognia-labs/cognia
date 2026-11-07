import { VECTOR_SEARCH_TOOL_NAME, VECTOR_TOOL_NAMES } from "./agent-tools"
import vectorModule from "./module"

describe("the vector manifest", () => {
  const declare = vectorModule.tools!.declare

  it("declares exactly the vector tools", () => {
    expect(Object.keys(declare).sort()).toEqual([...VECTOR_TOOL_NAMES].sort())
  })

  it("asks for every call, as it did before it had a tier, and only search reads", () => {
    for (const [name, declaration] of Object.entries(declare)) {
      expect(declaration.consent).toBe("ask")
      expect(declaration.effect).toBe(name === VECTOR_SEARCH_TOOL_NAME ? "read" : "write")
      // A store write already sent to the native side is not undone by an abort.
      expect(declaration.cancellable).toBe(false)
    }
  })

  it("claims no settings key of its own", () => {
    expect(vectorModule.settings?.keys).toEqual([])
  })

  it("loads its tool family lazily", async () => {
    const { toolFamily } = await vectorModule.tools!.load()
    expect(typeof toolFamily.surface).toBe("function")
    expect(typeof toolFamily.run).toBe("function")
  })
})
