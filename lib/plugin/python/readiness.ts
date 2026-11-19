/**
 * Whether a Python plugin's environment can load it (ENV01, ADR-0258 §2), as
 * the Host answers `plugin_python_readiness`.
 *
 * The Host computes it from the environment it recorded when it built it and
 * from the preparation it is running or last failed. Four states stop a load
 * (`not-prepared`, `stale`, `preparing`, `failed`): the manager refuses to
 * enable such a plugin with `PythonDependenciesNotReadyError`
 * (`./dependencies-not-ready.ts`), and the user prepares the environment,
 * which is its own operation with its own consent (network and disk).
 *
 * Wire-exact counterpart of `ReadinessReport` in
 * `crates/cognia-plugin-runtime/src/python/readiness.rs`.
 */
import { z } from "zod"

import {
  pythonInterpreterWarningSchema,
  type PythonInterpreterWarning,
} from "@/lib/plugin/python/interpreter-report"

/** The installer a preparation runs with. Only the Host knows it on `auto`. */
const installerSchema = z.enum(["uv", "pip"])

const readinessSchema = z.discriminatedUnion("state", [
  /** The plugin declares no requirements. */
  z.object({ state: z.literal("not-required") }),
  /** Nothing was built for it yet. */
  z.object({ state: z.literal("not-prepared"), installer: installerSchema }),
  /** Built for other requirements, another interpreter or another installer. */
  z.object({
    state: z.literal("stale"),
    reasons: z.array(z.enum(["dependencies", "interpreter", "installer"])).min(1),
    installer: installerSchema,
  }),
  /** A preparation is running now. */
  z.object({ state: z.literal("preparing"), installer: installerSchema }),
  z.object({
    state: z.literal("ready"),
    scope: z.enum(["shared", "isolated"]),
    installer: installerSchema,
  }),
  /** The last preparation failed and the environment does not match. */
  z.object({ state: z.literal("failed"), message: z.string(), installer: installerSchema }),
  /** The Host does not build it: the user runs the plugin on their own environment. */
  z.object({
    state: z.literal("user-managed"),
    reason: z.enum(["venv-disabled", "interpreter-override", "custom-installer"]),
  }),
])

export type PythonReadiness = z.infer<typeof readinessSchema>
export type PythonReadinessState = PythonReadiness["state"]
export type PythonInstaller = z.infer<typeof installerSchema>

export interface PythonReadinessReport {
  readiness: PythonReadiness
  /** The interpreter warning a load would raise (ENV03). It never blocks. */
  interpreterWarning: PythonInterpreterWarning | null
}

/** The states in which loading the plugin waits for a preparation. */
const BLOCKING_STATES: ReadonlySet<PythonReadinessState> = new Set([
  "not-prepared",
  "stale",
  "preparing",
  "failed",
])

export function readinessBlocksLoad(readiness: PythonReadiness): boolean {
  return BLOCKING_STATES.has(readiness.state)
}

/** Whether the user can start a preparation from this state. */
export function readinessCanPrepare(readiness: PythonReadiness): boolean {
  return (
    readiness.state === "not-prepared" ||
    readiness.state === "stale" ||
    readiness.state === "failed"
  )
}

/**
 * The three states a plugin card shows (ADR-0258 §2): runnable (its
 * environment matches, or it needs none), dependencies not ready, and
 * installed, when the user manages the environment and the Host cannot vouch
 * for it.
 */
export type PythonEnvironmentSummary = "installed" | "not-ready" | "runnable"

export function summarizeReadiness(readiness: PythonReadiness): PythonEnvironmentSummary {
  if (readiness.state === "ready" || readiness.state === "not-required") return "runnable"
  if (readinessBlocksLoad(readiness)) return "not-ready"
  return "installed"
}

/**
 * Read the report out of a `plugin_python_readiness` reply. `null` when this
 * build cannot read it, which a Host on the same contract never sends (one on
 * another contract is refused before it answers): the caller then refuses
 * nothing on a guess, and the load fails on the import that is missing.
 */
export function readPythonReadinessReport(reply: unknown): PythonReadinessReport | null {
  const readiness = readinessSchema.safeParse(reply)
  if (!readiness.success) return null
  const warning = pythonInterpreterWarningSchema.safeParse(
    (reply as { interpreterWarning?: unknown }).interpreterWarning
  )
  return { readiness: readiness.data, interpreterWarning: warning.success ? warning.data : null }
}
