import connectors from "./module"

describe("the connectors manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(connectors).toMatchObject({ id: "connectors", kind: "module", stage: "stable" })
    expect(connectors.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("asks for OCR, speech and the room hand-off through ports, and provides its own", async () => {
    expect(connectors.requires).toEqual(["ocr", "speech", "room-squad-handoff?"])
    expect(connectors.provides?.map((provision) => provision.port)).toEqual([
      "conversation-channel",
      "identity-principal-links",
      "inbound-jobs",
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

  it("owns the conversation-override pull through its sync handlers", async () => {
    expect(connectors.syncHandlers?.tables).toEqual(["conversationOverrides"])
    const { syncHandlers } = await connectors.syncHandlers!.load()
    expect(Object.keys(syncHandlers).sort()).toEqual(["conversationOverrides"])
  })

  it("owns the inbound job store and provides it to recovery and the testing API", async () => {
    expect(connectors.owns).toContain("lib/db/connector-inbound-jobs.ts")
    expect(connectors.api).toContain("lib/db/connector-inbound-jobs.ts")
    const inboundJobs = connectors.provides!.find((provision) => provision.port === "inbound-jobs")
    const { port } = (await inboundJobs!.load()) as {
      port: { findJobForRun: unknown; continueJob: unknown; seedRunningJob: unknown }
    }
    expect(typeof port.findJobForRun).toBe("function")
    expect(typeof port.continueJob).toBe("function")
    expect(typeof port.seedRunningJob).toBe("function")
  })
})
