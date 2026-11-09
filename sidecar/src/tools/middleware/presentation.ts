// The Code tool presentation (ADR-0117 Phase 4), folded over an assembled
// native tool surface.

import type { ToolDefinition, ToolHandlerExtra } from "../kernel/define.ts"
import { parseToolArgs, toolInputJsonSchema } from "../kernel/args.ts"
import { codeModeToolDefs } from "../builtin/run-code/index.ts"
import { isProgrammaticReadOnly } from "../builtin/run-code/eligibility.ts"
import { bareToolName } from "../../policy/confinement/classify.ts"
import { BUILTIN_SERVER_NAME } from "../../policy/tool-catalog/catalog.ts"

export interface ToolPresentationOptions {
  isToolAllowed?: ((name: string) => boolean) | undefined
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
      throw new Error(`tool "${name}" is not enabled in this session`)
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
    if (!parsed.ok) throw new Error(`invalid arguments for "${name}": ${parsed.message}`)
    if (!options.authorizeTool) throw new Error(`tool "${name}" has no nested-call authorizer`)
    const effective = await options.authorizeTool(
      `mcp__${BUILTIN_SERVER_NAME}__${name}`,
      parsed.value,
      extra,
      (input) => {
        const rewritten = parseToolArgs(def.inputSchema, input)
        if (!rewritten.ok) throw new Error(`invalid arguments for "${name}": ${rewritten.message}`)
        return rewritten.value
      }
    )
    const reparsed = parseToolArgs(def.inputSchema, effective)
    if (!reparsed.ok) throw new Error(`invalid arguments for "${name}": ${reparsed.message}`)
    if (extra?.signal?.aborted) throw new Error(`tool "${name}" interrupted`)
    return options.executeTool
      ? await options.executeTool(def, reparsed.value, extra)
      : await def.handler(reparsed.value, extra)
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

  const codeDefs = codeModeToolDefs({ callTool, sdkTools }) as ToolDefinition[]
  return presentation === "code" ? codeDefs : [...permitted, ...codeDefs]
}
