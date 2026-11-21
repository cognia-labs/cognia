/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const runWorkflow = jest.fn((..._a: unknown[]) =>
  Promise.resolve({ runId: "r1", status: "succeeded" as const })
)
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => runWorkflow(...a),
}))
const dispatchTrigger = jest.fn(
  async (
    ..._args: Parameters<typeof import("@/lib/workflow/runtime/trigger-bridge").dispatchTrigger>
  ) => undefined
)
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: (...a: Parameters<typeof dispatchTrigger>) => dispatchTrigger(...a),
}))

type Fresh = Awaited<
  ReturnType<typeof import("@/lib/playbooks/derived-workflow").loadFreshWorkflow>
>
const loadFreshWorkflow = jest.fn<Promise<Fresh>, [string]>()
jest.mock("@/lib/playbooks/derived-workflow", () => ({
  loadFreshWorkflow: (id: string) => loadFreshWorkflow(id),
}))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }))

import { WorkflowRunDialog, parseRunPayload } from "./workflow-run-dialog"
import type { WorkflowRow } from "@/types/workflow/visual"

const workflow = {
  id: "wf-1",
  name: "My Flow",
  nodes: [],
  edges: [],
} as unknown as WorkflowRow

beforeEach(() => {
  loadFreshWorkflow.mockReset()
  loadFreshWorkflow.mockImplementation(async () => ({ status: "ready", workflow, dormant: [] }))
  runWorkflow.mockClear()
  dispatchTrigger.mockClear()
  toastSuccess.mockClear()
})

describe("parseRunPayload", () => {
  it("treats empty input as {}", () => {
    expect(parseRunPayload("   ")).toEqual({ ok: true, value: {} })
  })
  it("parses valid JSON", () => {
    expect(parseRunPayload('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })
  it("rejects invalid JSON", () => {
    expect(parseRunPayload("{not json")).toEqual({ ok: false })
  })
})

describe("WorkflowRunDialog", () => {
  it("runs the workflow with triggeredBy.source 'desktop' on submit", async () => {
    render(<WorkflowRunDialog workflow={workflow} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("workflow-run-submit"))
    await waitFor(() => expect(runWorkflow).toHaveBeenCalledTimes(1))
    const arg = runWorkflow.mock.calls[0][0] as unknown as {
      triggeredBy: { source: string }
      trigger: { kind: string; payload: unknown }
    }
    expect(arg.triggeredBy.source).toBe("desktop")
    expect(arg.trigger.kind).toBe("trigger.manual")
    expect(arg.trigger.payload).toEqual({})
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("blocks submit and shows an error on invalid JSON", () => {
    render(<WorkflowRunDialog workflow={workflow} open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByTestId("workflow-run-payload"), {
      target: { value: "{bad" },
    })
    fireEvent.click(screen.getByTestId("workflow-run-submit"))
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(screen.getByTestId("workflow-run-error")).toBeInTheDocument()
  })

  it("passes a parsed JSON payload through", async () => {
    render(<WorkflowRunDialog workflow={workflow} open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByTestId("workflow-run-payload"), {
      target: { value: '{"x":42}' },
    })
    fireEvent.click(screen.getByTestId("workflow-run-submit"))
    await waitFor(() => expect(runWorkflow).toHaveBeenCalled())
    const arg = runWorkflow.mock.calls[0][0] as unknown as { trigger: { payload: unknown } }
    expect(arg.trigger.payload).toEqual({ x: 42 })
  })

  it("routes a published workflow through the placement-aware trigger bridge", async () => {
    const published = {
      ...workflow,
      published: { deploymentId: "deployment-1", versionId: "version-1" },
    } as WorkflowRow
    loadFreshWorkflow.mockImplementation(async () => ({
      status: "ready",
      workflow: published,
      dormant: [],
    }))
    render(<WorkflowRunDialog workflow={published} open onOpenChange={() => {}} />)

    fireEvent.click(screen.getByTestId("workflow-run-submit"))

    await waitFor(() =>
      expect(dispatchTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: "wf-1", kind: "trigger.manual" }),
        { triggeredBy: { source: "desktop" } }
      )
    )
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it("runs the graph a playbook compiles to now, not the stale library row", async () => {
    const stale = {
      ...workflow,
      derivedFrom: { kind: "playbook", skillId: "review" },
    } as WorkflowRow
    const recompiled = { ...stale, nodes: [{ id: "pb_new" }] } as unknown as WorkflowRow
    loadFreshWorkflow.mockImplementation(async () => ({
      status: "ready",
      workflow: recompiled,
      dormant: [],
    }))
    render(<WorkflowRunDialog workflow={stale} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("workflow-run-submit"))

    await waitFor(() => expect(runWorkflow).toHaveBeenCalledTimes(1))
    expect(loadFreshWorkflow).toHaveBeenCalledWith("wf-1")
    expect((runWorkflow.mock.calls[0][0] as unknown as { workflow: WorkflowRow }).workflow).toBe(
      recompiled
    )
  })

  it("refuses to run a playbook workflow whose source no longer compiles", async () => {
    const stale = {
      ...workflow,
      derivedFrom: { kind: "playbook", skillId: "review" },
    } as WorkflowRow
    loadFreshWorkflow.mockImplementation(async () => ({
      status: "source-unavailable",
      workflow: stale,
      problem: { status: "missing" },
    }))
    render(<WorkflowRunDialog workflow={stale} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("workflow-run-submit"))

    expect(await screen.findByTestId("workflow-run-error")).toHaveTextContent(
      'notRunnable:{"skillId":"review"}'
    )
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })

  it("refuses to run while the playbook has steps this version cannot run", async () => {
    loadFreshWorkflow.mockImplementation(async () => ({
      status: "ready",
      workflow,
      dormant: [{ nodeId: "pb_s", skillId: "sweep", stepId: "s", reason: "pattern-core-pending" }],
    }))
    render(<WorkflowRunDialog workflow={workflow} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("workflow-run-submit"))

    expect(await screen.findByTestId("workflow-run-error")).toHaveTextContent(
      'dormantNotRunnable:{"count":1}'
    )
    expect(runWorkflow).not.toHaveBeenCalled()
  })
})
