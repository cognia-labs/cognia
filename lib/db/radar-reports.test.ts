/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  saveRadarReport,
  getRadarReport,
  getLatestRadarReport,
  listAllRadarReports,
  listRadarReports,
  pruneRadarReports,
} from "./radar-reports"
import type { RadarReport } from "@/types/radar"
import { getDb } from "./schema"

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
})
