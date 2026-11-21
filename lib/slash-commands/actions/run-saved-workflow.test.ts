import { matchWorkflows, handleRunWorkflow } from "./run-saved-workflow"
import type { WorkflowRow } from "@/types/workflow/visual"
import type { SlashContext } from "../builtin"

const listWorkflows = jest.fn<Promise<WorkflowRow[]>, []>()
const runWorkflow = jest.fn((..._a: unknown[]) =>
  Promise.resolve({ runId: "r1", status: "succeeded" as const })
)

jest.mock("@/lib/db/workflows", () => ({
  listWorkflows: () => listWorkflows(),
}))
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => runWorkflow(...a),
}))
// The command reads through the workflow module's `fresh-workflows` reader
// (the playbooks module provides the port), never the stored row directly.
type Fresh = import("@/types/modules/ports/fresh-workflows").FreshWorkflowRead
const readFreshWorkflow = jest.fn<Promise<Fresh>, [string]>()
jest.mock("@/lib/workflow/library/fresh-workflow", () => ({
  readFreshWorkflow: (id: string) => readFreshWorkflow(id),
}))

function wf(id: string, name: string, nodes = 1): WorkflowRow {
  return {
    id,
    name,
    nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })),
    edges: [],
  } as unknown as WorkflowRow
}

function makeCtx(args: string, chatStatus: SlashContext["chatStatus"] = "idle"): SlashContext {
  return {
    args,
    activeSessionId: "s1",
    chatStatus,
    currentPermissionMode: null,
    startNewSession: jest.fn(),
    openSettings: jest.fn(),
    setPermissionMode: jest.fn(),
    pushSystemMessage: jest.fn(),
  }
}

beforeEach(() => {
  listWorkflows.mockReset()
  runWorkflow.mockClear()
  readFreshWorkflow.mockReset()
  readFreshWorkflow.mockImplementation(async (id) => {
    const rows = await listWorkflows()
    const row = rows.find((candidate) => candidate.id === id)
    return row ? { status: "ready", workflow: row, dormantSteps: 0 } : { status: "not-found" }
  })
})

describe("matchWorkflows", () => {
  const list = [wf("id-1", "Daily Report"), wf("id-2", "Daily Digest"), wf("id-3", "Cleanup")]
  it("matches by exact id", () => {
    expect(matchWorkflows(list, "id-2").map((w) => w.id)).toEqual(["id-2"])
  })
  it("matches by exact name (case-insensitive) over substring", () => {
    expect(matchWorkflows(list, "cleanup").map((w) => w.id)).toEqual(["id-3"])
  })
  it("falls back to name substring (possibly multiple)", () => {
    expect(matchWorkflows(list, "daily").map((w) => w.id)).toEqual(["id-1", "id-2"])
  })
  it("returns empty for blank query", () => {
    expect(matchWorkflows(list, "  ")).toEqual([])
  })
})

describe("handleRunWorkflow", () => {
  it("lists workflows when no argument is given", async () => {
    listWorkflows.mockResolvedValue([wf("id-1", "Daily Report")])
    const ctx = makeCtx("")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).not.toHaveBeenCalled()
    expect((ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]).toContain("Daily Report")
  })

  it("reports no match", async () => {
    listWorkflows.mockResolvedValue([wf("id-1", "Daily Report")])
    const ctx = makeCtx("nope")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).not.toHaveBeenCalled()
    expect((ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]).toContain("No workflow matches")
  })

  it("reports ambiguity for multiple matches", async () => {
    listWorkflows.mockResolvedValue([wf("id-1", "Daily Report"), wf("id-2", "Daily Digest")])
    const ctx = makeCtx("daily")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).not.toHaveBeenCalled()
    expect((ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]).toContain("ambiguous")
  })

  it("runs a unique match with source 'chat' and pushes a result chip", async () => {
    listWorkflows.mockResolvedValue([wf("id-1", "Daily Report")])
    const ctx = makeCtx("Daily Report")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).toHaveBeenCalledTimes(1)
    const arg = runWorkflow.mock.calls[0][0] as unknown as { triggeredBy: { source: string } }
    expect(arg.triggeredBy.source).toBe("chat")
    const chip = (ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]
    expect(chip).toMatchObject({ kind: "slash-result", commandId: "workflow" })
  })

  it("runs the recompiled graph of a playbook-derived workflow, not the stored copy", async () => {
    const stored = wf("wf_playbook_review", "Review")
    const recompiled = wf("wf_playbook_review", "Review", 3)
    listWorkflows.mockResolvedValue([stored])
    readFreshWorkflow.mockResolvedValue({ status: "ready", workflow: recompiled, dormantSteps: 0 })
    await handleRunWorkflow(makeCtx("Review"))
    expect(readFreshWorkflow).toHaveBeenCalledWith("wf_playbook_review")
    expect((runWorkflow.mock.calls[0][0] as { workflow: WorkflowRow }).workflow).toBe(recompiled)
  })

  it("refuses a playbook-derived workflow whose playbook no longer compiles", async () => {
    const stored = {
      ...wf("wf_playbook_review", "Review"),
      derivedFrom: { kind: "playbook", skillId: "review" },
    } as WorkflowRow
    listWorkflows.mockResolvedValue([stored])
    readFreshWorkflow.mockResolvedValue({ status: "source-unavailable", workflow: stored })
    const ctx = makeCtx("Review")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).not.toHaveBeenCalled()
    expect((ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]).toContain("no longer compiles")
  })

  it("refuses while the playbook has steps this version cannot run", async () => {
    listWorkflows.mockResolvedValue([wf("wf_playbook_sweep", "Sweep")])
    readFreshWorkflow.mockResolvedValue({
      status: "ready",
      workflow: wf("wf_playbook_sweep", "Sweep"),
      dormantSteps: 1,
    })
    const ctx = makeCtx("Sweep")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).not.toHaveBeenCalled()
    expect((ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]).toContain("not runnable")
  })

  it("refuses while a turn is streaming", async () => {
    const ctx = makeCtx("Daily Report", "streaming")
    await handleRunWorkflow(ctx)
    expect(listWorkflows).not.toHaveBeenCalled()
    expect(runWorkflow).not.toHaveBeenCalled()
  })
})
