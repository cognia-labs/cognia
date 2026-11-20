// The Code tool presentation (ADR-0117 Phase 4), folded over an assembled
// native tool surface.

import type { ToolDefinition, ToolHandlerExtra } from "../kernel/define.ts"
import { parseToolArgs, toolInputJsonSchema } from "../kernel/args.ts"
import { classifyToolFailure } from "../kernel/failure.ts"
import type { ToolFailureMeta } from "../kernel/result.ts"
import { NestedToolError, RUN_CODE_TOOL_NAME, codeModeToolDefs } from "../builtin/run-code/index.ts"
import { isProgrammaticReadOnly } from "../builtin/run-code/eligibility.ts"
import { codeRunCallFrame } from "../builtin/run-code/trace.ts"
import { bareToolName } from "../../policy/confinement/classify.ts"
import { BUILTIN_SERVER_NAME } from "../../policy/tool-catalog/catalog.ts"

export interface ToolPresentationOptions {
  isToolAllowed?: ((name: string) => boolean) | undefined
  /**
   * The deny list alone. `run_code` is admitted by it rather than by
   * `isToolAllowed`: a palette's allow list names native tools, and the
   * entry can reach only the allowed ones it wraps, so an allow list that
   * omits it must not remove the presentation the composition chose (CM-05).
   * An explicit deny still removes it.
   */
  isToolDenied?: ((name: string) => boolean) | undefined
  /** Owner of `run_code`'s process group, for Stop and its proof. */
  sessionId?: string | undefined
  groupProofSupported?: boolean | undefined
  /** The session's process admission; aborted once its teardown starts. */
  processSignal?: AbortSignal | undefined
  /**
   * The session's frame stream. `run_code` reports its nested calls on it
   * (CM-12); a surface without one reports nothing.
   */
  emit?: ((frame: Record<string, unknown>) => void) | undefined
  authorizeTool?:
    | ((
        name: string,
        input: unknown,
        extra?: ToolHandlerExtra,
        validateInput?: (input: unknown) => unknown
      ) => Promise<unknown>)
    | undefined
  /** Rail-specific execution review and output safety, after authorization. */
  executeTool?:
    | ((def: ToolDefinition, input: unknown, extra?: ToolHandlerExtra) => Promise<unknown>)
    | undefined
}

/**
 * Fold the Code presentation over an assembled native tool list.
 *
 * `native` (and anything unrecognised) returns the list untouched, so a turn
 * that never resolved a composition behaves exactly as it did before ADR-0117.
 * `code` replaces the surface with `run_code` alone; `both` appends it.
 *
 * When the host cannot sandbox, `codeModeToolDefs` returns an empty list, and
 * `code` presentation then yields NO tools at all rather than the native ones.
 * That is deliberate: silently handing back the native surface would be the
 * degraded fallback the ADR forbids, and it would do it invisibly.
 */
