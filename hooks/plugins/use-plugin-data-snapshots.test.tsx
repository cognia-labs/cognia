/**
 * @jest-environment jsdom
 */

const mockList = jest.fn()
jest.mock("@/lib/db/plugin-data-snapshots", () => ({
  listPluginDataSnapshots: (...args: unknown[]) => mockList(...args),
}))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: "db" }) }))
let mockRevision = 0
jest.mock("./use-plugin-rollback-availability", () => ({
  usePluginBackupIndexRevision: () => mockRevision,
}))
let mockStatus = "enabled"
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: (select: (state: unknown) => unknown) =>
    select({ plugins: { notes: { status: mockStatus } } }),
}))

import { renderHook, waitFor } from "@testing-library/react"

import { usePluginDataSnapshots } from "./use-plugin-data-snapshots"

beforeEach(() => {
  mockRevision = 0
  mockStatus = "enabled"
  mockList.mockReset().mockResolvedValue([{ id: "s1" }])
})

describe("usePluginDataSnapshots", () => {
  it("lists the plugin's snapshots", async () => {
    const { result } = renderHook(() => usePluginDataSnapshots("notes"))
    expect(result.current.records).toBeNull()
    await waitFor(() => expect(result.current.records).toEqual([{ id: "s1" }]))
    expect(mockList).toHaveBeenCalledWith({ name: "db" }, "notes")
  })

  it("reads nothing when disabled", () => {
    const { result } = renderHook(() => usePluginDataSnapshots("notes", false))
    expect(result.current).toEqual({ records: null, error: null })
    expect(mockList).not.toHaveBeenCalled()
  })

  it("reports a failed read", async () => {
    mockList.mockRejectedValue(new Error("closed"))
    const { result } = renderHook(() => usePluginDataSnapshots("notes"))
    await waitFor(() => expect(result.current.error).toBe("closed"))
  })

  it("reads again after a restore or an activation, which is when snapshots change", async () => {
    const { rerender } = renderHook(() => usePluginDataSnapshots("notes"))
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
    mockRevision = 1
    rerender()
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
    mockStatus = "loaded"
    rerender()
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(3))
  })
})
