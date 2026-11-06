import { googleDocsProvider } from "./provider"
import { port } from "./port"

describe("google-docs port", () => {
  it("is the Google Docs provider itself", () => {
    expect(port).toBe(googleDocsProvider)
    expect(port.id).toBe("google")
  })
})
