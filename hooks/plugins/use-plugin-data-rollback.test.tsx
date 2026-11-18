/**
 * @jest-environment jsdom
 */

const mockDescribe = jest.fn()
jest.mock("@/lib/plugin/dexie/data-rollback", () => ({
  describePluginDataRollback: (...args: unknown[]) => mockDescribe(...args),
}))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: "db" }) }))
let mockRevision = 0
jest.mock("./use-plugin-rollback-availability", () => ({
  usePluginBackupIndexRevision: () => mockRevision,
}))

import { renderHook, waitFor } from "@testing-library/react"

import { usePluginDataRollback } from "./use-plugin-data-rollback"

beforeEach(() => {
  mockRevision = 0
  mockDescribe.mockReset().mockResolvedValue({ kind: "none" })
})

describe("usePluginDataRollback", () => {
  it("asks nothing until there is a version to ask about", () => {
    const { result } = renderHook(() => usePluginDataRollback("notes", null))
    expect(result.current).toEqual({ data: null, error: null })
    expect(mockDescribe).not.toHaveBeenCalled()
  })

  it("answers for the requested version", async () => {
    const restore = { kind: "restore", snapshotId: "s1" }
    mockDescribe.mockResolvedValue(restore)
    const { result } = renderHook(() => usePluginDataRollback("notes", "1.0.0"))
    await waitFor(() => expect(result.current.data).toEqual(restore))
    expect(mockDescribe).toHaveBeenCalledWith(expect.any(Function), "notes", "1.0.0")
  })

  it("never answers for another version than the one asked about", async () => {
    let resolveSecond!: (value: unknown) => void
    mockDescribe
      .mockResolvedValueOnce({ kind: "none" })
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)))
    const { result, rerender } = renderHook(
      ({ version }) => usePluginDataRollback("notes", version),
      { initialProps: { version: "1.0.0" } }
    )
    await waitFor(() => expect(result.current.data).toEqual({ kind: "none" }))
    rerender({ version: "0.9.0" })
    expect(result.current.data).toBeNull()
    resolveSecond({ kind: "unavailable" })
    await waitFor(() => expect(result.current.data).toEqual({ kind: "unavailable" }))
  })

  it("reports a failed check", async () => {
    mockDescribe.mockRejectedValue(new Error("db closed"))
    const { result } = renderHook(() => usePluginDataRollback("notes", "1.0.0"))
    await waitFor(() => expect(result.current.error).toBe("db closed"))
    expect(result.current.data).toBeNull()
  })

  it("asks again when the backup index changes", async () => {
    const { rerender } = renderHook(() => usePluginDataRollback("notes", "1.0.0"))
    await waitFor(() => expect(mockDescribe).toHaveBeenCalledTimes(1))
    mockRevision = 1
    rerender()
    await waitFor(() => expect(mockDescribe).toHaveBeenCalledTimes(2))
  })
})
