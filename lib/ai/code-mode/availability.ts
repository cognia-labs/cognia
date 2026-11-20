/**
 * Whether the Code tool presentation may be offered (ADR-0117, Phase 4).
 *
 * The rule this module exists to enforce is a single sentence from the ADR:
 * **when a strict sandbox is unavailable, Code fails closed with no degraded
 * path.** There is deliberately no "run it unsandboxed just this once" branch,
 * and no way for a caller to pass a flag that produces one — the only way to
 * reach `available` is for the execution Host to report that the sidecar it
 * runs was handed an OS confinement launcher for `run_code`.
 *
 * The Host's report is the only evidence that counts. The renderer cannot see
 * the sandbox (it is a child of the sidecar), and the generic ADR-0028 command
 * sandbox probe answers a different question: a confined `bash` says nothing
 * about whether this sidecar got a `run_code` launcher, and on a paired client
 * it describes the wrong machine. `claude_sidecar_status` is routed to the
 * execution Host and carries the launcher state of its live sidecar
 * generation (`cognia_sidecar::code_sandbox::CodeSandboxCapability`).
 *
 * The kill switches stay distinguishable from availability so the reasons a
 * user sees call for different responses: "this build turned Code off", "this
 * Host turned Code off", and "this Host cannot sandbox it".
 */

import type { ToolPresentationMode } from "@cognia/agent-config-types/agent-composition"

const BUILD_CODE_MODE_DISABLED = process.env.NEXT_PUBLIC_CODE_MODE_KILL === "1"

/** The renderer build's kill switch. `NEXT_PUBLIC_CODE_MODE_KILL=1` removes Code. */
export function isCodeModeKilled(environment?: Record<string, string | undefined>): boolean {
  if (!environment) return BUILD_CODE_MODE_DISABLED
  return environment.NEXT_PUBLIC_CODE_MODE_KILL === "1"
}

/**
 * Why Code cannot run for this turn. Machine-stable; rendered via
 * `agentComposition.axis.toolPresentation.unavailable.<reason>`.
 */
export type CodeModeUnavailableReason =
  /** The renderer build or the Host's `COGNIA_CODE_MODE_KILL` turned Code off. */
  | "killed"
  /** The Host has no OS confinement backend (Windows, Linux without `bwrap`). */
  | "no-backend"
  /** The Host could not create the scratch directory the policy grants. */
  | "no-scratch"
  /** The Host answered without a Code capability: an older Host, or the CLI's. */
  | "not-reported"
  /** No Host answered: web and mobile standalone, or the status call failed. */
  | "unreachable"

export const CODE_MODE_UNAVAILABLE_REASONS: readonly CodeModeUnavailableReason[] = Object.freeze([
  "killed",
  "no-backend",
  "no-scratch",
  "not-reported",
  "unreachable",
])

/** What the execution Host can do with `run_code`, as far as this renderer knows. */
export type CodeHostCapability =
  /** Asked, not answered yet. Offers nothing: a gap is not a yes. */
  | { state: "probing" }
  | {
      state: "available"
      backend: string
      /** The Host's sidecar generation the answer belongs to, when one is live. */
      generation?: number
    }
  | { state: "unavailable"; reason: CodeModeUnavailableReason }

export const CODE_HOST_PROBING: CodeHostCapability = Object.freeze({ state: "probing" })

const HOST_REASONS = new Set<string>(["killed", "no-backend", "no-scratch"])

/**
 * Read `claude_sidecar_status`'s `codeSandbox` field.
 *
 * Every malformed or missing shape is the fail-closed answer. An available
 * report must name its backend: a bare `available: true` is a claim, not a
 * launcher.
 */
export function parseCodeSandboxReport(status: unknown): CodeHostCapability {
  const report =
    status && typeof status === "object"
      ? (status as { codeSandbox?: unknown }).codeSandbox
      : undefined
  if (!report || typeof report !== "object") return { state: "unavailable", reason: "not-reported" }
  const { available, backend, reason, generation } = report as Record<string, unknown>
  if (available === true && typeof backend === "string" && backend.length > 0) {
    return {
      state: "available",
      backend,
      ...(typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
        ? { generation }
        : {}),
    }
  }
  return {
    state: "unavailable",
    reason:
      typeof reason === "string" && HOST_REASONS.has(reason)
        ? (reason as CodeModeUnavailableReason)
        : "not-reported",
  }
}

/** Presentations that are always available, regardless of host. */
const BASE_PRESENTATIONS: readonly ToolPresentationMode[] = ["native"]

/**
 * Presentations that need the sandbox.
 *
 * `both` is in here as well as `code`: it exposes the same `run_code` tool
 * alongside the native surface, so an unsandboxed host cannot offer it either.
 * Listing only `code` would leave `both` as an unguarded route to the same
 * executor.
 */
const SANDBOXED_PRESENTATIONS: readonly ToolPresentationMode[] = ["code", "both"]

/** Presentations that need the sandbox; the picker explains why they are off. */
export function isSandboxedPresentation(mode: string): boolean {
  return (SANDBOXED_PRESENTATIONS as readonly string[]).includes(mode)
}

/**
 * The `supportedToolPresentations` to hand `resolveComposition`.
 *
 * When Code is unavailable the value simply omits `code` and `both`, and the
 * composition resolver degrades such a selection to `native` with a visible
 * warning (ADR-0117). That is the whole fail-closed path: the resolver
 * already knows how to narrow, so this module does not need a second refusal
 * mechanism. The build kill switch wins over any Host report.
 */
export function supportedToolPresentations(
  capability: CodeHostCapability,
  environment?: Record<string, string | undefined>
): ToolPresentationMode[] {
  return capability.state === "available" && !isCodeModeKilled(environment)
    ? [...BASE_PRESENTATIONS, ...SANDBOXED_PRESENTATIONS]
    : [...BASE_PRESENTATIONS]
}

/**
 * The reason to show next to a disabled Code / Both option, or `"probing"`
 * while the Host has not answered. `null` when Code is offered.
 */
export function codeModeUnavailableReason(
  capability: CodeHostCapability,
  environment?: Record<string, string | undefined>
): CodeModeUnavailableReason | "probing" | null {
  if (isCodeModeKilled(environment)) return "killed"
  if (capability.state === "probing") return "probing"
  return capability.state === "available" ? null : capability.reason
}
