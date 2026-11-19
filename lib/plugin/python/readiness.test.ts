import {
  PythonDependenciesNotReadyError,
  readPythonReadinessReport,
  readinessBlocksLoad,
  readinessCanPrepare,
  summarizeReadiness,
  type PythonReadiness,
} from "./readiness"

/** One reply per state, as `ReadinessReport` serializes it (readiness.rs). */
const REPLIES: Array<[PythonReadiness["state"], Record<string, unknown>]> = [
  ["not-required", { state: "not-required" }],
  ["not-prepared", { state: "not-prepared", installer: "uv" }],
  ["stale", { state: "stale", reasons: ["dependencies", "interpreter"], installer: "pip" }],
  ["preparing", { state: "preparing", installer: "uv" }],
  ["ready", { state: "ready", scope: "shared", installer: "uv" }],
  ["failed", { state: "failed", message: "pip exited 1", installer: "pip" }],
  ["user-managed", { state: "user-managed", reason: "interpreter-override" }],
]

describe("readPythonReadinessReport", () => {
  it.each(REPLIES)("reads the %s reply", (state, reply) => {
    const report = readPythonReadinessReport(reply)
    expect(report?.readiness).toEqual(reply)
    expect(report?.readiness.state).toBe(state)
    expect(report?.interpreterWarning).toBeNull()
  })

  it("keeps the interpreter warning the Host attached", () => {
    expect(
      readPythonReadinessReport({
        state: "ready",
        scope: "isolated",
        installer: "uv",
        interpreterWarning: { kind: "requirement-unmet", version: "3.9.1", requirement: ">=3.11" },
      })?.interpreterWarning
    ).toEqual({ kind: "requirement-unmet", version: "3.9.1", requirement: ">=3.11" })
  })

  it("drops a warning kind this build cannot word, but keeps the state", () => {
    const report = readPythonReadinessReport({
      state: "not-prepared",
      installer: "uv",
      interpreterWarning: { kind: "from-the-future" },
    })
    expect(report?.readiness.state).toBe("not-prepared")
    expect(report?.interpreterWarning).toBeNull()
  })

  it.each([
    ["no reply", null],
    ["an unknown state", { state: "needs-uv" }],
    ["a state the Host prepares without its installer", { state: "not-prepared" }],
    ["stale with no reason", { state: "stale", reasons: [], installer: "uv" }],
    ["an installer it does not use", { state: "ready", scope: "shared", installer: "custom" }],
  ])("reads nothing from %s", (_label, reply) => {
    expect(readPythonReadinessReport(reply)).toBeNull()
  })
})

describe("readiness predicates", () => {
  const readinessOf = (state: PythonReadiness["state"]) =>
    readPythonReadinessReport(REPLIES.find(([s]) => s === state)![1])!.readiness

  it("blocks a load only while the environment is not ready", () => {
    const blocking = REPLIES.map(([state]) => state).filter((state) =>
      readinessBlocksLoad(readinessOf(state))
    )
    expect(blocking).toEqual(["not-prepared", "stale", "preparing", "failed"])
  })

  it("lets the user prepare what is missing, out of date or failed, not what is running", () => {
    const preparable = REPLIES.map(([state]) => state).filter((state) =>
      readinessCanPrepare(readinessOf(state))
    )
    expect(preparable).toEqual(["not-prepared", "stale", "failed"])
  })

  it("sums the states up as the three the card shows", () => {
    expect(
      Object.fromEntries(REPLIES.map(([state]) => [state, summarizeReadiness(readinessOf(state))]))
    ).toEqual({
      "not-required": "runnable",
      "not-prepared": "not-ready",
      stale: "not-ready",
      preparing: "not-ready",
      ready: "runnable",
      failed: "not-ready",
      "user-managed": "installed",
    })
  })
})

describe("PythonDependenciesNotReadyError", () => {
  it("names the plugin and the state, and carries the readiness", () => {
    const readiness: PythonReadiness = { state: "stale", reasons: ["installer"], installer: "uv" }
    const error = new PythonDependenciesNotReadyError("demo", readiness)
    expect(error.name).toBe("PythonDependenciesNotReadyError")
    expect(error.message).toBe(
      'Cannot load Python plugin "demo": its Python dependencies are not ready (stale)'
    )
    expect(error.readiness).toBe(readiness)
    expect(error.pluginId).toBe("demo")
  })
})
