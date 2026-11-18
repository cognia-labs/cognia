import {
  quiesceRuntime,
  restoreRuntimeState,
  runtimeResumeStateOf,
  type RuntimeStateOwner,
} from "./runtime-state"

function owner(): RuntimeStateOwner & { calls: string[] } {
  const calls: string[] = []
  const record = (name: string) => async (id: string) => void calls.push(`${name}:${id}`)
  return {
    calls,
    enablePlugin: jest.fn(record("enable")),
    disablePlugin: jest.fn(record("disable")),
    suspendPlugin: jest.fn(record("suspend")),
    loadPlugin: jest.fn(record("load")),
    unloadPlugin: jest.fn(record("unload")),
  }
}

describe("runtimeResumeStateOf", () => {
  it.each([
    ["enabled", "enabled"],
    ["enabling", "enabled"],
    ["suspended", "suspended"],
    ["loaded", "loaded"],
    ["loading", "loaded"],
    ["installed", "stopped"],
    ["disabled", "stopped"],
    ["error", "stopped"],
    [undefined, "stopped"],
  ])("classifies %s as %s", (status, expected) => {
    expect(runtimeResumeStateOf(status)).toBe(expected)
  })
})

describe("quiesceRuntime", () => {
  it("disables and unloads an active or suspended plugin", async () => {
    for (const state of ["enabled", "suspended"] as const) {
      const o = owner()
      await quiesceRuntime(o, "p", state, "update")
      expect(o.calls).toEqual(["disable:p", "unload:p"])
    }
  })

  it("only unloads a loaded plugin and leaves a stopped one alone", async () => {
    const loaded = owner()
    await quiesceRuntime(loaded, "p", "loaded", "update")
    expect(loaded.calls).toEqual(["unload:p"])
    const stopped = owner()
    await quiesceRuntime(stopped, "p", "stopped", "update")
    expect(stopped.calls).toEqual([])
  })
})

describe("restoreRuntimeState", () => {
  it.each([
    ["enabled", ["enable:p"]],
    ["suspended", ["enable:p", "suspend:p"]],
    ["loaded", ["load:p"]],
    ["stopped", []],
  ] as const)("returns a stopped plugin to %s and nothing more", async (state, calls) => {
    const o = owner()
    await restoreRuntimeState(o, "p", state, "update")
    expect(o.calls).toEqual(calls)
  })

  it("propagates a failed activation to the caller", async () => {
    const o = owner()
    ;(o.enablePlugin as jest.Mock).mockRejectedValueOnce(new Error("boom"))
    await expect(restoreRuntimeState(o, "p", "enabled", "update")).rejects.toThrow("boom")
  })
})
