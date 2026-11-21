import {
  createWorkflowSource,
  deriveWorkflowSchedules,
  toUnifiedTrigger,
  WorkflowSourceWriteNotSupportedError,
  type WorkflowScheduleEntry,
} from "./workflow-source"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"

function cron(
  id: string,
  expression: string,
  extra: Partial<WorkflowNode["data"]> = {}
): WorkflowNode {
  return {
    id,
    type: "trigger.cron",
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params: { cron: expression, timezone: "UTC" }, ...extra },
  }
}

function makeWorkflow(overrides: Partial<VisualWorkflow> = {}): VisualWorkflow {
  return {
    id: "wf-1",
    schemaVersion: 2,
    name: "Daily digest",
    createdAt: 1,
    updatedAt: 1,
    nodes: [cron("trigger-1", "0 9 * * *")],
    edges: [],
    settings: {} as VisualWorkflow["settings"],
    ...overrides,
  }
}

function entry(overrides: Partial<WorkflowScheduleEntry> = {}): WorkflowScheduleEntry {
  return {
    workflowId: "wf-1",
    workflowName: "Daily digest",
    triggerId: "trigger-1",
    cron: "0 9 * * *",
    timezone: "UTC",
    published: true,
    paused: false,
    ...overrides,
  }
}

describe("deriveWorkflowSchedules (WF-07)", () => {
  it("lists every published cron trigger, however the workflow was published", () => {
    const draft = makeWorkflow()
    const deployed = new Map([["wf-1", makeWorkflow()]])
    expect(deriveWorkflowSchedules([draft], deployed)).toEqual([entry()])
  })

  it("reports what the published version runs, not the draft's edited cron", () => {
    const draft = makeWorkflow({ nodes: [cron("trigger-1", "*/5 * * * *")] })
    const deployed = new Map([["wf-1", makeWorkflow()]])
    expect(deriveWorkflowSchedules([draft], deployed)).toEqual([entry({ cron: "0 9 * * *" })])
  })

  it("lists a cron node that exists only in the draft as awaiting publish", () => {
    const draft = makeWorkflow({
      nodes: [cron("trigger-1", "0 9 * * *"), cron("new", "0 18 * * *")],
    })
    const deployed = new Map([["wf-1", makeWorkflow()]])
    expect(deriveWorkflowSchedules([draft], deployed)).toEqual([
      entry(),
      entry({ triggerId: "new", cron: "0 18 * * *", published: false }),
    ])
    // A never-published workflow has only draft schedules.
    expect(deriveWorkflowSchedules([draft], new Map()).every((e) => !e.published)).toBe(true)
  })

  it("takes the pause override from the draft row and skips disabled, template and built-in rows", () => {
    const draft = makeWorkflow({ triggerPauses: { "trigger-1": 5 } })
    const deployed = new Map([["wf-1", makeWorkflow()]])
    expect(deriveWorkflowSchedules([draft], deployed)).toEqual([entry({ paused: true })])

    const disabled = makeWorkflow({ nodes: [cron("trigger-1", "0 9 * * *", { disabled: true })] })
    expect(deriveWorkflowSchedules([disabled], new Map([["wf-1", disabled]]))).toEqual([])
    expect(
      deriveWorkflowSchedules(
        [makeWorkflow({ isTemplate: true })],
        new Map([["wf-1", makeWorkflow()]])
      )
    ).toEqual([])
  })
})

describe("toUnifiedTrigger", () => {
  it("maps a published schedule with its next fire time", () => {
    const now = Date.UTC(2026, 0, 1, 8, 0, 0)
    const u = toUnifiedTrigger(entry(), now)
    expect(u.unifiedId).toBe("workflow:wf-1:trigger-1")
    expect(u.sourceId).toBe("wf-1:trigger-1")
    expect(u.status).toBe("active")
    expect(u.triggerSummary).toEqual({
      type: "cron",
      cron: "0 9 * * *",
      eventType: "trigger.cron",
      timezone: "UTC",
    })
    expect(u.nextRunAt).toBe(Date.UTC(2026, 0, 1, 9, 0, 0))
    expect(u.capabilities).toEqual({ runNow: true, pause: true, edit: false, delete: false })
    expect(u.origin.deepLinkHref).toBe("/workflows/editor?id=wf-1")
  })

  it("maps a paused schedule to paused with no next fire", () => {
    const u = toUnifiedTrigger(entry({ paused: true }))
    expect(u.status).toBe("paused")
    expect(u.nextRunAt).toBeUndefined()
  })

  it("marks a draft-only schedule as awaiting publish, with nothing to run or pause", () => {
    const u = toUnifiedTrigger(entry({ published: false }))
    expect(u.status).toBe("disabled")
    expect(u.descriptionKey).toBe("workflowTriggerAwaitingPublish")
    expect(u.nextRunAt).toBeUndefined()
    expect(u.capabilities.runNow).toBe(false)
    expect(u.capabilities.pause).toBe(false)
  })
})

