import connectors from "./module"

describe("the connectors manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(connectors).toMatchObject({ id: "connectors", kind: "module", stage: "stable" })
    expect(connectors.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("asks for OCR and speech through ports and provides the IM conversation channel", async () => {
    expect(connectors.requires).toEqual(["ocr", "speech"])
    expect(connectors.provides?.map((provision) => provision.port)).toEqual([
      "conversation-channel",
    ])
    const { port } = (await connectors.provides![0]!.load()) as {
      port: { claimsBinding: unknown }
    }
    expect(typeof port.claimsBinding).toBe("function")
  })

  it("contributes its prompts and its IM workflow nodes lazily", async () => {
    const { prompts } = await connectors.prompts!()
    expect(prompts.length).toBeGreaterThan(0)
    const { workflowNodeKinds } = await connectors.workflowNodes!.load()
    expect(workflowNodeKinds).toContain("action.connector.send")
  })
})
