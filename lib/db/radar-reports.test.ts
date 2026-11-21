/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  saveRadarReport,
  getRadarReport,
  getLatestRadarReport,
  listAllRadarReports,
  listRadarReports,
  pruneRadarReports,
  RadarAccountChangedError,
} from "./radar-reports"
import { decideRadarSuggestion } from "@/lib/radar/suggestions"
import type { RadarReport } from "@/types/radar"
import {
  activateAccountDatabase,
  activeDatabaseEpoch,
  activeDatabaseName,
  clearAccountDatabaseSelection,
  getDb,
} from "./schema"

jest.mock("@/lib/scheduler/host-support", () => ({ assertTaskTypeSupportedOnHost: () => null }))
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => ({ updateTask: jest.fn(async (id: string) => ({ id })) }),
}))

beforeEach(async () => {
  await getDb().radarReports.clear()
}, 30_000)

function report(id: string, generatedAt: number): RadarReport {
  return {
    id,
    scope: "self",
    generatedAt,
    windowDays: 14,
    itemCount: 5,
    heatmap: [],
    verdict: "v",
    atAGlance: [],
    infoDiet: "",
    subconscious: "",
    graveyard: [],
    blindSpots: "",
    actions: [],
    topicCloud: [],
  }
}

describe("radar-reports CRUD", () => {
  it("preserves unresolved and accepted suggestions beyond the history retention window", async () => {
    await saveRadarReport({
      ...report("old", 1),
      suggestions: [{ id: "s", actionIndex: 0, status: "accepted", taskId: "t" }],
    })
    await saveRadarReport(report("new", 2))
    await pruneRadarReports(1)
    expect(await getRadarReport("old")).toBeDefined()
  })
  it("saves, reads by id, and returns the latest for a scope", async () => {
    await saveRadarReport(report("r1", 1000))
    await saveRadarReport(report("r2", 2000))
    expect((await getRadarReport("r1"))?.generatedAt).toBe(1000)
    expect((await getLatestRadarReport("self"))?.id).toBe("r2")
  })

  it("lists newest-first and prunes to the newest N", async () => {
    for (let i = 0; i < 5; i++) await saveRadarReport(report(`p${i}`, i * 1000))
    const list = await listRadarReports(3)
    expect(list.map((r) => r.id)).toEqual(["p4", "p3", "p2"])

    const pruned = await pruneRadarReports(2)
    expect(pruned).toBeGreaterThanOrEqual(1)
    expect((await listRadarReports(50)).length).toBe(2)
  })

  it("lists every report newest-first, past the capped list's default", async () => {
    // The panel's history picker. It used to pass `Number.MAX_SAFE_INTEGER`
    // as a limit, which a real browser's IndexedDB refuses (`getAll` takes an
    // unsigned long count), so the panel threw before rendering.
    for (let i = 0; i < 25; i++) await saveRadarReport(report(`a${i}`, i * 1000))
    const all = await listAllRadarReports()
    expect(all).toHaveLength(25)
    expect(all[0]!.id).toBe("a24")
    expect(all.at(-1)!.id).toBe("a0")
  })

  it("retains legacy reports with undecided actions and never deletes one concurrently accepted into a Goal (F23)", async () => {
    const legacy: RadarReport = {
      ...report("legacy", 1),
      actions: ["Review the Juniper launch"],
    }
    await getDb().radarReports.bulkPut([legacy, report("new", 2)])

    const [pruned, accepted] = await Promise.all([
      pruneRadarReports(1),
      decideRadarSuggestion("legacy", "legacy:action:0", "accepted"),
    ])
    expect(pruned).toBe(0)
    expect(accepted.status).toBe("accepted")
    expect(await getRadarReport("legacy")).toBeDefined()
    expect(await getDb().scheduledTasks.get(accepted.taskId!)).toBeDefined()
  })

  it("refuses save and prune when the active database partition changes (F11)", async () => {
    const guard = {
      expectDatabase: activeDatabaseName(),
      expectEpoch: activeDatabaseEpoch(),
    }
    try {
      activateAccountDatabase("acct_radar_guard_b")
      await expect(saveRadarReport(report("leaked", 10), guard)).rejects.toBeInstanceOf(
        RadarAccountChangedError
      )
      await expect(pruneRadarReports(5, guard)).rejects.toBeInstanceOf(RadarAccountChangedError)
      expect(await getDb().radarReports.count()).toBe(0)
    } finally {
      await getDb().delete()
      clearAccountDatabaseSelection()
    }
  })
})
