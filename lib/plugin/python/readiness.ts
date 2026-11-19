/**
 * Whether a Python plugin's environment can load it (ENV01, ADR-0258 §2), as
 * the Host answers `plugin_python_readiness`.
 *
 * The Host computes it from the environment it recorded when it built it and
 * from the preparation it is running or last failed. Five states stop a load
 * (`not-prepared`, `needs-uv`, `stale`, `preparing`, `failed`): the manager
 * refuses to enable such a plugin with `PythonDependenciesNotReadyError`
 * (`./dependencies-not-ready.ts`), and the user prepares the environment,
 * which is its own operation with its own consent (network and disk).
 *
 * A plugin locked with `uv.lock` (ENV02) is measured against its lock, and the
 * reply carries it (`lock`): what it pins and whether it installs offline from
 * bundled wheels. Only uv prepares it; without uv it is `needs-uv`, and
 * preparing installs uv first.
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

/** Why the last preparation failed, when the Host can tell. */
const failureCauseSchema = z.discriminatedUnion("kind", [
  /** `uv.lock` does not match `pyproject.toml`: only the author can lock it again. */
  z.object({ kind: z.literal("lock-out-of-date") }),
  /** An offline install whose bundled wheels lack these packages. */
  z.object({ kind: z.literal("missing-wheels"), packages: z.array(z.string()).min(1) }),
])

/** A locked plugin's lock (ENV02). */
const lockSummarySchema = z.object({
  /** What it pins (`name==version`), the plugin's own project excluded. */
  packages: z.array(z.string()),
  /** It installs offline from the wheels it bundles. */
  offline: z.boolean(),
  /** The manifest also lists `pythonDependencies`, which the lock replaces. */
  ignoresManifestDependencies: z.boolean(),
})

const readinessSchema = z.discriminatedUnion("state", [
  /** The plugin declares no requirements. */
  z.object({ state: z.literal("not-required") }),
  /** Nothing was built for it yet. */
  z.object({ state: z.literal("not-prepared"), installer: installerSchema }),
  /** Locked, and uv is not installed: there is no unlocked fallback. */
  z.object({ state: z.literal("needs-uv"), installer: z.literal("uv") }),
  /** Built for other requirements, another lock, interpreter or installer. */
  z.object({
    state: z.literal("stale"),
    reasons: z.array(z.enum(["dependencies", "interpreter", "installer", "lock"])).min(1),
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
  z.object({
    state: z.literal("failed"),
    message: z.string(),
    /** A cause this build cannot word is dropped; the message remains. */
    cause: failureCauseSchema.optional().catch(undefined),
    installer: installerSchema,
  }),
  /** The Host does not build it: the user runs the plugin on their own environment. */
  z.object({
    state: z.literal("user-managed"),
    reason: z.enum(["venv-disabled", "interpreter-override", "custom-installer"]),
  }),
])

export type PythonReadiness = z.infer<typeof readinessSchema>
export type PythonReadinessState = PythonReadiness["state"]
export type PythonInstaller = z.infer<typeof installerSchema>
export type PythonPreparationFailureCause = z.infer<typeof failureCauseSchema>
export type PythonLockSummary = z.infer<typeof lockSummarySchema>

export interface PythonReadinessReport {
  readiness: PythonReadiness
  /** The plugin's `uv.lock`, when it is locked (ENV02). */
  lock: PythonLockSummary | null
  /** The interpreter warning a load would raise (ENV03). It never blocks. */
  interpreterWarning: PythonInterpreterWarning | null
}

/** The states in which loading the plugin waits for a preparation. */
const BLOCKING_STATES: ReadonlySet<PythonReadinessState> = new Set([
  "not-prepared",
  "needs-uv",
  "stale",
  "preparing",
  "failed",
])

export function readinessBlocksLoad(readiness: PythonReadiness): boolean {
  return BLOCKING_STATES.has(readiness.state)
}

/**
 * Whether the user can start a preparation from this state. From `needs-uv`
 * the preparation installs uv first ({@link readinessNeedsUv}).
 */
export function readinessCanPrepare(readiness: PythonReadiness): boolean {
  return (
    readiness.state === "not-prepared" ||
    readiness.state === "needs-uv" ||
    readiness.state === "stale" ||
    readiness.state === "failed"
  )
}

/** Whether preparing has to install uv first: the plugin is locked and uv is missing. */
export function readinessNeedsUv(readiness: PythonReadiness | null | undefined): boolean {
  return readiness?.state === "needs-uv"
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
  const extras = reply as { lock?: unknown; interpreterWarning?: unknown }
  const lock = lockSummarySchema.safeParse(extras.lock)
  const warning = pythonInterpreterWarningSchema.safeParse(extras.interpreterWarning)
  return {
    readiness: readiness.data,
    lock: lock.success ? lock.data : null,
    interpreterWarning: warning.success ? warning.data : null,
  }
}
