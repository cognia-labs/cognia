import { larkDocsProvider } from "./provider"
import { port } from "./port"

describe("lark-docs port", () => {
  it("is the Lark Docs provider itself", () => {
    expect(port).toBe(larkDocsProvider)
    expect(port.id).toBe("lark")
  })
})
