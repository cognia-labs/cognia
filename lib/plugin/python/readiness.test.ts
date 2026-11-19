import {
  readPythonReadinessReport,
  readinessBlocksLoad,
  readinessCanPrepare,
  readinessNeedsUv,
  summarizeReadiness,
  type PythonReadiness,
} from "./readiness"

/** One reply per state, as `ReadinessReport` serializes it (readiness.rs). */
const REPLIES: Array<[PythonReadiness["state"], Record<string, unknown>]> = [
  ["not-required", { state: "not-required" }],
  ["not-prepared", { state: "not-prepared", installer: "uv" }],
  ["needs-uv", { state: "needs-uv", installer: "uv" }],
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
    expect(report?.lock).toBeNull()
    expect(report?.interpreterWarning).toBeNull()
  })

  it("keeps a locked plugin's lock (ENV02)", () => {
    const lock = { packages: ["six==1.16.0"], offline: true, ignoresManifestDependencies: true }
    expect(
      readPythonReadinessReport({ state: "stale", reasons: ["lock"], installer: "uv", lock })
    ).toEqual({
      readiness: { state: "stale", reasons: ["lock"], installer: "uv" },
      lock,
      interpreterWarning: null,
    })
    // A lock this build cannot read drops the lock, not the state.
    expect(
      readPythonReadinessReport({ state: "needs-uv", installer: "uv", lock: { packages: 3 } })
    ).toEqual({
      readiness: { state: "needs-uv", installer: "uv" },
      lock: null,
      interpreterWarning: null,
    })
  })

  it("keeps the cause of a failed preparation, and drops one it cannot word", () => {
    expect(
      readPythonReadinessReport({
        state: "failed",
        message: "offline",
        cause: { kind: "missing-wheels", packages: ["six==1.16.0"] },
        installer: "uv",
      })?.readiness
    ).toEqual({
      state: "failed",
      message: "offline",
      cause: { kind: "missing-wheels", packages: ["six==1.16.0"] },
      installer: "uv",
    })
    const unknown = readPythonReadinessReport({
      state: "failed",
      message: "offline",
      cause: { kind: "from-the-future" },
      installer: "uv",
    })?.readiness
    expect(unknown).toMatchObject({ state: "failed", message: "offline" })
    expect(unknown && "cause" in unknown ? unknown.cause : undefined).toBeUndefined()
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
    ["needs-uv naming another installer", { state: "needs-uv", installer: "pip" }],
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
    expect(blocking).toEqual(["not-prepared", "needs-uv", "stale", "preparing", "failed"])
  })

  it("lets the user prepare what is missing, out of date or failed, not what is running", () => {
    const preparable = REPLIES.map(([state]) => state).filter((state) =>
      readinessCanPrepare(readinessOf(state))
    )
    expect(preparable).toEqual(["not-prepared", "needs-uv", "stale", "failed"])
  })

  it("installs uv first only from needs-uv", () => {
    const needing = REPLIES.map(([state]) => state).filter((state) =>
      readinessNeedsUv(readinessOf(state))
    )
    expect(needing).toEqual(["needs-uv"])
    expect(readinessNeedsUv(null)).toBe(false)
  })

  it("sums the states up as the three the card shows", () => {
    expect(
      Object.fromEntries(REPLIES.map(([state]) => [state, summarizeReadiness(readinessOf(state))]))
    ).toEqual({
      "not-required": "runnable",
      "not-prepared": "not-ready",
      "needs-uv": "not-ready",
      stale: "not-ready",
      preparing: "not-ready",
      ready: "runnable",
      failed: "not-ready",
      "user-managed": "installed",
    })
  })
})
