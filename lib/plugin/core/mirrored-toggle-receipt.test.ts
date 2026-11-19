/** @jest-environment node */

import { mirrorViolations } from "@/lib/plugin/lifecycle/contract"

import {
  __resetPluginToggleSettlementForTests,
  isHostRefusal,
  PLUGIN_TOGGLE_FOLLOW_UP_SYNC_MS,
  settleMirroredPluginToggle,
  type SettlePluginToggleDeps,
} from "./mirrored-toggle-receipt"

function deps() {
  const scheduled: Array<{ run: () => void; ms: number }> = []
  const d: SettlePluginToggleDeps & { scheduled: typeof scheduled } = {
    scheduled,
    rewind: jest.fn(),
    pull: jest.fn(async () => []),
    schedule: jest.fn((run: () => void, ms: number) => {
      scheduled.push({ run, ms })
      return scheduled.length
    }),
    cancel: jest.fn(),
  }
  return d
}

beforeEach(() => __resetPluginToggleSettlementForTests())

describe("isHostRefusal", () => {
  it("tells the Host's answer from a failure to reach it", () => {
    expect(isHostRefusal({ code: "validation_failed" })).toBe(true)
    expect(isHostRefusal({ code: "server_error" })).toBe(true)
    expect(isHostRefusal({ code: "network" })).toBe(false)
    expect(isHostRefusal({ code: "timeout" })).toBe(false)
    expect(isHostRefusal(new Error("carrier closed"))).toBe(false)
    expect(isHostRefusal(null)).toBe(false)
  })
})

describe("settleMirroredPluginToggle", () => {
  it("reads the Host's rows back after an applied toggle, once per burst", async () => {
    const d = deps()
    await settleMirroredPluginToggle({ ok: true }, d)
    await settleMirroredPluginToggle({ ok: true }, d)
    expect(d.cancel).toHaveBeenCalledWith(1)
    expect(d.rewind).not.toHaveBeenCalled()
    expect(d.scheduled.at(-1)?.ms).toBe(PLUGIN_TOGGLE_FOLLOW_UP_SYNC_MS)
    d.scheduled.at(-1)?.run()
    expect(d.pull).toHaveBeenCalledTimes(1)
  })

  it("rewinds and reads the table again when the Host refused it", async () => {
    const d = deps()
    await settleMirroredPluginToggle({ ok: false, error: { code: "server_error" } }, d)
    expect(d.rewind).toHaveBeenCalledTimes(1)
    d.scheduled[0]?.run()
    expect(d.pull).toHaveBeenCalledTimes(1)
  })

  it("leaves a toggle the Host never received queued", async () => {
    const d = deps()
    await settleMirroredPluginToggle({ ok: false, error: { code: "network" } }, d)
    expect(d.rewind).not.toHaveBeenCalled()
    expect(d.schedule).not.toHaveBeenCalled()
  })
})

describe("ADR-0258 mirror clause host-answer-wins", () => {
  it.each([
    ["applied", { ok: true } as const],
    ["refused", { ok: false, error: { code: "validation_failed" } } as const],
  ])("reads the rows back once the Host answered (%s)", async (_label, answer) => {
    const d = deps()
    await settleMirroredPluginToggle(answer, d)
    d.scheduled.at(-1)?.run()
    expect(
      mirrorViolations({
        packageOperations: 0,
        localRuntimeCalls: 0,
        reportedBeforeAnswer: "queued",
        readBackAfterAnswer: (d.pull as jest.Mock).mock.calls.length === 1,
      })
    ).toEqual([])
  })
})
