import { executeRadarReportTask } from "./radar-report-executor"
import { notify as centerNotify } from "@/lib/notifications/runtime"
import { runRadarReport, NoRadarModelError } from "@/lib/radar/radar-runner"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

jest.mock("@/lib/notifications/runtime", () => ({
  notify: jest.fn(async () => undefined),
}))
jest.mock("@/lib/radar/radar-runner", () => {
  class NoRadarModelError extends Error {}
  return { runRadarReport: jest.fn(), NoRadarModelError }
})
jest.mock("@cognia/logging", () => ({
  loggers: { scheduler: { info: jest.fn(), error: jest.fn() } },
}))

const mockRun = runRadarReport as jest.Mock
const mockCenterNotify = centerNotify as jest.Mock
const task = { id: "t1" } as ScheduledTask
const execution = { id: "e1" } as TaskExecution
const signal = new AbortController().signal

beforeEach(() => jest.clearAllMocks())

describe("executeRadarReportTask", () => {
  it("returns report metadata on success", async () => {
    mockRun.mockResolvedValue({ id: "r1", itemCount: 7 })
    const r = await executeRadarReportTask(task, execution, signal)
    expect(r.success).toBe(true)
    expect(r.output).toEqual({ itemCount: 7, reportId: "r1" })
    expect(mockRun).toHaveBeenCalledWith({ signal })
  })

  it("reports skipped when the runner returns null", async () => {
    mockRun.mockResolvedValue(null)
    const r = await executeRadarReportTask(task, execution, signal)
    expect(r.success).toBe(true)
    expect(r.output).toEqual({ skipped: true })
  })

  it("maps NoRadarModelError to a friendly message", async () => {
    mockRun.mockRejectedValue(new NoRadarModelError())
    const r = await executeRadarReportTask(task, execution, signal)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key/i)
  })

  it("fails immediately without invoking runRadarReport when already aborted (F22)", async () => {
    const controller = new AbortController()
    controller.abort("cancelled")
    const r = await executeRadarReportTask(task, execution, controller.signal)
    expect(r.success).toBe(false)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("notifies Unified Notification Center only when the scheduled report contains actionable suggestions (F6)", async () => {
    mockRun.mockResolvedValueOnce({ id: "r-empty", itemCount: 6, actions: [] })
    await executeRadarReportTask(task, execution, signal)
    expect(mockCenterNotify).not.toHaveBeenCalled()

    mockRun.mockResolvedValueOnce({
      id: "r-actionable",
      itemCount: 8,
      verdict: "Two overdue items need follow-up",
      actions: ["Reply to pending launch draft", "Resume paused goal"],
    })
    const res = await executeRadarReportTask(task, execution, signal)
    expect(res.success).toBe(true)
    expect(mockCenterNotify).toHaveBeenCalledTimes(1)
    expect(mockCenterNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "scheduler",
        dedupeKey: "radar-report:actionable:r-actionable",
        body: "Two overdue items need follow-up",
      }),
      expect.any(Object)
    )
  })
})
