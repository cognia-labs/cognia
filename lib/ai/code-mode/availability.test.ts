import {
  codeModeUnavailableReason,
  isCodeModeKilled,
  isSandboxedPresentation,
  parseCodeSandboxReport,
  supportedToolPresentations,
} from "./availability"
import type { CodeHostCapability } from "./availability"

const AVAILABLE: CodeHostCapability = { state: "available", backend: "macos-sandbox-exec" }

describe("parseCodeSandboxReport", () => {
  it("reads an available report with its backend and generation", () => {
    expect(
      parseCodeSandboxReport({
        ready: true,
        codeSandbox: { available: true, backend: "linux-bwrap", generation: 4 },
      })
    ).toEqual({ state: "available", backend: "linux-bwrap", generation: 4 })
  })

  it("keeps the Host's own reason", () => {
    for (const reason of ["killed", "no-backend", "no-scratch"]) {
      expect(parseCodeSandboxReport({ codeSandbox: { available: false, reason } })).toEqual({
        state: "unavailable",
        reason,
      })
    }
  })

  // CM-02: an older Host and the CLI answer the status call without a Code
  // capability. That is not a yes.
  it("reads a report without codeSandbox as not reported", () => {
    expect(parseCodeSandboxReport({ ready: true })).toEqual({
      state: "unavailable",
      reason: "not-reported",
    })
    expect(parseCodeSandboxReport(undefined)).toEqual({
      state: "unavailable",
      reason: "not-reported",
    })
  })

  it("refuses an available claim that names no backend", () => {
    expect(parseCodeSandboxReport({ codeSandbox: { available: true } })).toEqual({
      state: "unavailable",
      reason: "not-reported",
    })
  })

  it("maps an unknown reason to not reported instead of trusting it", () => {
    expect(
      parseCodeSandboxReport({ codeSandbox: { available: false, reason: "made-up" } })
    ).toEqual({ state: "unavailable", reason: "not-reported" })
  })

  it("drops a generation that is not a non-negative integer", () => {
    expect(
      parseCodeSandboxReport({ codeSandbox: { available: true, backend: "b", generation: -1 } })
    ).toEqual({ state: "available", backend: "b" })
  })
})

describe("supportedToolPresentations", () => {
  it("offers native only while the Host has not answered", () => {
    expect(supportedToolPresentations({ state: "probing" }, {})).toEqual(["native"])
  })

  it("offers code and both once the Host reports a launcher", () => {
    expect(supportedToolPresentations(AVAILABLE, {})).toEqual(["native", "code", "both"])
  })

  // `both` exposes the same run_code executor, so it has to be gated too.
  it("withholds both as well as code on a Host that cannot sandbox", () => {
    expect(supportedToolPresentations({ state: "unavailable", reason: "no-backend" }, {})).toEqual([
      "native",
    ])
  })

  it("lets the build kill switch win over a Host that can sandbox", () => {
    expect(supportedToolPresentations(AVAILABLE, { NEXT_PUBLIC_CODE_MODE_KILL: "1" })).toEqual([
      "native",
    ])
  })

  it("returns a fresh array the caller may not mutate into the constant", () => {
    const first = supportedToolPresentations(AVAILABLE, {})
    first.push("native")
    expect(supportedToolPresentations(AVAILABLE, {})).toEqual(["native", "code", "both"])
  })
})

describe("codeModeUnavailableReason", () => {
  it("is null when Code is offered", () => {
    expect(codeModeUnavailableReason(AVAILABLE, {})).toBeNull()
  })

  it("says probing while the Host has not answered", () => {
    expect(codeModeUnavailableReason({ state: "probing" }, {})).toBe("probing")
  })

  it("names the Host's reason", () => {
    expect(codeModeUnavailableReason({ state: "unavailable", reason: "no-scratch" }, {})).toBe(
      "no-scratch"
    )
  })

  it("reports the build kill switch ahead of any Host state", () => {
    expect(
      codeModeUnavailableReason({ state: "probing" }, { NEXT_PUBLIC_CODE_MODE_KILL: "1" })
    ).toBe("killed")
  })
})

describe("isCodeModeKilled", () => {
  it('only treats an exact "1" as killed', () => {
    expect(isCodeModeKilled({ NEXT_PUBLIC_CODE_MODE_KILL: "true" })).toBe(false)
    expect(isCodeModeKilled({ NEXT_PUBLIC_CODE_MODE_KILL: "1" })).toBe(true)
    expect(isCodeModeKilled({})).toBe(false)
  })
})

describe("isSandboxedPresentation", () => {
  it("covers code and both, not native", () => {
    expect(isSandboxedPresentation("code")).toBe(true)
    expect(isSandboxedPresentation("both")).toBe(true)
    expect(isSandboxedPresentation("native")).toBe(false)
  })
})
