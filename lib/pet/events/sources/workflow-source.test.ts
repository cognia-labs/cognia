import { runStatusToEmit, wireWorkflowSource } from "./workflow-source"
import type { RowObserver } from "./goal-source"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"
import type { PetEvent } from "@/types/pet"

function run(id: string, status: RunStatus): WorkflowRunRow {
  return { id, status, startedAt: 1 } as WorkflowRunRow
}

describe("runStatusToEmit", () => {
  it("maps running/succeeded/failed and ignores the rest", () => {
    expect(runStatusToEmit("running")).toMatchObject({ kind: "workflowRun" })
    expect(runStatusToEmit("succeeded")).toMatchObject({ kind: "success", xp: 6 })
    expect(runStatusToEmit("failed")).toMatchObject({ kind: "error" })
    expect(runStatusToEmit("pending")).toBeNull()
    expect(runStatusToEmit("paused")).toBeNull()
  })
})

describe("wireWorkflowSource", () => {
  it("detects in-place status flips and new runs after the initial row", () => {
    let push: (rows: WorkflowRunRow[]) => void = () => {}
    const observe: RowObserver<WorkflowRunRow> = (onRows) => {
      push = onRows
      return () => {}
    }
    const events: PetEvent[] = []
    wireWorkflowSource((e) => events.push({ ...e, at: 0 }), observe)

    push([run("r1", "running")]) // pre-existing → ignored
    push([run("r1", "succeeded")]) // in-place flip → success
    push([run("r1", "succeeded")]) // unchanged → ignored
    push([run("r2", "running")]) // new run → workflowRun
    push([run("r2", "failed")]) // → error
    push([]) // empty → ignored

    expect(events.map((e) => e.kind)).toEqual(["success", "workflowRun", "error"])
  })

  it("takes an empty first result as the baseline, so the first run's running cue emits", () => {
    let push: (rows: WorkflowRunRow[]) => void = () => {}
    const observe: RowObserver<WorkflowRunRow> = (onRows) => {
      push = onRows
      return () => {}
    }
    const events: PetEvent[] = []
    wireWorkflowSource((e) => events.push({ ...e, at: 0 }), observe)

    push([]) // no runs yet → baseline
    push([run("r1", "running")]) // the first run ever → workflowRun
    push([run("r1", "succeeded")]) // → success

    expect(events.map((e) => e.kind)).toEqual(["workflowRun", "success"])
  })

  it("emits completion of an earlier run after a newer run starts and ignores deleted-window replays (F23)", () => {
    let push: (rows: WorkflowRunRow[]) => void = () => {}
    const observe: RowObserver<WorkflowRunRow> = (onRows) => {
      push = onRows
      return () => {}
    }
    const events: PetEvent[] = []
    wireWorkflowSource((e) => events.push({ ...e, at: 0 }), observe)

    const at = (id: string, status: RunStatus, startedAt: number): WorkflowRunRow =>
      ({ id, status, startedAt }) as WorkflowRunRow

    push([at("r0", "succeeded", 50)]) // baseline
    push([at("rA", "running", 100), at("r0", "succeeded", 50)])
    push([at("rB", "running", 200), at("rA", "running", 100), at("r0", "succeeded", 50)])
    // Older concurrent run rA finishes while newer run rB is still running.
    push([at("rB", "running", 200), at("rA", "succeeded", 100), at("r0", "succeeded", 50)])
    // Then rB finishes.
    push([at("rB", "failed", 200), at("rA", "succeeded", 100), at("r0", "succeeded", 50)])
    // Deleting newer runs pulls an older historical run into the window — no replay.
    push([at("rAncient", "succeeded", 10)])

    expect(events.map((e) => [e.kind, e.meta?.runId])).toEqual([
      ["workflowRun", "rA"],
      ["workflowRun", "rB"],
      ["success", "rA"],
      ["error", "rB"],
    ])
  })
})
