import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import { readSquadRunReport, squadRunReportOf, squadRunReportText } from "./squad-run-report"

describe("squadRunReportText", () => {
  it("reads an Ultracode run's synthesis and a single task's answer", () => {
    expect(squadRunReportText({ report: "## Findings\n\nAll good" })).toBe(
      "## Findings\n\nAll good"
    )
    expect(squadRunReportText({ text: "hello.sh written", teammateId: "t1" })).toBe(
      "hello.sh written"
    )
  })

  it("joins every terminal step's answer in order", () => {
    expect(
      squadRunReportText({
        "task-a": { text: "API done" },
        "task-b": { text: "UI done", verdict: "approved" },
        "task-c": { text: "   " },
      })
    ).toBe("API done\n\nUI done")
  })

  it("has no report for an integration step, nothing, or a non-object", () => {
    expect(squadRunReportText({ reconciled: true, merged: 2 })).toBeUndefined()
    expect(squadRunReportText({})).toBeUndefined()
    expect(squadRunReportText(undefined)).toBeUndefined()
    expect(squadRunReportText("text")).toBeUndefined()
    expect(squadRunReportText([{ text: "x" }])).toBeUndefined()
  })
})

describe("squadRunReportOf", () => {
  it("keeps the run's text and its error message", () => {
    expect(
      squadRunReportOf({ output: { text: "done" }, error: undefined } as Pick<
        WorkflowRunRow,
        "output" | "error"
      >)
    ).toEqual({ text: "done" })
    expect(
      squadRunReportOf({ output: undefined, error: { message: " tests failed " } } as Pick<
        WorkflowRunRow,
        "output" | "error"
      >)
    ).toEqual({ error: "tests failed" })
    expect(squadRunReportOf(undefined)).toEqual({})
  })
})

describe("readSquadRunReport", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(() => disableDbRuntime?.())

  it("reads each run's own row, never another run's (F04)", async () => {
    const row = (id: string, output: unknown) =>
      ({
        id,
        workflowId: "team-workflow:sq-1",
        status: "succeeded",
        triggerKind: "trigger.team",
        triggerPayload: { teamId: "sq-1" },
        startedAt: 1,
        output,
        workflowSnapshot: { id: "team-workflow:sq-1", nodes: [], edges: [] },
      }) as unknown as WorkflowRunRow
    // The same Squad ran Ultracode first, then a normal run.
    await getDb().workflowRuns.bulkAdd([
      row("run-ultracode", { report: "old synthesis" }),
      row("run-normal", { text: "this run's answer" }),
    ])
    await expect(readSquadRunReport("run-normal")).resolves.toEqual({ text: "this run's answer" })
    await expect(readSquadRunReport("run-ultracode")).resolves.toEqual({ text: "old synthesis" })
    await expect(readSquadRunReport("missing")).resolves.toEqual({})
  })
})
