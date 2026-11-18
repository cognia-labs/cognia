import { readPythonInterpreterReport, reportMatchesInterpreterPath } from "./interpreter-report"

const runtime = { source: "runtime", argv: ["python3"], version: "3.12.4" }

describe("readPythonInterpreterReport", () => {
  it("reads the interpreter and its warning from a load reply", () => {
    expect(
      readPythonInterpreterReport({
        generation: "g",
        interpreter: { source: "override", argv: ["/opt/py/bin/python"], version: "3.9.18" },
        interpreterWarning: { kind: "requirement-unmet", version: "3.9.18", requirement: ">=3.10" },
      })
    ).toEqual({
      source: "override",
      argv: ["/opt/py/bin/python"],
      version: "3.9.18",
      warning: { kind: "requirement-unmet", version: "3.9.18", requirement: ">=3.10" },
    })
  })

  it("reads every warning kind the host sends", () => {
    for (const warning of [
      { kind: "version-unknown" },
      { kind: "below-host-minimum", version: "3.8.10", minimum: "3.9" },
      { kind: "requirement-unreadable", problem: "invalid-pyproject" },
      { kind: "requirement-unreadable", problem: "invalid-specifier", requirement: "3.10" },
    ]) {
      expect(
        readPythonInterpreterReport({ interpreter: runtime, interpreterWarning: warning })?.warning
      ).toEqual(warning)
    }
  })

  it("keeps a report without a warning, and an unknown version", () => {
    expect(readPythonInterpreterReport({ interpreter: runtime })?.warning).toBeNull()
    expect(
      readPythonInterpreterReport({
        interpreter: { source: "override", argv: ["/x"], version: null },
        interpreterWarning: { kind: "version-unknown" },
      })?.version
    ).toBeNull()
  })

  it("has no report for a reply without a valid interpreter", () => {
    expect(readPythonInterpreterReport(null)).toBeNull()
    expect(readPythonInterpreterReport("reply")).toBeNull()
    expect(readPythonInterpreterReport({ generation: "g" })).toBeNull()
    expect(
      readPythonInterpreterReport({ interpreter: { source: "elsewhere", argv: [], version: null } })
    ).toBeNull()
  })

  it("leaves out a warning it cannot word", () => {
    expect(
      readPythonInterpreterReport({
        interpreter: runtime,
        interpreterWarning: { kind: "from-a-newer-host" },
      })?.warning
    ).toBeNull()
  })
})

describe("reportMatchesInterpreterPath", () => {
  const override = {
    source: "override" as const,
    argv: ["/opt/py/bin/python"],
    version: "3.9.18",
    warning: null,
  }
  const venv = {
    source: "venv" as const,
    argv: ["/v/bin/python"],
    version: "3.12.4",
    warning: null,
  }

  it("matches an override only to the same saved path", () => {
    expect(reportMatchesInterpreterPath(override, "/opt/py/bin/python")).toBe(true)
    expect(reportMatchesInterpreterPath(override, "  /opt/py/bin/python ")).toBe(true)
    expect(reportMatchesInterpreterPath(override, "/usr/bin/python3")).toBe(false)
    expect(reportMatchesInterpreterPath(override, "")).toBe(false)
  })

  it("matches the venv and the runtime only when no override is saved", () => {
    expect(reportMatchesInterpreterPath(venv, undefined)).toBe(true)
    expect(reportMatchesInterpreterPath(venv, " ")).toBe(true)
    expect(reportMatchesInterpreterPath(venv, "/opt/py/bin/python")).toBe(false)
  })
})
