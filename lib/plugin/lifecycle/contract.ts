/**
 * The plugin lifecycle contract for replacing an installed package
 * (ADR-0258), as data every environment's tests run against.
 *
 * An environment that replaces a plugin's package (a registry update on the
 * desktop, a GitHub update in the CLI, a VS Code extension install, …) runs
 * {@link REPLACEMENT_SCENARIOS} through its own test harness and checks what
 * it observed with {@link contractViolations}. The clauses are the ADR's:
 * identity binding, cancellation before the commit, runtime state
 * restoration, records that agree with the package on disk, and what must
 * hold after a failure.
 *
 * Gaps an environment has not closed are listed in {@link CONTRACT_GAPS} with
 * the reason, so a skipped scenario is a recorded decision rather than a
 * silent omission; `contract.test.ts` pins the list.
 */
import type { RuntimeResumeState } from "./runtime-state"

/** Environments whose package replacement already runs the contract suite. */
export type ContractEnvironment = "desktop-update" | "cli-update" | "vscode-install"

/** Where a scenario makes the operation fail, if anywhere. */
export type ReplacementFault =
  /** Nothing fails. */
  | "none"
  /** The staged package is not the one that was reviewed (id, version or digest). */
  | "identity"
  /** A step fails after the runtime was stopped, before the package is touched. */
  | "before-commit"
  /** A step fails after the package on disk was replaced. */
  | "after-commit"
  /** The caller cancels before the package is touched. */
  | "cancel"

export interface ReplacementScenario {
  id: string
  /** The runtime state the plugin is in before the operation. */
  before: RuntimeResumeState
  fault: ReplacementFault
}

const RESUME_STATES: readonly RuntimeResumeState[] = ["enabled", "suspended", "loaded", "stopped"]

export const REPLACEMENT_SCENARIOS: readonly ReplacementScenario[] = Object.freeze([
  ...RESUME_STATES.map((before) => ({ id: `replaces-${before}`, before, fault: "none" as const })),
  { id: "refuses-another-identity", before: "enabled", fault: "identity" },
  { id: "fails-before-commit", before: "enabled", fault: "before-commit" },
  { id: "fails-after-commit", before: "enabled", fault: "after-commit" },
  { id: "cancelled-before-commit", before: "enabled", fault: "cancel" },
])

/**
 * Clauses an environment does not meet yet, with why. A scenario whose fault
 * is listed here is not run for that environment (see {@link scenariosFor}).
 */
export const CONTRACT_GAPS: Readonly<
  Record<ContractEnvironment, Readonly<Partial<Record<ReplacementFault, string>>>>
> = Object.freeze({
  "desktop-update": {
    cancel:
      "PluginUpdater.installUpdate takes no AbortSignal; a running update cannot be cancelled",
  },
  "cli-update": {},
  "vscode-install": {
    cancel:
      "commitVscodeExtension has no cancel point; a caller cancels by discarding the staged graph instead of committing it",
  },
})

/**
 * Environments that replace packages but do not run the suite yet, with what
 * they still do differently. Aligning them is ADR-0258's second step.
 */
export const NOT_YET_CONFORMING: Readonly<Record<string, string>> = Object.freeze({
  "headless-reconcile":
    "cli/src/serve/plugin-runtime-adapter.ts always unloads, registers, loads and enables: the prior runtime state is not restored and a plugin whose intent is disabled fails its enable",
  "paired-client":
    "installs and staged updates run on the Host over companion RPC; whether the reviewed identity reaches each RPC command, and how the client labels queued against applied, is unverified",
  "capacitor-mirror":
    "a read-only mirror of a Host's plugins; it performs no replacement, so only the queued-versus-applied labelling applies",
})

/** The scenarios `environment` must pass: every one whose clause is not a recorded gap. */
export function scenariosFor(environment: ContractEnvironment): ReplacementScenario[] {
  const gaps = CONTRACT_GAPS[environment]
  return REPLACEMENT_SCENARIOS.filter((scenario) => gaps[scenario.fault] === undefined)
}

/** What a harness saw after running a scenario. */
export interface ReplacementObservation {
  /** What the operation reported to its caller. */
  outcome: "succeeded" | "failed" | "cancelled"
  /** Whether it reported that the plugin must be restarted by hand. */
  restartRequired: boolean
  /** Version of the package on disk afterwards; `undefined` when none is installed. */
  packageVersion: string | undefined
  /** Version the environment's records (Dexie row, install origin) name afterwards. */
  recordedVersion: string | undefined
  /** The runtime state afterwards. */
  runtime: RuntimeResumeState
}

export interface ReplacementVersions {
  /** The installed version before the operation. */
  from: string
  /** The version the operation installs. */
  to: string
}

/**
 * Every clause `observed` breaks for `scenario`; an empty list means the
 * scenario holds.
 */
export function contractViolations(
  scenario: ReplacementScenario,
  versions: ReplacementVersions,
  observed: ReplacementObservation
): string[] {
  const violations: string[] = []
  const expect = (holds: boolean, clause: string) => {
    if (!holds) violations.push(clause)
  }

  // Records describe the bytes on disk, whatever happened.
  expect(
    observed.packageVersion === observed.recordedVersion,
    `records name v${observed.recordedVersion ?? "none"} while v${observed.packageVersion ?? "none"} is on disk`
  )

  switch (scenario.fault) {
    case "none":
      expect(observed.outcome === "succeeded", `reported ${observed.outcome}, not succeeded`)
      expect(observed.packageVersion === versions.to, `v${versions.to} is not on disk`)
      expect(
        observed.runtime === scenario.before,
        `runtime is ${observed.runtime}, not the ${scenario.before} it was in`
      )
      expect(!observed.restartRequired, "a successful replacement asked for a restart")
      break
    case "identity":
    case "before-commit":
    case "cancel": {
      const reported = scenario.fault === "cancel" ? "cancelled" : "failed"
      expect(observed.outcome === reported, `reported ${observed.outcome}, not ${reported}`)
      expect(
        observed.packageVersion === versions.from,
        `the installed v${versions.from} was replaced before the commit`
      )
      expect(
        observed.runtime === scenario.before,
        `runtime is ${observed.runtime}, not the ${scenario.before} it was in`
      )
      break
    }
    case "after-commit": {
      expect(observed.outcome === "failed", `reported ${observed.outcome}, not failed`)
      // Either the previous package came back, or the new one stays and the
      // caller is told its runtime could not be restarted.
      const restored = observed.packageVersion === versions.from
      const kept = observed.packageVersion === versions.to
      expect(restored || kept, `v${observed.packageVersion ?? "none"} is on disk`)
      if (kept) {
        expect(
          observed.runtime === "stopped" && observed.restartRequired,
          "the new package was kept with its runtime not stopped, or without asking for a restart"
        )
      } else if (restored && observed.runtime !== scenario.before) {
        expect(
          observed.runtime === "stopped" && observed.restartRequired,
          `runtime is ${observed.runtime} after restoring v${versions.from}, without asking for a restart`
        )
      }
      break
    }
  }
  return violations
}
