/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from "@testing-library/react"

import { useResolvedIssueIdentifier } from "./use-resolved-issue-identifier"

describe("useResolvedIssueIdentifier", () => {
  it("is nothing without an identifier and reads nothing", () => {
    const lookup = jest.fn()
    const { result } = renderHook(() => useResolvedIssueIdentifier(undefined, lookup))
    expect(result.current).toEqual({ status: "none" })
    expect(lookup).not.toHaveBeenCalled()
  })

  it("loads, then names the issue, reading the identifier case-insensitively", async () => {
    const lookup = jest.fn(async () => ({ id: "iss_12" }))
    const { result } = renderHook(() => useResolvedIssueIdentifier(" merc-12 ", lookup))
    expect(result.current).toEqual({ status: "loading" })
    await waitFor(() => expect(result.current).toEqual({ status: "found", issueId: "iss_12" }))
    expect(lookup).toHaveBeenCalledWith("MERC-12")
  })

  it("says missing when no issue has it, or the read fails", async () => {
    const { result } = renderHook(() =>
      useResolvedIssueIdentifier("MERC-404", async () => undefined)
    )
    await waitFor(() =>
      expect(result.current).toEqual({ status: "missing", identifier: "MERC-404" })
    )
    const failing = renderHook(() =>
      useResolvedIssueIdentifier("MERC-1", async () => {
        throw new Error("db")
      })
    )
    await waitFor(() => expect(failing.result.current.status).toBe("missing"))
  })

  it("says missing for something that is not an identifier, without a read", async () => {
    const lookup = jest.fn()
    const { result } = renderHook(() => useResolvedIssueIdentifier("MERC-0", lookup))
    await waitFor(() => expect(result.current).toEqual({ status: "missing", identifier: "MERC-0" }))
    expect(lookup).not.toHaveBeenCalled()
  })

  it("drops the previous answer when the identifier changes", async () => {
    const lookup = jest.fn(async (identifier: string) => ({ id: identifier.toLowerCase() }))
    const { result, rerender } = renderHook(
      ({ identifier }) => useResolvedIssueIdentifier(identifier, lookup),
      { initialProps: { identifier: "MERC-1" } }
    )
    await waitFor(() => expect(result.current).toEqual({ status: "found", issueId: "merc-1" }))
    rerender({ identifier: "MERC-2" })
    expect(result.current).toEqual({ status: "loading" })
    await waitFor(() => expect(result.current).toEqual({ status: "found", issueId: "merc-2" }))
  })
})