describe("createWorkflowSource", () => {
  function makeStubs(entries: WorkflowScheduleEntry[] = [entry()]) {
    const list = jest.fn(async () => entries)
    const setPaused = jest.fn(async () => ({ ok: true }))
    const run = jest.fn(async () => ({ status: "succeeded" }))
    return { list, setPaused, run }
  }

  it("list() returns the derived schedules", async () => {
    const stubs = makeStubs()
    const items = await createWorkflowSource(stubs).list()
    expect(items.map((item) => item.unifiedId)).toEqual(["workflow:wf-1:trigger-1"])
  })

  it("loads recent workflow runs through the source contract", async () => {
    const listRuns = jest.fn(async () => [])
    const source = createWorkflowSource({ ...makeStubs(), listRuns })
    await expect(source.listRuns?.(7)).resolves.toEqual([])
    expect(listRuns).toHaveBeenCalledWith(7)
  })

  it("get() resolves by the composite source id and misses anything else", async () => {
    const source = createWorkflowSource(makeStubs())
    expect((await source.get("wf-1:trigger-1"))?.name).toBe("Daily digest · 0 9 * * *")
    expect(await source.get("trigger-1")).toBeUndefined()
    expect(await source.get("wf-1:missing")).toBeUndefined()
  })

  it("create() and delete() reject with the documented sentinel error", async () => {
    const source = createWorkflowSource(makeStubs())
    await expect((source.create as () => Promise<unknown>)()).rejects.toBeInstanceOf(
      WorkflowSourceWriteNotSupportedError
    )
    await expect(source.delete("wf-1:trigger-1")).rejects.toBeInstanceOf(
      WorkflowSourceWriteNotSupportedError
    )
  })

  it("pause and resume set the runtime override, never the draft graph", async () => {
    const stubs = makeStubs()
    const source = createWorkflowSource(stubs)
    await source.pause("wf-1:trigger-1")
    await source.resume("wf-1:trigger-1")
    expect(stubs.setPaused.mock.calls).toEqual([
      ["wf-1", "trigger-1", true],
      ["wf-1", "trigger-1", false],
    ])
  })

  it("refuses to pause or run a schedule that is not published yet", async () => {
    const stubs = makeStubs([entry({ published: false })])
    const source = createWorkflowSource(stubs)
    await expect(source.pause("wf-1:trigger-1")).rejects.toThrow(/not published yet/)
    await expect(source.runNow("wf-1:trigger-1")).rejects.toThrow(/not published yet/)
    expect(stubs.setPaused).not.toHaveBeenCalled()
    expect(stubs.run).not.toHaveBeenCalled()
  })

  it("refuses a cron edit, which belongs to the editor, and ignores an empty patch", async () => {
    const stubs = makeStubs()
    const source = createWorkflowSource(stubs)
    await expect(source.update("wf-1:trigger-1", { cron: "*/5 * * * *" })).rejects.toBeInstanceOf(
      WorkflowSourceWriteNotSupportedError
    )
    await source.update("wf-1:trigger-1", {})
    expect(stubs.setPaused).not.toHaveBeenCalled()
  })

  it("runNow invokes the deployment authority adapter", async () => {
    const stubs = makeStubs()
    await createWorkflowSource(stubs).runNow("wf-1:trigger-1")
    expect(stubs.run).toHaveBeenCalledWith({ workflowId: "wf-1", triggerId: "trigger-1" })
  })

  it("runNow rejects when the schedule is missing, so the caller can say so", async () => {
    const stubs = makeStubs([])
    await expect(createWorkflowSource(stubs).runNow("wf-1:missing")).rejects.toThrow(
      "Workflow trigger wf-1:missing was not found."
    )
    expect(stubs.run).not.toHaveBeenCalled()
  })
})
