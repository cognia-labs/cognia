import { PythonDependenciesNotReadyError, readDependenciesNotReady } from "./dependencies-not-ready"

describe("PythonDependenciesNotReadyError", () => {
  it("names the plugin and the state, and carries the readiness", () => {
    const readiness = { state: "stale", reasons: ["installer"], installer: "uv" } as const
    const error = new PythonDependenciesNotReadyError("demo", {
      ...readiness,
      reasons: [...readiness.reasons],
    })
    expect(error.name).toBe("PythonDependenciesNotReadyError")
    expect(error.message).toBe(
      'Cannot load Python plugin "demo": its Python dependencies are not ready (stale)'
    )
    expect(error.readiness.state).toBe("stale")
    expect(error.pluginId).toBe("demo")
  })
})

describe("readDependenciesNotReady", () => {
  const message = new PythonDependenciesNotReadyError("wiki", {
    state: "not-prepared",
    installer: "uv",
  }).message

  it("reads its own message, however it was wrapped or stored", () => {
    for (const text of [
      message,
      `PythonDependenciesNotReadyError: ${message}`,
      `PluginEnableError: Failed to enable plugin "wiki": ${message}`,
    ]) {
      expect(readDependenciesNotReady(text)).toEqual({ pluginId: "wiki", state: "not-prepared" })
    }
  })

  it.each(["preparing", "failed", "stale"] as const)("reads the %s state", (state) => {
    expect(
      readDependenciesNotReady(
        `Cannot load Python plugin "wiki": its Python dependencies are not ready (${state})`
      )?.state
    ).toBe(state)
  })

  it("reads nothing from any other failure", () => {
    expect(readDependenciesNotReady(undefined)).toBeNull()
    expect(readDependenciesNotReady(null)).toBeNull()
    expect(readDependenciesNotReady("ModuleNotFoundError: No module named 'PIL'")).toBeNull()
    expect(
      readDependenciesNotReady(
        'Cannot load Python plugin "wiki": its Python dependencies are not ready (ready)'
      )
    ).toBeNull()
  })
})
