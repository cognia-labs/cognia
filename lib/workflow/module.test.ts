import workflow from "./module"

describe("the workflow manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(workflow).toMatchObject({ id: "workflow", kind: "module", stage: "stable" })
    expect(workflow.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("asks for OCR and, optionally, revision pinning, interactive pages, the bots and fresh playbook copies through ports", () => {
    expect(workflow.requires).toEqual([
      "ocr",
      "knowledge-base-revisions?",
      "interactive-page?",
      "bot-dispatch?",
      // A draft run outside the editor reads a playbook-derived row through
      // the playbooks' port, never the stale stored copy (WF-17).
      "fresh-workflows?",
    ])
    expect(workflow.dependsOn).not.toContain("bot")
  })

  it("owns the companion pull of the workflow definitions a paired client mirrors", async () => {
    expect(workflow.syncHandlers?.tables).toEqual(["workflows"])
    const { syncHandlers } = await workflow.syncHandlers!.load()
    expect(Object.keys(syncHandlers)).toEqual(["workflows"])
  })

  it("contributes its prompts lazily", async () => {
    const { prompts } = await workflow.prompts!()
    expect(prompts.length).toBeGreaterThan(0)
  })
})
