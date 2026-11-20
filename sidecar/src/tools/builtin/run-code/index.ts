// The `run_code` tool — the entire model-visible surface of the Code
// presentation (ADR-0117, Phase 4).
//
// In Code presentation the model is offered this one tool plus a `.d.ts` for
// the read-only SDK. Every `cognia.*` call inside the program re-enters the
// host's normal tool registry through `callTool`, so argument validation,
// permissions, confinement, logging and the canonical event stream all still
// apply. There is no path from generated code to a tool implementation that
// skips them.

import { z } from "zod"
import { tool } from "../../kernel/define.ts"
import type { ToolHandlerExtra } from "../../kernel/define.ts"

import { toolError, toolText } from "../../kernel/result.ts"
import type { ToolFailureMeta } from "../../kernel/result.ts"
import type { CodeRunFailurePhase, SandboxProbe } from "./supervisor.ts"
import type { SdkTool } from "./sdk-declaration.ts"
import { SandboxUnavailableError, probeSandbox, runCodeProgram } from "./supervisor.ts"
import { generateSdkDeclaration } from "./sdk-declaration.ts"

export const RUN_CODE_TOOL_NAME = "run_code"

const runCodeShape = {
  source: z
    .string()
    .describe(
      "JavaScript to run in the read-only sandbox. Runs as an async function body, " +
        "so top-level `await` and `return` both work. Call tools via `cognia.<tool>(input)`."
    ),
}

/** What `run_code` needs from the host. */
export interface RunCodeDeps {
  callTool: (name: string, input: unknown, extra?: ToolHandlerExtra) => Promise<unknown>
  probe?: (() => SandboxProbe) | undefined
  /**
   * The eligible tools, for the generated SDK declaration. Never empty: a
   * `run_code` with no API is a tool the model cannot use, so
   * `codeModeToolDefs` does not register one (CM-05).
   */
  sdkTools: readonly SdkTool[]
  /** Owner of the sandbox process group, so Stop and its proof reach it. */
  sessionId?: string | undefined
  groupProofSupported?: boolean | undefined
  /**
   * The session's process admission, aborted when its teardown starts: a
   * session that is stopping must not start a program (the same rule `bash`
   * follows).
   */
  processSignal?: AbortSignal | undefined
}

/** The failure kind a run's phase reports to the model and to telemetry. */
const PHASE_FAILURE: Readonly<Record<CodeRunFailurePhase, ToolFailureMeta>> = Object.freeze({
  // The program did not parse: fix the source, do not resend it.
  compile: { kind: "invalid-args", retryable: false },
  // The program threw. Whether a rerun helps depends on what it read.
  run: { kind: "execution-failed", retryable: true },
  cancelled: { kind: "aborted", retryable: false },
  // A ceiling, not a mistake in the call: repeating the same program hits it.
  limit: { kind: "resource-exhausted", retryable: false },
  sandbox: { kind: "environment", retryable: false },
})

/** Build the `run_code` tool definition. */
export function createRunCodeTool({
  callTool,
  probe = probeSandbox,
  sdkTools,
  sessionId,
  groupProofSupported,
  processSignal,
}: RunCodeDeps) {
  const description =
    "Run read-only JavaScript against the typed tool SDK. Cannot write, spawn, or reach the network." +
    `\n\n${generateSdkDeclaration(sdkTools)}`

  return tool(
    RUN_CODE_TOOL_NAME,
    description,
    runCodeShape,
    async (args, extra) => {
      try {
        const outcome = await runCodeProgram({
          source: String(args?.source ?? ""),
          // Each nested call carries the run's signal, which the turn's abort
          // and the run's own end both trip, so its approval wait and its
          // handler stop with the program.
          callTool: (name, input, signal) => callTool(name, input, { ...extra, signal }),
          probe: probe(),
          signal:
            processSignal && extra?.signal
              ? AbortSignal.any([processSignal, extra.signal])
              : (processSignal ?? extra?.signal),
          sessionId,
          groupProofSupported,
        })
        const tally = {
          callsUsed: outcome.callsUsed,
          ...(outcome.logs.length > 0 ? { logs: outcome.logs } : {}),
          ...(outcome.logsTruncated ? { logsTruncated: true } : {}),
          ...(outcome.stopUnconfirmed ? { stopUnconfirmed: true } : {}),
        }

        if (outcome.ok) return toolText({ result: outcome.result, ...tally })

        // A limit hit is reported with the ceiling that was reached, so the
        // model can shrink the program rather than retrying the same one.
        return toolText(
          {
            error: outcome.error,
            phase: outcome.phase,
            ...(outcome.limit ? { limit: outcome.limit } : {}),
            ...tally,
          },
          { isError: true, failure: { ...PHASE_FAILURE[outcome.phase] } }
        )
      } catch (error) {
        if (error instanceof SandboxUnavailableError) {
          // Fail closed, and say so plainly. There is deliberately no degraded
          // path here: an unsandboxed fallback is the one outcome this feature
          // must never produce.
          return toolError(
            `Code mode is unavailable on this host because a strict sandbox could not be established (${error.reason}). ` +
              "There is no unsandboxed fallback; use the native tools instead.",
            RUN_CODE_TOOL_NAME,
            { kind: "environment" }
          )
        }
        return toolError(error, RUN_CODE_TOOL_NAME)
      }
    },
    // The presentation's entry point: deferring it behind tool search leaves a
    // Code turn whose first step can only search for the one tool it has (CM-06).
    { alwaysLoad: true }
  )
}

/**
 * The tool defs for the Code presentation: `run_code` and nothing else.
 *
 * Returns an empty array when the host cannot sandbox, so a Code-mode turn on
 * an unsupported host has no executor to reach at all rather than one that
 * refuses per call — and when no eligible tool is permitted, because an SDK
 * with no functions is an executor that can only fail.
 */
export function codeModeToolDefs(deps: RunCodeDeps) {
  if (deps.sdkTools.length === 0) return []
  const probe = (deps.probe ?? probeSandbox)()
  if (!probe.canSpawnProcess || !probe.strictSandbox) return []
  return [createRunCodeTool(deps)]
}

export { generateSdkDeclaration } from "./sdk-declaration.ts"
export { NestedToolError } from "./supervisor.ts"

// The SDK declaration is generated HERE, from `sdk-declaration.ts`, because
// this is the only layer that has the tools' real `inputSchema`. The renderer
// only ever sees tool names, so a generator there would have had to invent
// signatures — and generated code that type-checks against an invented
// signature is worse than no declaration at all.
