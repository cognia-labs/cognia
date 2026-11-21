import { WorkflowRunRejectedError } from "./run-rejection"
import { runWorkflowFromLibrary, type LibraryRunDeps } from "./library-run"

const published = { versionId: "ver_1", deploymentId: "dep_1" } as never

function deps(overrides: Partial<LibraryRunDeps> = {}) {
  return {
    authority: jest.fn((): "local" | "host" => "host"),
    enqueueUnlessQueued: jest.fn(async () => ({ row: {} as never, alreadyQueued: false })),
    triggerPublished: jest.fn(async () => ({ status: "admitted" as const, runId: "run_pub" })),
    startPreview: jest.fn(async () => ({ runId: "run_preview" })),
    ...overrides,
  } satisfies LibraryRunDeps
}

describe("runWorkflowFromLibrary on a paired phone", () => {
  it("queues a published workflow's run for the Host", async () => {
    const d = deps()
    await expect(
      runWorkflowFromLibrary({ id: "wf_1", name: "Digest", published }, d)
    ).resolves.toEqual({ status: "queued" })
    expect(d.enqueueUnlessQueued).toHaveBeenCalledWith({
      command: "workflow_trigger_manual",
      payload: { workflowId: "wf_1" },
      label: "Digest",
    })
    expect(d.triggerPublished).not.toHaveBeenCalled()
  })

  it("says a run is already waiting instead of stacking another", async () => {
    const d = deps({
      enqueueUnlessQueued: jest.fn(async () => ({ row: {} as never, alreadyQueued: true })),
    })
    await expect(
      runWorkflowFromLibrary({ id: "wf_1", name: "Digest", published }, d)
    ).resolves.toEqual({ status: "already-queued" })
  })

  // The Host would only refuse it; the phone used to say "queued" anyway.
  it("does not queue a workflow that is not published", async () => {
    const d = deps()
    await expect(runWorkflowFromLibrary({ id: "wf_1", name: "Draft" }, d)).resolves.toEqual({
      status: "not-published",
    })
    expect(d.enqueueUnlessQueued).not.toHaveBeenCalled()
  })
})

describe("runWorkflowFromLibrary on a standalone phone", () => {
  const local = () => deps({ authority: () => "local" })

  it("runs the published deployment here and answers with the run", async () => {
    const d = local()
    await expect(
      runWorkflowFromLibrary({ id: "wf_1", name: "Digest", published }, d)
    ).resolves.toEqual({ status: "started", workflowId: "wf_1", runId: "run_pub" })
    expect(d.triggerPublished).toHaveBeenCalledWith({
      workflowId: "wf_1",
      triggeredBy: { source: "ui" },
    })
    expect(d.enqueueUnlessQueued).not.toHaveBeenCalled()
  })

  it("previews the saved draft of an unpublished workflow, like the desktop library", async () => {
    const d = local()
    await expect(runWorkflowFromLibrary({ id: "wf_1", name: "Draft" }, d)).resolves.toEqual({
      status: "started",
      workflowId: "wf_1",
      runId: "run_preview",
    })
    expect(d.startPreview).toHaveBeenCalledWith({
      workflowId: "wf_1",
      mode: "full",
      triggeredBy: { source: "ui" },
    })
  })

  it("reports a handoff to another Host and an admission refusal", async () => {
    const handedOff = deps({
      authority: () => "local",
      triggerPublished: jest.fn(async () => ({
        status: "handed_off" as const,
        dispatchId: "dsp_1",
        targetRef: "host-b",
      })),
    })
    await expect(
      runWorkflowFromLibrary({ id: "wf_1", name: "Digest", published }, handedOff)
    ).resolves.toEqual({ status: "handed-off", targetRef: "host-b" })

    const refused = deps({
      authority: () => "local",
      triggerPublished: jest.fn(async () => {
        throw new WorkflowRunRejectedError("input-schema-violation", "missing field q")
      }),
    })
    await expect(
      runWorkflowFromLibrary({ id: "wf_1", name: "Digest", published }, refused)
    ).resolves.toEqual({
      status: "refused",
      reason: "input-schema-violation",
      detail: "missing field q",
    })

    const broken = deps({
      authority: () => "local",
      triggerPublished: jest.fn(async () => {
        throw new Error("database closed")
      }),
    })
    await expect(
      runWorkflowFromLibrary({ id: "wf_1", name: "Digest", published }, broken)
    ).rejects.toThrow("database closed")
  })
})
