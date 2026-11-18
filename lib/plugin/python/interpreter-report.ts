/**
 * The interpreter a Python plugin loaded on, as the `plugin_python_load` reply
 * reports it (ENV03, ADR-0258): where it came from, the version it reported,
 * and the warning the Host raised when it misses the Host minimum or the
 * plugin's `requires-python`. A warning never stops the load.
 *
 * Wire-exact counterpart of `InterpreterReport` and `InterpreterWarning` in
 * `crates/cognia-plugin-runtime/src/python/{commands,interpreter_check}.rs`.
 */
import { z } from "zod"

const interpreterSchema = z.object({
  /** `override`: the user's interpreter path; `venv`: the Host-built environment; `runtime`: the discovered interpreter. */
  source: z.enum(["override", "venv", "runtime"]),
  argv: z.array(z.string()),
  version: z.string().nullable(),
})

const warningSchema = z.discriminatedUnion("kind", [
  /** It reported no version: it would not run, printed no banner, or timed out. */
  z.object({ kind: z.literal("version-unknown") }),
  z.object({
    kind: z.literal("below-host-minimum"),
    version: z.string(),
    minimum: z.string(),
  }),
  z.object({
    kind: z.literal("requirement-unmet"),
    version: z.string(),
    requirement: z.string(),
  }),
  z.object({
    kind: z.literal("requirement-unreadable"),
    problem: z.enum(["invalid-pyproject", "not-a-string", "invalid-specifier"]),
    requirement: z.string().optional(),
  }),
])

export type PythonInterpreterSource = z.infer<typeof interpreterSchema>["source"]
export type PythonInterpreterWarning = z.infer<typeof warningSchema>

export interface PythonInterpreterReport {
  source: PythonInterpreterSource
  argv: string[]
  version: string | null
  warning: PythonInterpreterWarning | null
}

/**
 * Read the report out of a load reply. `null` when the reply carries no
 * interpreter (it did not come from a Host that checks one).
 */
export function readPythonInterpreterReport(loadResult: unknown): PythonInterpreterReport | null {
  if (!loadResult || typeof loadResult !== "object") return null
  const reply = loadResult as { interpreter?: unknown; interpreterWarning?: unknown }
  const interpreter = interpreterSchema.safeParse(reply.interpreter)
  if (!interpreter.success) return null
  // A paired Host of another build may send a kind this one cannot word; it is
  // left out rather than shown as a warning it is not. The Host's own log
  // line still carries it.
  const warning = warningSchema.safeParse(reply.interpreterWarning)
  return { ...interpreter.data, warning: warning.success ? warning.data : null }
}

/**
 * Whether `report` describes the interpreter the saved settings select: the
 * same override path, or no override at all for the venv and the runtime.
 * After the path changes, a report from the previous load is about another
 * interpreter until the plugin loads again.
 */
export function reportMatchesInterpreterPath(
  report: PythonInterpreterReport,
  interpreterPath: string | undefined
): boolean {
  const path = interpreterPath?.trim() ?? ""
  return report.source === "override"
    ? report.argv.length === 1 && report.argv[0] === path
    : path === ""
}
