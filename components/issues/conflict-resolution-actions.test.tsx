/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"

import { ConflictResolutionActions, useConflictResolution } from "./conflict-resolution-actions"

describe("ConflictResolutionActions", () => {
  it("puts this device's version first and marks the recommended side", () => {
    const keepLocal = jest.fn()
    const keepRemote = jest.fn()
    render(
      <ConflictResolutionActions
        keepLocal={{ label: "Keep mine", onSelect: keepLocal, testId: "local" }}
        keepRemote={{
          label: "Take theirs",
          onSelect: keepRemote,
          recommended: true,
          testId: "remote",
        }}
      />
    )
    const buttons = screen.getAllByRole("button")
    expect(buttons.map((button) => button.textContent)).toEqual(["Keep mine", "Take theirs"])
    expect(screen.getByTestId("remote")).toHaveAttribute("data-variant", "default")
    expect(screen.getByTestId("local")).toHaveAttribute("data-variant", "outline")
    fireEvent.click(screen.getByTestId("local"))
    fireEvent.click(screen.getByTestId("remote"))
    expect(keepLocal).toHaveBeenCalledTimes(1)
    expect(keepRemote).toHaveBeenCalledTimes(1)
  })

  it("disables both while one resolution is in flight", () => {
    render(
      <ConflictResolutionActions
        disabled
        keepLocal={{ label: "a", onSelect: jest.fn() }}
        keepRemote={{ label: "b", onSelect: jest.fn() }}
      />
    )
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled()
  })
})

describe("useConflictResolution", () => {
  it("marks the row busy while resolving, then clears it", async () => {
    let finish: () => void = () => {}
    const { result } = renderHook(() => useConflictResolution())
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.run("c1", () => new Promise<void>((resolve) => (finish = resolve)))
    })
    expect(result.current.busyId).toBe("c1")
    await act(async () => {
      finish()
      await pending
    })
    expect(result.current.busyId).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it("keeps the failure's message and clears it on the next attempt", async () => {
    const { result } = renderHook(() => useConflictResolution())
    await act(() =>
      result.current.run("c1", async () => {
        throw new Error("revision moved")
      })
    )
    expect(result.current.error).toBe("revision moved")
    expect(result.current.busyId).toBeNull()
    await act(() => result.current.run("c1", async () => undefined))
    expect(result.current.error).toBeNull()
  })
})