export function applyToolPresentation<D extends ToolDefinition>(
  nativeDefs: readonly D[],
  presentation: string | undefined,
  options: ToolPresentationOptions = {}
): readonly (D | ToolDefinition)[] {
  if (presentation !== "code" && presentation !== "both") return nativeDefs

  const permitted = nativeDefs.filter(
    (def) => options.isToolAllowed?.(bareToolName(def.name)) !== false
  )
  const byName = new Map(permitted.map((def) => [bareToolName(def.name), def]))
  const callTool = async (name: string, input: unknown, extra?: ToolHandlerExtra) => {
    const def = byName.get(name)
    if (!def || options.isToolAllowed?.(name) === false) {
      // Reached when the tool is eligible in principle but its category is
      // switched off for this session. Saying so beats a generic failure.
      throw new NestedToolError(`tool "${name}" is not enabled in this session`, {
        kind: "permission-denied",
        retryable: false,
      })
    }
    // Parse before dispatch, exactly as the Anthropic, ai-sdk and MCP-bridge
    // rails do. Generated code is model-authored, so without this every
    // `.default()`/`.min()`/`.max()` on the def is inert here and nowhere else
    // — `content_search`'s `maxResults` cap would vanish (`length >= undefined`
    // is always false) — and a wrong-typed field would surface as a TypeError
    // deep inside a handler instead of a validation message the model can act
    // on. It also makes the declaration's "the same argument validation still
    // applies" claim true rather than aspirational.
    const parsed = parseToolArgs(def.inputSchema, input)
    if (!parsed.ok) throw invalidArgs(name, parsed.message)
    if (!options.authorizeTool) throw new Error(`tool "${name}" has no nested-call authorizer`)
    const effective = await options.authorizeTool(
      `mcp__${BUILTIN_SERVER_NAME}__${name}`,
      parsed.value,
      extra,
      (input) => {
        const rewritten = parseToolArgs(def.inputSchema, input)
        if (!rewritten.ok) throw invalidArgs(name, rewritten.message)
        return rewritten.value
      }
    )
    const reparsed = parseToolArgs(def.inputSchema, effective)
    if (!reparsed.ok) throw invalidArgs(name, reparsed.message)
    if (extra?.signal?.aborted) {
      throw new NestedToolError(`tool "${name}" interrupted`, { kind: "aborted", retryable: false })
    }
    const result = options.executeTool
      ? await options.executeTool(def, reparsed.value, extra)
      : await def.handler(reparsed.value, extra)
    // One contract on both rails (CM-08): a failed tool rejects the program's
    // promise with its classified kind. The AI SDK rail hands back an error
    // envelope here and the Claude SDK rail used to resolve the program with
    // the same envelope, so one missing file was a throw on one rail and a
    // value on the other.
    const failed = errorEnvelope(result)
    if (failed) throw new NestedToolError(failed.text || `${name} failed`, failed.failure)
    return result
  }

  // The SDK declaration is rendered from the defs this session actually
  // assembled, so it advertises exactly what the broker can reach — a tool the
  // user disabled never appears in the API the model is shown. The defs carry
  // zod raw shapes; the renderer reads JSON Schema, so convert here or every
  // signature silently degrades to `input: unknown`.
  const sdkTools = permitted
    .filter((def) => isProgrammaticReadOnly(bareToolName(def.name)))
    .map((def) => ({
      name: bareToolName(def.name),
      description: def.description,
      inputSchema: toolInputJsonSchema(def.inputSchema),
    }))

  const codeDefs = options.isToolDenied?.(RUN_CODE_TOOL_NAME)
    ? []
    : (codeModeToolDefs({
        callTool,
        sdkTools,
        sessionId: options.sessionId,
        groupProofSupported: options.groupProofSupported,
        processSignal: options.processSignal,
        reportCall: options.emit
          ? (report) => options.emit!(codeRunCallFrame(options.sessionId, report))
          : undefined,
      }) as ToolDefinition[])
  return presentation === "code" ? codeDefs : [...permitted, ...codeDefs]
}

function invalidArgs(name: string, message: string): NestedToolError {
  return new NestedToolError(`invalid arguments for "${name}": ${message}`, {
    kind: "invalid-args",
    retryable: false,
  })
}

/** The text and classification of an MCP error result, or null for a success. */
function errorEnvelope(result: unknown): { text: string; failure: ToolFailureMeta } | null {
  if (!result || typeof result !== "object" || (result as { isError?: unknown }).isError !== true)
    return null
  const content = (result as { content?: unknown }).content
  const text = Array.isArray(content)
    ? content
        .map((block) =>
          block && typeof block === "object" && (block as { type?: unknown }).type === "text"
            ? String((block as { text?: unknown }).text ?? "")
            : ""
        )
        .filter(Boolean)
        .join("\n")
    : ""
  const meta = (result as { _meta?: { "cognia/failure"?: Partial<ToolFailureMeta> } })._meta?.[
    "cognia/failure"
  ]
  // The tool's own classification wins when it names a known kind; the prose
  // is classified the same way `toolError` would otherwise.
  const classified = classifyToolFailure(text, { kind: meta?.kind })
  const retryable =
    classified.kind === meta?.kind && typeof meta.retryable === "boolean"
      ? meta.retryable
      : classified.retryable
  return { text, failure: { kind: classified.kind, retryable } }
}
