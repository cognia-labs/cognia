/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))

import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

import { useHostRunEvents, type HostRunEventsPage } from "./use-host-run-events"

function event(sequence: number): WorkflowRunEventRow {
  return { id: `e${sequence}`, runId: "run_1", ts: sequence, sequence, type: "run_log" }
}

function run(status: WorkflowRunRow["status"]): WorkflowRunRow {
  return {
    id: "run_1",
    workflowId: "wf_1",
    status,
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1,
    workflowSnapshot: {} as WorkflowRunRow["workflowSnapshot"],
  }
}

function page(
  events: WorkflowRunEventRow[],
  status: WorkflowRunRow["status"],
  terminal: boolean
): HostRunEventsPage {
  return {
    run: run(status),
    events,
    nextSequence: events.at(-1)?.sequence ?? 0,
    terminal,
  }
}

describe("useHostRunEvents", () => {
  it("reads nothing and reports nothing while disabled", () => {
    const fetchPage = jest.fn()
    const { result } = renderHook(() => useHostRunEvents("run_1", false, { fetchPage }))
    expect(fetchPage).not.toHaveBeenCalled()
    expect(result.current).toEqual({ run: undefined, events: [], error: null })
  })

  it("pages through a full log at once, then polls a live run until it ends", async () => {
    const fetchPage = jest
      .fn<Promise<HostRunEventsPage>, [{ runId: string; afterSequence: number; limit: number }]>()
      // A full page: the next one is read straight away.
      .mockResolvedValueOnce(page([event(1), event(2)], "running", false))
      // Still live, nothing new.
      .mockResolvedValueOnce(page([], "running", false))
      // A repeated event (a read raced an append) is not added twice.
      .mockResolvedValueOnce(page([event(2), event(3)], "succeeded", true))
    const { result } = renderHook(() =>
      useHostRunEvents("run_1", true, { fetchPage, pageSize: 2, pollMs: 5 })
    )

    await waitFor(() => expect(result.current.run?.status).toBe("succeeded"))
    expect(result.current.events.map((e) => e.sequence)).toEqual([1, 2, 3])
    expect(fetchPage.mock.calls.map(([request]) => request.afterSequence)).toEqual([0, 2, 2])
    // The run is over: no more reads.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it("reports a run the Host does not have as null and stops", async () => {
    const fetchPage = jest.fn(async () => ({
      run: null,
      events: [],
      nextSequence: 0,
      terminal: true,
    }))
    const { result } = renderHook(() => useHostRunEvents("run_1", true, { fetchPage, pollMs: 5 }))
    await waitFor(() => expect(result.current.run).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it("keeps what it has and retries while the Host is unreachable", async () => {
    let reconnect: () => void = () => {}
    const back = new Promise<void>((resolve) => (reconnect = resolve))
    const fetchPage = jest
      .fn<Promise<HostRunEventsPage>, unknown[]>()
      .mockResolvedValueOnce(page([event(1)], "running", false))
      .mockRejectedValueOnce(new Error("offline"))
      // The retry hangs until the Host is back, so the error stays visible.
      .mockImplementationOnce(async () => {
        await back
        return page([event(2)], "succeeded", true)
      })
    const { result } = renderHook(() => useHostRunEvents("run_1", true, { fetchPage, pollMs: 5 }))

    await waitFor(() => expect(result.current.error).toBe("offline"))
    expect(result.current.events.map((e) => e.sequence)).toEqual([1])
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3))
    reconnect()
    await waitFor(() => expect(result.current.run?.status).toBe("succeeded"))
    expect(result.current.error).toBeNull()
    expect(result.current.events.map((e) => e.sequence)).toEqual([1, 2])
  })
})
