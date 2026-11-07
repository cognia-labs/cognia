import { loggers } from "@cognia/logging"
import {
  __resetRunResourceReleasersForTesting,
  registerRunResourceReleaser,
  releaseRegisteredRunResources,
} from "./run-resources"

afterEach(() => __resetRunResourceReleasersForTesting())

describe("run resource releasers", () => {
  it("calls every registered releaser with the run id", async () => {
    const a = jest.fn(async () => undefined)
    const b = jest.fn(async () => undefined)
    registerRunResourceReleaser("a", a)
    registerRunResourceReleaser("b", b)
    await releaseRegisteredRunResources("run-1")
    expect(a).toHaveBeenCalledWith("run-1")
    expect(b).toHaveBeenCalledWith("run-1")
  })

  it("replaces a releaser registered again under the same name", async () => {
    const first = jest.fn(async () => undefined)
    const second = jest.fn(async () => undefined)
    registerRunResourceReleaser("terminal-sessions", first)
    registerRunResourceReleaser("terminal-sessions", second)
    await releaseRegisteredRunResources("run-1")
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("logs a releaser that throws and still runs the others", async () => {
    const warn = jest.spyOn(loggers.app, "warn").mockImplementation(() => undefined)
    const after = jest.fn(async () => undefined)
    registerRunResourceReleaser("broken", async () => {
      throw new Error("pty gone")
    })
    registerRunResourceReleaser("after", after)
    await expect(releaseRegisteredRunResources("run-2")).resolves.toBeUndefined()
    expect(after).toHaveBeenCalledWith("run-2")
    expect(warn).toHaveBeenCalledWith("run resource release failed", {
      releaser: "broken",
      runId: "run-2",
      error: "Error: pty gone",
    })
    warn.mockRestore()
  })
})
