/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { WorkspaceAcquisition } from "@/lib/task-workspace/types"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messages = require("../../i18n/messages/en/performance.json").acquisitions
    return (key: string, values?: Record<string, string | number>) => {
      const value = key.split(".").reduce((current, part) => current?.[part], messages)
      if (typeof value !== "string") throw new Error(`Missing translation: ${key}`)
      return Object.entries(values ?? {}).reduce(
        (text, [name, replacement]) => text.replace(`{${name}}`, String(replacement)),
        value
      )
    }
  },
  useFormatter: () => ({ dateTime: (date: Date) => `at ${date.getTime()}` }),
}))

const mockList = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  listWorkspaceAcquisitions: (...args: unknown[]) => mockList(...args),
}))

import { PerfRecentAcquisitions } from "./perf-recent-acquisitions"

const succeeded: WorkspaceAcquisition = {
  acquisitionId: "a1",
  kind: "run",
  subject: "/Users/me/repo",
  key: "run:r1",
  startedAt: 1000,
  totalMs: 2500,
  ok: true,
  failureClass: null,
  error: null,
  phases: [
    {
      phase: "fetch",
      startedMs: 0,
      durationMs: 0,
      ok: true,
      failureClass: null,
      attempt: 1,
      note: "recent",
    },
    {
      phase: "worktreeAdd",
      startedMs: 5,
      durationMs: 2000,
      ok: true,
      failureClass: null,
      attempt: 1,
      note: null,
    },
  ],
}

const failed: WorkspaceAcquisition = {
  acquisitionId: "a2",
  kind: "bundle",
  subject: "https://github.com/o/r.git",
  key: "bundle:session:s1",
  startedAt: 2000,
  totalMs: 180000,
  ok: false,
  failureClass: "timedOut",
  error: "refresh remote default failed: timed out after 180s",
  phases: [
    {
      phase: "fetch",
      startedMs: 0,
      durationMs: 1000,
      ok: false,
      failureClass: "network",
      attempt: 1,
      note: null,
    },
    {
      phase: "fetch",
      startedMs: 1500,
      durationMs: 178000,
      ok: false,
      failureClass: "timedOut",
      attempt: 2,
      note: null,
    },
  ],
}

beforeEach(() => mockList.mockReset())

it("lists each acquisition with its steps, and why a failed one failed", async () => {
  mockList.mockResolvedValue({ items: [succeeded, failed] })
  render(<PerfRecentAcquisitions />)

  const rows = await screen.findAllByRole("row")
  expect(mockList).toHaveBeenCalledWith({ pageSize: 20 })
  // Header plus two acquisitions.
  expect(rows).toHaveLength(3)
  const ok = within(rows[1])
  expect(ok.getByText("Task run")).toBeInTheDocument()
  expect(ok.getByText("Succeeded")).toBeInTheDocument()
  expect(ok.getByText("Fetch 0 ms · recently fetched")).toBeInTheDocument()
  expect(ok.getByText("Worktree 2.00 s")).toBeInTheDocument()

  const bad = within(rows[2])
  expect(bad.getByText("Bundle")).toBeInTheDocument()
  expect(bad.getByText("Timed out")).toBeInTheDocument()
  expect(bad.getByText(failed.error!)).toBeInTheDocument()
  expect(bad.getByText("Fetch 1.00 s · Network error")).toBeInTheDocument()
  expect(bad.getByText("Fetch 178.00 s · attempt 2 · Timed out")).toBeInTheDocument()
})

it("reads an unknown class or kind from a newer host without breaking", async () => {
  mockList.mockResolvedValue({
    items: [{ ...failed, kind: "mirrorWarmup", failureClass: "quotaExceeded", phases: [] }],
  })
  render(<PerfRecentAcquisitions />)
  expect(await screen.findByText("mirrorWarmup")).toBeInTheDocument()
  expect(screen.getByText("Failed")).toBeInTheDocument()
})

it("says so when nothing has been recorded", async () => {
  mockList.mockResolvedValue({ items: [] })
  render(<PerfRecentAcquisitions />)
  expect(await screen.findByText("No acquisitions recorded yet.")).toBeInTheDocument()
})

it("reports a host it could not read and reads again on refresh", async () => {
  mockList.mockRejectedValueOnce(new Error("unknown command"))
  render(<PerfRecentAcquisitions />)
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not read acquisitions from the host."
  )

  mockList.mockResolvedValueOnce({ items: [succeeded] })
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await waitFor(() => expect(screen.getByText("Task run")).toBeInTheDocument())
  expect(mockList).toHaveBeenCalledTimes(2)
})
