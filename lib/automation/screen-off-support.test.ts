import { SCREEN_OFF_PLATFORMS, screenOffSupported } from "./screen-off-support"

describe("screenOffSupported", () => {
  it("names only the platforms with a virtual display backend", () => {
    expect(SCREEN_OFF_PLATFORMS).toEqual(["windows", "macos"])
    expect(screenOffSupported("windows")).toBe(true)
    expect(screenOffSupported("macos")).toBe(true)
  })

  it("treats every other platform, and an unknown one, as unsupported", () => {
    for (const platform of ["linux", "unsupported", "", null, undefined]) {
      expect(screenOffSupported(platform)).toBe(false)
    }
  })
})
