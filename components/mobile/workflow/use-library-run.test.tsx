/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import type { LibraryRunOutcome } from "@/lib/workflow/remote/library-run"

const runWorkflowFromLibrary = jest.fn<Promise<LibraryRunOutcome>, unknown[]>()
jest.mock("@/lib/workflow/remote/library-run", () => ({
  runWorkflowFromLibrary: (...a: unknown[]) => runWorkflowFromLibrary(...a),
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

const toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), message: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toast.success(...a),
    error: (...a: unknown[]) => toast.error(...a),
    warning: (...a: unknown[]) => toast.warning(...a),
    message: (...a: unknown[]) => toast.message(...a),
  },
}))
const impact = jest.fn(async () => ({ kind: "ok" }))
jest.mock("@/lib/capacitor/haptics", () => ({ impact: () => impact() }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { useLibraryRun } from "./use-library-run"

const workflow = { id: "wf_1", name: "Digest" }

beforeEach(() => {
  runWorkflowFromLibrary.mockReset()
  push.mockReset()
  impact.mockClear()
  for (const fn of Object.values(toast)) fn.mockReset()
})

async function run(outcome: LibraryRunOutcome | Error) {
  if (outcome instanceof Error) runWorkflowFromLibrary.mockRejectedValueOnce(outcome)
  else runWorkflowFromLibrary.mockResolvedValueOnce(outcome)
  const { result } = renderHook(() => useLibraryRun())
  let returned: LibraryRunOutcome | null = null
  await act(async () => {
    returned = await result.current(workflow)
  })
  return returned
}

describe("useLibraryRun", () => {
  it.each([
    [{ status: "queued" } as const, "success", 'queued:{"name":"Digest"}'],
    [{ status: "already-queued" } as const, "message", 'alreadyQueued:{"name":"Digest"}'],
    [{ status: "not-published" } as const, "warning", 'notPublished:{"name":"Digest"}'],
    [
      { status: "handed-off", targetRef: "host-b" } as const,
      "success",
      'handedOff:{"name":"Digest"}',
    ],
    [
      { status: "refused", reason: "input-schema-violation", detail: "missing q" } as const,
      "error",
      'refused:{"name":"Digest","detail":"missing q"}',
    ],
  ])("says what happened (%o)", async (outcome, channel, text) => {
    await expect(run(outcome)).resolves.toEqual(outcome)
    expect(runWorkflowFromLibrary).toHaveBeenCalledWith(workflow)
    expect(toast[channel as keyof typeof toast]).toHaveBeenCalledWith(text)
  })

  it("offers to open a run that started on this phone", async () => {
    await run({ status: "started", workflowId: "wf_1", runId: "run_9" })
    expect(impact).toHaveBeenCalledTimes(1)
    const [text, options] = toast.success.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ]
    expect(text).toBe('started:{"name":"Digest"}')
    expect(options.action.label).toBe("openRun")
    options.action.onClick()
    expect(push).toHaveBeenCalledWith("/workflows/run?id=wf_1&runId=run_9")
  })

  it("reports a failure to start and answers null", async () => {
    await expect(run(new Error("queue closed"))).resolves.toBeNull()
    expect(toast.error).toHaveBeenCalledWith('failed:{"message":"queue closed"}')
  })
})
