const mockReadTombstonesSince = jest.fn()

jest.mock("@/lib/db/tombstones", () => ({
  readTombstonesSince: (...args: unknown[]) => mockReadTombstonesSince(...args),
}))

import { excludeLiveKeys, finalizeDelta } from "./delta"

describe("finalizeDelta", () => {
  beforeEach(() => {
    mockReadTombstonesSince.mockReset()
    mockReadTombstonesSince.mockResolvedValue({ ids: [], maxDeletedAt: 0 })
  })

  it("advances the cursor to the newest row's updatedAt, falling back to createdAt", async () => {
    const delta = await finalizeDelta(
      "sessions",
      [
        { id: "a", updatedAt: 20 },
        { id: "b", createdAt: 30 },
      ],
      10
    )
    expect(delta).toEqual({
      rows: [
        { id: "a", updatedAt: 20 },
        { id: "b", createdAt: 30 },
      ],
      deleted_ids: [],
      next_since: 30,
      has_more: false,
    })
    expect(mockReadTombstonesSince).toHaveBeenCalledWith("sessions", 10, undefined)
  })

  it("folds in tombstones and lets a later deletion advance the cursor", async () => {
    mockReadTombstonesSince.mockResolvedValue({ ids: ["gone", "a"], maxDeletedAt: 50 })
    const delta = await finalizeDelta("sessions", [{ id: "a", updatedAt: 20 }], 10)
    expect(delta.deleted_ids).toEqual(["gone"])
    expect(delta.next_since).toBe(50)
  })

  it("bounds tombstones to the delivered page when more rows remain", async () => {
    await finalizeDelta("messages", [{ id: "m", updatedAt: 40 }], 10, true)
    expect(mockReadTombstonesSince).toHaveBeenCalledWith("messages", 10, 40)
  })

  it("reads the watermark through a custom cursor", async () => {
    const delta = await finalizeDelta("petActivityLog", [{ id: "7" }], 3, false, (row) =>
      Number(row.id)
    )
    expect(delta.next_since).toBe(7)
  })

  it("keeps the client's cursor when nothing changed", async () => {
    const delta = await finalizeDelta("sessions", [], 12)
    expect(delta).toEqual({ rows: [], deleted_ids: [], next_since: 12, has_more: false })
  })
})

describe("excludeLiveKeys", () => {
  it("drops tombstoned ids whose row is in the same delta, keyed by id", () => {
    expect(
      excludeLiveKeys("plugins", [{ id: "back" }, { id: "fresh" }], ["back", "gone", "also-gone"])
    ).toEqual(["gone", "also-gone"])
  })

  it("keys templateDefinitions by storageKey rather than id", () => {
    const rows = [{ id: "def-1", storageKey: "pkg/def-1@2" }]
    expect(excludeLiveKeys("templateDefinitions", rows, ["pkg/def-1@2", "def-1"])).toEqual([
      "def-1",
    ])
  })

  it("keys templatePackages by key rather than id", () => {
    const rows = [{ id: "pkg-row", key: "acme/pack" }]
    expect(excludeLiveKeys("templatePackages", rows, ["acme/pack", "pkg-row"])).toEqual(["pkg-row"])
  })

  it("returns the ids unchanged (as a copy) when the delta carries no rows", () => {
    const deleted = ["a", "b"]
    const result = excludeLiveKeys("sessions", [], deleted)
    expect(result).toEqual(["a", "b"])
    expect(result).not.toBe(deleted)
  })

  it("returns an empty list when nothing was deleted", () => {
    expect(excludeLiveKeys("sessions", [{ id: "s1" }], [])).toEqual([])
  })

  it("ignores rows that are null or carry a non-string key", () => {
    expect(excludeLiveKeys("plugins", [null, { id: 7 }, {}], ["7", "x"])).toEqual(["7", "x"])
  })
})
