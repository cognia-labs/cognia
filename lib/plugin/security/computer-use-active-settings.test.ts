import {
  __resetForTesting,
  clearActiveComputerUseSettings,
  getActiveComputerUseSettings,
  setActiveComputerUseSettings,
  type ActiveComputerUseSettings,
} from "./computer-use-active-settings"

const settings = (requireConsent: boolean): ActiveComputerUseSettings => ({ requireConsent })

describe("active Computer Use settings cache", () => {
  afterEach(() => __resetForTesting())

  it("returns null for an unknown or missing session", () => {
    expect(getActiveComputerUseSettings("s1")).toBeNull()
    expect(getActiveComputerUseSettings(undefined)).toBeNull()
  })

  it("keeps each session's settings apart", () => {
    const a = settings(true)
    const b = settings(false)
    setActiveComputerUseSettings("a", a)
    setActiveComputerUseSettings("b", b)
    expect(getActiveComputerUseSettings("a")).toBe(a)
    expect(getActiveComputerUseSettings("b")).toBe(b)
  })

  it("overwrites on repeat and clears on undefined", () => {
    const first = settings(true)
    const second = settings(false)
    setActiveComputerUseSettings("s", first)
    setActiveComputerUseSettings("s", second)
    expect(getActiveComputerUseSettings("s")).toBe(second)
    setActiveComputerUseSettings("s", undefined)
    expect(getActiveComputerUseSettings("s")).toBeNull()
  })

  it("ignores an empty session id", () => {
    setActiveComputerUseSettings("", settings(true))
    expect(getActiveComputerUseSettings("")).toBeNull()
  })

  it("drops one session on clear and every session on reset", () => {
    setActiveComputerUseSettings("a", settings(true))
    setActiveComputerUseSettings("b", settings(true))
    clearActiveComputerUseSettings("a")
    expect(getActiveComputerUseSettings("a")).toBeNull()
    expect(getActiveComputerUseSettings("b")).not.toBeNull()
    __resetForTesting()
    expect(getActiveComputerUseSettings("b")).toBeNull()
  })
})
