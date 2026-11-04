/** @jest-environment node */
jest.mock("./agents/subagent-models/opencode", () => ({ runOpenCodeSubagentModels: jest.fn() }))
jest.mock("./agents/subagent-models/pi", () => ({ runPiSubagentModels: jest.fn() }))

import { parseLanes, withTimeout } from "./subagent-models"

describe("parseLanes", () => {
  it("runs both lanes by default and named lanes once each", () => {
    expect(parseLanes([])).toEqual(["pi", "opencode"])
    expect(parseLanes(["opencode", "opencode"])).toEqual(["opencode"])
  })

  it("rejects unknown lanes and flags", () => {
    expect(() => parseLanes(["goose"])).toThrow(/Unknown lane "goose"/)
    expect(() => parseLanes(["--live"])).toThrow()
  })
})

describe("withTimeout", () => {
  it("returns the result in time and rejects a hung run", async () => {
    await expect(withTimeout("pi", 1_000, async () => 7)).resolves.toBe(7)
    await expect(withTimeout("pi", 5, () => new Promise(() => undefined))).rejects.toThrow(
      /pi lane timed out after 5 ms/
    )
  })
})
