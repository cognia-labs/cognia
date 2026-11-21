const mockRecentRunSpend = jest.fn()
const mockBookedUsdByRun = jest.fn()

jest.mock("./store-provider", () => ({
  currentFusionStore: async () => ({ recentRunSpend: mockRecentRunSpend }),
}))
jest.mock("@/lib/db/session-usage", () => ({
  bookedUsdByRun: (ids: readonly string[]) => mockBookedUsdByRun(ids),
}))

import {
  UNBOOKED_RUN_LOOKBACK_MS,
  UNBOOKED_SEAL_WINDOW_MS,
  unbookedFusionSpendMicrousd,
} from "./unbooked-spend"

const NOW = 1_800_000_000_000

beforeEach(() => {
  mockRecentRunSpend.mockReset()
  mockBookedUsdByRun.mockReset().mockResolvedValue(new Map())
})

describe("unbookedFusionSpendMicrousd", () => {
  it("counts what each recent run spent beyond what the account booked for it", async () => {
    mockRecentRunSpend.mockResolvedValue([
      { runId: "settled-unbooked", spentMicrousd: 1_000_000 },
      { runId: "partly-booked", spentMicrousd: 500_000 },
      { runId: "over-booked", spentMicrousd: 100_000 },
    ])
    mockBookedUsdByRun.mockResolvedValue(
      new Map([
        ["partly-booked", 0.2],
        ["over-booked", 0.3],
      ])
    )
    await expect(unbookedFusionSpendMicrousd(NOW)).resolves.toBe(1_300_000)
    expect(mockRecentRunSpend).toHaveBeenCalledWith(
      NOW - UNBOOKED_RUN_LOOKBACK_MS,
      NOW - UNBOOKED_SEAL_WINDOW_MS
    )
    expect(mockBookedUsdByRun).toHaveBeenCalledWith([
      "settled-unbooked",
      "partly-booked",
      "over-booked",
    ])
  })

  it("reads no usage rows when no run spent anything recently", async () => {
    mockRecentRunSpend.mockResolvedValue([])
    await expect(unbookedFusionSpendMicrousd(NOW)).resolves.toBe(0)
    expect(mockBookedUsdByRun).not.toHaveBeenCalled()
  })
})
