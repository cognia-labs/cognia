import { runRadarReport, NoRadarModelError } from "./radar-runner"
import { getSettings } from "@/lib/db/settings"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { collectRadarItems } from "./collect"
import { generateRadarReport } from "./generate"
import { getLatestRadarReport, saveRadarReport, pruneRadarReports } from "@/lib/db/radar-reports"
import type { RadarDataItem } from "@/types/radar"

jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/ai/generation/utility-client", () => ({ buildUtilityLlmClient: jest.fn() }))
jest.mock("./collect", () => ({
  ...jest.requireActual("./collect"),
  collectRadarItems: jest.fn(),
}))
jest.mock("./generate", () => ({ generateRadarReport: jest.fn() }))
jest.mock("@/lib/db/radar-reports", () => {
  class RadarAccountChangedError extends Error {
    readonly code = "radar_account_changed"
  }
  return {
    getLatestRadarReport: jest.fn(),
    saveRadarReport: jest.fn(),
    pruneRadarReports: jest.fn(),
    RadarAccountChangedError,
  }
})

const mockGetSettings = getSettings as jest.Mock
const mockBuildClient = buildUtilityLlmClient as jest.Mock
const mockCollect = collectRadarItems as jest.Mock
const mockGenerate = generateRadarReport as jest.Mock
const mockLatest = getLatestRadarReport as jest.Mock
const mockSave = saveRadarReport as jest.Mock
const mockPrune = pruneRadarReports as jest.Mock

const NOW = 100 * 86_400_000

function items(n: number): RadarDataItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    text: `t${i}`,
    source: "memory" as const,
    at: NOW,
  }))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({
    attentionRadar: { enabled: true, intervalDays: 3, windowDays: 14 },
  })
  mockBuildClient.mockReturnValue({ complete: jest.fn() })
  mockLatest.mockResolvedValue(undefined)
  mockGenerate.mockResolvedValue({
    verdict: "v",
    atAGlance: [],
    infoDiet: "",
    subconscious: "",
    graveyard: [],
    blindSpots: "",
    actions: [],
    topicCloud: [],
  })
})

describe("runRadarReport", () => {
  it("blocks automatic runs with a stale schedule while retaining explicit manual runs", async () => {
    mockGetSettings.mockResolvedValue({ attentionRadar: { enabled: false } })
    expect(await runRadarReport()).toBeNull()
    expect(mockCollect).not.toHaveBeenCalled()
    mockCollect.mockResolvedValue(items(6))
    const report = await runRadarReport({ force: true })
    expect(report?.sources).toHaveLength(6)
    expect(report?.sources?.[0]).not.toHaveProperty("text")
  })
  it("generates + persists a report on the happy path", async () => {
    mockCollect.mockResolvedValue(items(6))
    const report = await runRadarReport({ now: NOW })
    expect(report).not.toBeNull()
    expect(report?.itemCount).toBe(6)
    expect(report?.heatmap).toHaveLength(14)
    expect(mockSave).toHaveBeenCalled()
    expect(mockPrune).toHaveBeenCalled()
  })

  it("skips when the last report is within the interval", async () => {
    mockLatest.mockResolvedValue({ generatedAt: NOW - 86_400_000 }) // 1 day ago < 3
    const report = await runRadarReport({ now: NOW })
    expect(report).toBeNull()
    expect(mockCollect).not.toHaveBeenCalled()
  })

  it("forces past the interval guard", async () => {
    mockLatest.mockResolvedValue({ generatedAt: NOW - 86_400_000 })
    mockCollect.mockResolvedValue(items(6))
    expect(await runRadarReport({ now: NOW, force: true })).not.toBeNull()
  })

  it("skips when there are too few items", async () => {
    mockCollect.mockResolvedValue(items(2))
    expect(await runRadarReport({ now: NOW })).toBeNull()
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it("throws NoRadarModelError when no client resolves", async () => {
    mockCollect.mockResolvedValue(items(6))
    mockBuildClient.mockReturnValue(null)
    await expect(runRadarReport({ now: NOW })).rejects.toBeInstanceOf(NoRadarModelError)
  })

  it("aborts and refuses to persist into account B when active database switches mid-generation (F11)", async () => {
    const { activateAccountDatabase, clearAccountDatabaseSelection } =
      await import("@/lib/db/schema")
    mockCollect.mockResolvedValue(items(6))
    mockGenerate.mockImplementationOnce(async (_client, args) => {
      activateAccountDatabase("acct_radar_switch_target_b")
      expect(args.signal?.aborted).toBe(true)
      return {
        verdict: "from-a",
        atAGlance: [],
        infoDiet: "",
        subconscious: "",
        graveyard: [],
        blindSpots: "",
        actions: [],
        topicCloud: [],
      }
    })
    try {
      await expect(runRadarReport({ now: NOW, force: true })).rejects.toThrow()
      expect(mockSave).not.toHaveBeenCalled()
      expect(mockPrune).not.toHaveBeenCalled()
    } finally {
      clearAccountDatabaseSelection()
    }
  })

  it("cancels generation and skips persistence when AbortSignal aborts (F22)", async () => {
    mockCollect.mockResolvedValue(items(6))
    const controller = new AbortController()
    mockGenerate.mockImplementationOnce(async (_client, args) => {
      controller.abort("user-cancelled")
      expect(args.signal?.aborted).toBe(true)
      throw Object.assign(new Error("user-cancelled"), { name: "AbortError" })
    })
    await expect(
      runRadarReport({ now: NOW, force: true, signal: controller.signal })
    ).rejects.toThrow("user-cancelled")
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockPrune).not.toHaveBeenCalled()
  })
})
