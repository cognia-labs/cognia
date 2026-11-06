/**
 * @jest-environment jsdom
 */

const mockInvoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

let mockIsTauri = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
}))

import { revealIslandWindow, revealPetWindow, showMainWindow } from "./overlay-windows"

let warnSpy: jest.SpyInstance

beforeEach(() => {
  mockInvoke.mockReset()
  mockIsTauri = true
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe("lib/tauri/overlay-windows — command mapping", () => {
  it("showMainWindow invokes show_main_window", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(showMainWindow()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("show_main_window")
  })

  it("revealPetWindow identifies the popup target to the native window owner", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(revealPetWindow(true, "pet-popup")).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("reveal_pet_window", {
      focus: true,
      targetLabel: "pet-popup",
    })
  })

  it("revealPetWindow defaults to a non-activating reveal", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(revealPetWindow()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("reveal_pet_window", {
      focus: false,
      targetLabel: "pet",
    })
  })

  it("revealIslandWindow delegates first-paint reveal to the island window owner", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(revealIslandWindow(true)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("reveal_island_window", { focus: true })
  })

  it("revealIslandWindow defaults to a non-activating reveal", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(revealIslandWindow()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("reveal_island_window", { focus: false })
  })
})

describe("lib/tauri/overlay-windows — off Tauri", () => {
  it("never invokes and answers false", async () => {
    mockIsTauri = false
    await expect(showMainWindow()).resolves.toBe(false)
    await expect(revealPetWindow(false)).resolves.toBe(false)
    await expect(revealIslandWindow(false)).resolves.toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

describe("lib/tauri/overlay-windows — command rejection is swallowed", () => {
  it("each wrapper warns and answers false when invoke rejects", async () => {
    mockInvoke.mockRejectedValue(new Error("boom"))
    await expect(showMainWindow()).resolves.toBe(false)
    await expect(revealPetWindow()).resolves.toBe(false)
    await expect(revealIslandWindow()).resolves.toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })
})
