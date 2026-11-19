import {
  CONTRACT_GAPS,
  MIRROR_CLAUSES,
  REPLACEMENT_SCENARIOS,
  contractViolations,
  mirrorViolations,
  scenariosFor,
  type ReplacementObservation,
  type ReplacementScenario,
} from "./contract"

const VERSIONS = { from: "1.0.0", to: "2.0.0" }

function scenario(id: string): ReplacementScenario {
  const found = REPLACEMENT_SCENARIOS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no scenario ${id}`)
  return found
}

function observed(overrides: Partial<ReplacementObservation>): ReplacementObservation {
  return {
    outcome: "succeeded",
    restartRequired: false,
    packageVersion: "2.0.0",
    recordedVersion: "2.0.0",
    runtime: "enabled",
    ...overrides,
  }
}

describe("REPLACEMENT_SCENARIOS", () => {
  it("covers every runtime state and every fault once", () => {
    expect(REPLACEMENT_SCENARIOS.map((s) => s.id)).toEqual([
      "replaces-enabled",
      "replaces-suspended",
      "replaces-loaded",
      "replaces-stopped",
      "refuses-another-identity",
      "fails-before-commit",
      "fails-after-commit",
      "cancelled-before-commit",
    ])
  })
})

describe("contractViolations", () => {
  it("accepts a replacement that returns the runtime to its prior state", () => {
    expect(
      contractViolations(scenario("replaces-loaded"), VERSIONS, observed({ runtime: "loaded" }))
    ).toEqual([])
  })

  it("rejects a replacement that activates a plugin that was only loaded", () => {
    expect(
      contractViolations(scenario("replaces-loaded"), VERSIONS, observed({ runtime: "enabled" }))
    ).toEqual(["runtime is enabled, not the loaded it was in"])
  })

  it("rejects records that disagree with the package on disk", () => {
    expect(
      contractViolations(
        scenario("replaces-enabled"),
        VERSIONS,
        observed({ recordedVersion: "1.0.0" })
      )
    ).toEqual(["records name v1.0.0 while v2.0.0 is on disk"])
  })

  it("requires a refused or cancelled replacement to leave everything as it was", () => {
    const untouched = observed({
      outcome: "failed",
      packageVersion: "1.0.0",
      recordedVersion: "1.0.0",
    })
    expect(contractViolations(scenario("refuses-another-identity"), VERSIONS, untouched)).toEqual(
      []
    )
    expect(contractViolations(scenario("fails-before-commit"), VERSIONS, untouched)).toEqual([])
    expect(contractViolations(scenario("cancelled-before-commit"), VERSIONS, untouched)).toEqual([
      "reported failed, not cancelled",
    ])
    expect(
      contractViolations(scenario("fails-before-commit"), VERSIONS, {
        ...untouched,
        runtime: "stopped",
      })
    ).toEqual(["runtime is stopped, not the enabled it was in"])
  })

  it("accepts either recovery after the commit, and nothing in between", () => {
    const afterCommit = scenario("fails-after-commit")
    // The previous package came back and the runtime restarted.
    expect(
      contractViolations(
        afterCommit,
        VERSIONS,
        observed({ outcome: "failed", packageVersion: "1.0.0", recordedVersion: "1.0.0" })
      )
    ).toEqual([])
    // The previous package came back, the runtime did not, and the caller is told.
    expect(
      contractViolations(
        afterCommit,
        VERSIONS,
        observed({
          outcome: "failed",
          packageVersion: "1.0.0",
          recordedVersion: "1.0.0",
          runtime: "stopped",
          restartRequired: true,
        })
      )
    ).toEqual([])
    // The new package stays, stopped, and the caller is told to restart it.
    expect(
      contractViolations(
        afterCommit,
        VERSIONS,
        observed({ outcome: "failed", runtime: "stopped", restartRequired: true })
      )
    ).toEqual([])
    // Reported as a success.
    expect(contractViolations(afterCommit, VERSIONS, observed({}))).toContain(
      "reported succeeded, not failed"
    )
    // The new package stays and keeps running on a half-finished replacement.
    expect(contractViolations(afterCommit, VERSIONS, observed({ outcome: "failed" }))).toEqual([
      "the new package was kept with its runtime not stopped, or without asking for a restart",
    ])
  })
})

describe("the data clause (ADR-0258)", () => {
  it("requires the package on disk to read the data", () => {
    expect(
      contractViolations(scenario("replaces-enabled"), VERSIONS, observed({ dataVersion: 2 }))
    ).toEqual([])
    expect(
      contractViolations(
        scenario("fails-after-commit"),
        VERSIONS,
        observed({
          outcome: "failed",
          packageVersion: "1.0.0",
          recordedVersion: "1.0.0",
          dataVersion: 2,
        })
      )
    ).toEqual(["the data is at v2, newer than v1.0.0 can read"])
  })

  it("is not checked where the harness does not model data", () => {
    expect(contractViolations(scenario("replaces-enabled"), VERSIONS, observed({}))).toEqual([])
  })
})

describe("recorded gaps", () => {
  it("pins every clause an environment has not closed", () => {
    // Closing a gap means deleting its entry here, in contract.ts and in ADR-0258.
    expect(CONTRACT_GAPS).toEqual({
      "desktop-update": { cancel: expect.any(String) },
      "desktop-rollback": { identity: expect.any(String), cancel: expect.any(String) },
      "cli-update": {},
      "vscode-install": { cancel: expect.any(String) },
      "headless-reconcile": {
        identity: expect.any(String),
        "before-commit": expect.any(String),
        cancel: expect.any(String),
        "after-commit": expect.any(String),
      },
      "host-package-change": { cancel: expect.any(String) },
    })
  })

  it("runs every scenario except an environment's recorded gaps", () => {
    expect(scenariosFor("cli-update")).toHaveLength(REPLACEMENT_SCENARIOS.length)
    expect(scenariosFor("desktop-update").map((s) => s.fault)).not.toContain("cancel")
    expect(scenariosFor("vscode-install")).toHaveLength(REPLACEMENT_SCENARIOS.length - 1)
    expect(scenariosFor("headless-reconcile").map((s) => s.fault)).toEqual([
      "none",
      "none",
      "none",
      "none",
    ])
    expect(scenariosFor("host-package-change").map((s) => s.fault)).not.toContain("cancel")
    expect(scenariosFor("desktop-rollback").map((s) => s.fault)).toEqual([
      "none",
      "none",
      "none",
      "none",
      "before-commit",
      "after-commit",
    ])
  })
})

describe("mirror clauses (ADR-0258)", () => {
  const conforming = {
    packageOperations: 0,
    localRuntimeCalls: 0,
    reportedBeforeAnswer: "queued" as const,
    readBackAfterAnswer: true,
  }

  it("accepts a mirror that queues its toggle and reads the Host's answer back", () => {
    expect(mirrorViolations(conforming)).toEqual([])
  })

  it("names each clause a mirror breaks", () => {
    expect(
      mirrorViolations({
        packageOperations: 1,
        localRuntimeCalls: 2,
        reportedBeforeAnswer: "applied",
        readBackAfterAnswer: false,
      })
    ).toEqual(Object.keys(MIRROR_CLAUSES))
  })
})
