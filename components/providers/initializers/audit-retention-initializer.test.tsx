import { StrictMode } from "react"
import { act, render } from "@testing-library/react"

import { startAuditRetentionSweeper } from "@/lib/automation/audit-retention"
import { AuditRetentionInitializer } from "./audit-retention-initializer"

jest.mock("@/lib/automation/audit-retention", () => ({
  startAuditRetentionSweeper: jest.fn(),
}))

const startSweeper = jest.mocked(startAuditRetentionSweeper)

beforeEach(() => startSweeper.mockReset())

it("disposes the active sweeper when unmounted", async () => {
  const dispose = jest.fn()
  startSweeper.mockResolvedValue(dispose)
  const view = render(<AuditRetentionInitializer />)
  await act(async () => {})
  expect(startSweeper).toHaveBeenCalledTimes(1)
  expect(dispose).not.toHaveBeenCalled()
  view.unmount()
  expect(dispose).toHaveBeenCalledTimes(1)
})

it("disposes a sweeper that finishes starting after unmount", async () => {
  let finish!: (dispose: () => void) => void
  startSweeper.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const dispose = jest.fn()
  const view = render(<AuditRetentionInitializer />)
  view.unmount()
  await act(async () => {
    finish(dispose)
  })
  expect(dispose).toHaveBeenCalledTimes(1)
})

it("keeps the current StrictMode effect active and disposes both startups", async () => {
  const finishes: Array<(dispose: () => void) => void> = []
  startSweeper.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(resolve)
      })
  )
  const view = render(
    <StrictMode>
      <AuditRetentionInitializer />
    </StrictMode>
  )
  expect(startSweeper).toHaveBeenCalledTimes(2)
  const obsoleteDispose = jest.fn()
  const activeDispose = jest.fn()
  await act(async () => {
    finishes[1]!(activeDispose)
    finishes[0]!(obsoleteDispose)
  })
  expect(obsoleteDispose).toHaveBeenCalledTimes(1)
  expect(activeDispose).not.toHaveBeenCalled()
  view.unmount()
  expect(activeDispose).toHaveBeenCalledTimes(1)
  expect(obsoleteDispose).toHaveBeenCalledTimes(1)
})
