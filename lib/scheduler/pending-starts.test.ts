import type { ScheduledTask } from "@/types/scheduler"
import {
  MAX_PENDING_STARTS,
  decideRecoveredSlot,
  parsePendingStarts,
  serializePendingStarts,
  withPendingStart,
  withdrawnStartReason,
  withoutPendingStarts,
  type PendingRetry,
  type PendingSlotClaim,
} from "./pending-starts"

const SLOT = new Date("2026-11-17T09:00:00.000Z")

const claim = (overrides: Partial<PendingSlotClaim> = {}): PendingSlotClaim => ({
  kind: "slot",
  executionId: `occ-t-${SLOT.getTime()}`,
  scheduledFor: SLOT,
  triggerSource: "schedule",
  claimedAt: SLOT,
  ...overrides,
})

const retry = (overrides: Partial<PendingRetry> = {}): PendingRetry => ({
  kind: "retry",
  executionId: "retry-1",
  failedExecutionId: "run-1",
  attempt: 1,
  availableAt: new Date(SLOT.getTime() + 5_000),
  ...overrides,
})

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t",
    name: "t",
    type: "test",
    status: "active",
    trigger: { type: "interval", intervalMs: 60_000 },
    config: { maxRetries: 0, retryDelay: 1_000, timeout: 30_000, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: false, onError: false },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: SLOT,
    updatedAt: SLOT,
    ...overrides,
  } as ScheduledTask
}

const everyMinute = (slot: Date) => new Date(slot.getTime() + 60_000)

describe("pending starts column", () => {
  it("round-trips claims and retries, flags included", () => {
    const starts = [
      claim({ triggerSource: "catch-up", deferNextRunUpdate: true }),
      retry({ scheduledSlotClaimed: true, deferNextRunUpdate: true }),
    ]
    expect(parsePendingStarts(serializePendingStarts(starts))).toEqual(starts)
  })

  it("has no column at all when nothing is pending", () => {
    expect(serializePendingStarts([])).toBeUndefined()
    expect(withoutPendingStarts(serializePendingStarts([claim()]), () => true)).toBeUndefined()
  })

  it("drops what it cannot read instead of failing the task", () => {
    expect(parsePendingStarts("{not json")).toEqual([])
    expect(parsePendingStarts(JSON.stringify({ kind: "slot" }))).toEqual([])
    const valid = JSON.parse(serializePendingStarts([claim()])!) as unknown[]
    const column = JSON.stringify([
      ...valid,
      { kind: "slot", executionId: "x", scheduledFor: "nope", triggerSource: "schedule" },
      { kind: "retry", executionId: "y", failedExecutionId: "z", attempt: 0, availableAt: SLOT },
      { kind: "slot", executionId: "w", scheduledFor: SLOT, triggerSource: "run-now" },
      { kind: "other", executionId: "v" },
    ])
    expect(parsePendingStarts(column)).toEqual([claim()])
  })

  it("keeps one entry per execution id, the newest", () => {
    const column = withPendingStart(serializePendingStarts([retry()]), retry({ attempt: 2 }))
    expect(parsePendingStarts(column)).toEqual([retry({ attempt: 2 })])
  })

  it("removes only the entries asked for", () => {
    const column = serializePendingStarts([claim(), retry()])
    expect(parsePendingStarts(withoutPendingStarts(column, (s) => s.kind === "retry"))).toEqual([
      claim(),
    ])
  })

  it("bounds a runaway list, oldest first", () => {
    const many = Array.from({ length: MAX_PENDING_STARTS + 3 }, (_, i) =>
      retry({ executionId: `r-${i}` })
    )
    const kept = parsePendingStarts(serializePendingStarts(many))
    expect(kept).toHaveLength(MAX_PENDING_STARTS)
    expect(kept[0].executionId).toBe("r-3")
  })
})

describe("decideRecoveredSlot", () => {
  it("runs a slot whose next one has not come yet, whatever the missed-run policy", () => {
    const now = new Date(SLOT.getTime() + 30_000)
    expect(
      decideRecoveredSlot({ task: task(), claim: claim(), now, nextAfter: everyMinute })
    ).toEqual({ run: true })
  })

  it("runs a one-shot's claimed slot, which has no next one", () => {
    const now = new Date(SLOT.getTime() + 3_600_000)
    expect(
      decideRecoveredSlot({ task: task(), claim: claim(), now, nextAfter: () => undefined })
    ).toEqual({ run: true })
  })

  it("skips a slot the schedule has moved past unless the task runs missed slots", () => {
    const now = new Date(SLOT.getTime() + 10 * 60_000)
    expect(
      decideRecoveredSlot({ task: task(), claim: claim(), now, nextAfter: everyMinute })
    ).toMatchObject({ run: false, terminalReason: "missed-run-skipped" })
    expect(
      decideRecoveredSlot({
        task: task({ config: { ...task().config, runMissedOnStartup: true } }),
        claim: claim(),
        now,
        nextAfter: everyMinute,
      })
    ).toEqual({ run: true })
  })

  it("skips a missed slot older than the catch-up window", () => {
    const now = new Date(SLOT.getTime() + 10 * 60_000)
    expect(
      decideRecoveredSlot({
        task: task({
          config: { ...task().config, runMissedOnStartup: true, catchupWindowMs: 60_000 },
        }),
        claim: claim(),
        now,
        nextAfter: everyMinute,
      })
    ).toMatchObject({ run: false, terminalReason: "catchup-window-expired" })
  })
})

describe("withdrawnStartReason", () => {
  it("names why the task stopped taking runs", () => {
    expect(withdrawnStartReason(null)).toBe("user-cancelled")
    expect(withdrawnStartReason(task({ status: "paused" }))).toBe("user-cancelled")
    expect(
      withdrawnStartReason(task({ status: "paused", lastTerminalReason: "auto-paused" }))
    ).toBe("auto-paused")
    expect(
      withdrawnStartReason(task({ status: "expired", lastTerminalReason: "max-runs-reached" }))
    ).toBe("max-runs-reached")
    expect(withdrawnStartReason(task({ status: "expired" }))).toBe("ended")
    expect(
      withdrawnStartReason(
        task({
          status: "disabled",
          owner: { kind: "remote-host", hostId: "h", hostLabel: "Box", movedAt: 1 },
        } as Partial<ScheduledTask>)
      )
    ).toBe("owned-elsewhere")
  })
})
