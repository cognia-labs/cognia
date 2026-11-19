import {
  __resetPythonReadinessStoreForTesting,
  forgetPythonReadiness,
  markPythonPreparing,
  recordPythonPreparation,
  recordPythonReadiness,
  usePythonReadinessStore,
} from "./python-readiness-store"

const notPrepared = {
  readiness: { state: "not-prepared" as const, installer: "uv" as const },
  lock: null,
  interpreterWarning: { kind: "version-unknown" as const },
}

beforeEach(() => __resetPythonReadinessStoreForTesting())

const state = () => usePythonReadinessStore.getState()

describe("python readiness store", () => {
  it("records the latest report per plugin, and clears it on null", () => {
    recordPythonReadiness("demo", notPrepared)
    recordPythonReadiness("other", {
      readiness: { state: "not-required" },
      lock: null,
      interpreterWarning: null,
    })
    expect(state().byPluginId.demo).toBe(notPrepared)
    recordPythonReadiness("demo", null)
    expect(state().byPluginId).toEqual({
      other: { readiness: { state: "not-required" }, lock: null, interpreterWarning: null },
    })
  })

  it("shows a started preparation as running with the installer it had, and forgets the last result", () => {
    recordPythonReadiness("demo", notPrepared)
    recordPythonPreparation("demo", { status: "failed", message: "pip exited 1" })
    markPythonPreparing("demo")
    expect(state().byPluginId.demo).toEqual({
      readiness: { state: "preparing", installer: "uv" },
      lock: null,
      interpreterWarning: { kind: "version-unknown" },
    })
    expect(state().lastPreparationByPluginId.demo).toBeUndefined()
  })

  it("keeps a locked plugin's lock while it prepares, uv first or not (ENV02)", () => {
    const lock = { packages: ["six==1.16.0"], offline: false, ignoresManifestDependencies: false }
    recordPythonReadiness("locked", {
      readiness: { state: "needs-uv", installer: "uv" },
      lock,
      interpreterWarning: null,
    })
    markPythonPreparing("locked")
    expect(state().byPluginId.locked).toEqual({
      readiness: { state: "preparing", installer: "uv" },
      lock,
      interpreterWarning: null,
    })
  })

  it("marks nothing running without a report that names the installer", () => {
    markPythonPreparing("unknown")
    expect(state().byPluginId.unknown).toBeUndefined()
    recordPythonReadiness("mine", {
      readiness: { state: "user-managed", reason: "custom-installer" },
      lock: null,
      interpreterWarning: null,
    })
    markPythonPreparing("mine")
    expect(state().byPluginId.mine?.readiness.state).toBe("user-managed")
  })

  it("keeps how the last preparation ended", () => {
    const outcome = {
      venvDir: "/v",
      scope: "isolated" as const,
      installer: "uv" as const,
      downgradedReason: null,
    }
    recordPythonPreparation("demo", { status: "succeeded", outcome, resumed: true })
    expect(state().lastPreparationByPluginId.demo).toEqual({
      status: "succeeded",
      outcome,
      resumed: true,
    })
  })

  it("forgets everything about an uninstalled plugin", () => {
    recordPythonReadiness("demo", notPrepared)
    recordPythonPreparation("demo", { status: "failed", message: "x" })
    recordPythonReadiness("other", notPrepared)
    forgetPythonReadiness("demo")
    expect(Object.keys(state().byPluginId)).toEqual(["other"])
    expect(state().lastPreparationByPluginId).toEqual({})
  })
})
