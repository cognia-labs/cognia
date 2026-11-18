import {
  __resetPythonInterpreterReportStoreForTesting,
  recordPythonInterpreterReport,
  usePythonInterpreterReportStore,
} from "./python-interpreter-report-store"

const report = {
  source: "runtime" as const,
  argv: ["python3"],
  version: "3.9.18",
  warning: { kind: "requirement-unmet" as const, version: "3.9.18", requirement: ">=3.10" },
}

describe("python interpreter report store", () => {
  beforeEach(() => __resetPythonInterpreterReportStoreForTesting())

  it("keeps the latest report per plugin", () => {
    recordPythonInterpreterReport("a", report)
    recordPythonInterpreterReport("b", { ...report, warning: null })
    recordPythonInterpreterReport("a", { ...report, version: "3.12.4", warning: null })

    const { byPluginId } = usePythonInterpreterReportStore.getState()
    expect(byPluginId.a).toEqual({ ...report, version: "3.12.4", warning: null })
    expect(byPluginId.b?.warning).toBeNull()
  })

  it("clears a plugin's report when a load brings none", () => {
    recordPythonInterpreterReport("a", report)
    recordPythonInterpreterReport("b", report)
    recordPythonInterpreterReport("a", null)

    const { byPluginId } = usePythonInterpreterReportStore.getState()
    expect(byPluginId.a).toBeUndefined()
    expect(byPluginId.b).toEqual(report)
  })
})
