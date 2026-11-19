/**
 * The plugin lifecycle contract for replacing an installed package
 * (ADR-0258), as data every environment's tests run against.
 *
 * An environment that replaces a plugin's package (a registry update on the
 * desktop, a GitHub update in the CLI, a VS Code extension install, …) runs
 * {@link REPLACEMENT_SCENARIOS} through its own test harness and checks what
 * it observed with {@link contractViolations}. The clauses are the ADR's:
 * identity binding, cancellation before the commit, runtime state
 * restoration, records (and data) that agree with the package on disk, and
 * what must hold after a failure.
 *
 * Gaps an environment has not closed are listed in {@link CONTRACT_GAPS} with
 * the reason, so a skipped scenario is a recorded decision rather than a
 * silent omission; `contract.test.ts` pins the list. Clients that mirror a
 * Host's plugins replace no package; they run {@link MIRROR_CLAUSES} instead.
 */
import type { RuntimeResumeState } from "./runtime-state"

/** Environments whose package replacement already runs the contract suite. */
export type ContractEnvironment =
  | "desktop-update"
  | "desktop-rollback"
  | "cli-update"
  | "vscode-install"
  /** The headless brain catching up with a package that changed on disk (`plugin-runtime-adapter.ts`). */
  | "headless-reconcile"
  /** A package change a paired device or remote caller asks a Host for (`host-package-change.ts`). */
  | "host-package-change"

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
  "desktop-rollback": {
    identity:
      "PluginRollbackManager.rollback checks the installed version only after the package changed; the safety snapshot then restores the previous package, stopped, with a restart requested",
    cancel:
      "PluginRollbackManager.rollback takes no AbortSignal; a running rollback cannot be cancelled",
  },
  "cli-update": {},
  "vscode-install": {
    cancel:
      "commitVscodeExtension has no cancel point; a caller cancels by discarding the staged graph instead of committing it",
  },
  "headless-reconcile": {
    identity:
      "a runtime-changed event reports a package that already changed on disk; the command that changed it checked the identity",
    "before-commit": "the commit happened before the event; there is no step before it to fail",
    cancel: "the commit happened before the event; there is nothing left to cancel",
    "after-commit":
      "a reconcile that cannot register or restart the plugin is logged by the brain; nothing asks the user for a restart",
  },
  "host-package-change": {
    cancel:
      "a device's request has no cancel point once the Host accepted it; the device cancels by not committing what it staged",
  },
})

/**
 * Clients whose plugin rows mirror a Host's (a paired phone, a browser pointed
 * at a Host). They replace no package, so the replacement scenarios do not
 * apply; what they must not do, and how they must report a change they ask
 * for, is below. A package change a client asks for runs on the Host as
 * `host-package-change`.
 */
export const MIRROR_CLAUSES: Readonly<Record<string, string>> = Object.freeze({
  "replaces-nothing":
    "installs, updates, rollbacks and uninstalls are refused on the mirror; the Host changes its own packages",
  "runs-nothing": "a toggle never drives a local plugin manager on the mirror",
  "queued-is-not-applied":
    "a toggle the mirror sent is reported as queued until the Host answers, never as applied",
  "host-answer-wins":
    "once the Host answers, applied or refused, the mirror's row is read back from the Host",
})

/** What a mirror harness saw. */
export interface MirrorObservation {
  /** Package operations the mirror performed itself (install, update, rollback, uninstall). */
  packageOperations: number
  /** Lifecycle calls on a local plugin manager. */
  localRuntimeCalls: number
  /** What the toggle reported before the Host answered. */
  reportedBeforeAnswer: "queued" | "applied" | "failed"
  /** Whether the mirror read its plugin rows back from the Host after the answer. */
  readBackAfterAnswer: boolean
}

/** Every {@link MIRROR_CLAUSES} clause `observed` breaks. */
export function mirrorViolations(observed: MirrorObservation): string[] {
  const violations: string[] = []
  if (observed.packageOperations > 0) violations.push("replaces-nothing")
  if (observed.localRuntimeCalls > 0) violations.push("runs-nothing")
  if (observed.reportedBeforeAnswer !== "queued") violations.push("queued-is-not-applied")
  if (!observed.readBackAfterAnswer) violations.push("host-answer-wins")
  return violations
}

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
  /**
   * The plugin's data version afterwards (ADR-0258), for environments whose
   * harness models plugin data; the package on disk must be able to read it.
   */
  dataVersion?: number
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
  // And the package on disk can read the data, whatever happened.
  if (observed.dataVersion !== undefined && observed.packageVersion !== undefined) {
    const readable = Number.parseInt(observed.packageVersion.split(".")[0] ?? "", 10)
    expect(
      observed.dataVersion <= readable,
      `the data is at v${observed.dataVersion}, newer than v${observed.packageVersion} can read`
    )
  }

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
