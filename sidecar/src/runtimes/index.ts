import type { DispatchParams } from "./types.ts"
// Dispatch entry point — routes to the right runtime adapter.
//
// Returns the same `Session` shape regardless of runtime:
//   { q, pushUserMessage, closeInput, pendingApprovals, pendingPluginToolCalls }
//
// ADR-0090: every send carries a frozen execution spec
// (`sendOptions.execution`, resolved once by `resolveAgentExecutionSpec()`)
// naming its `runtimeAdapter`, and dispatch obeys it. The provider id is never
// re-interpreted: a send without a spec is refused before any runtime starts.
//
// Both runners support tool-calling (ADR-0043): the non-Anthropic path bridges
// built-in + plugin tools to native AI SDK tools and gates execution through the
// same `permission_request` round-trip (`pendingApprovals`). Plugin tools
// round-trip through `pendingPluginToolCalls`. A2UI remains Anthropic-only.

import {
  requestedRuntimeCapabilities,
  runtimeFeatureValidationError,
} from "@cognia/agent-contracts/session-operations"
import { runtimeFeatureSupported, capabilityError } from "./capabilities.ts"
import { resolveRuntimeAdapter } from "./registry.ts"

export const MISSING_EXECUTION_SPEC_ERROR =
  "send refused: no frozen execution spec (sendOptions.execution.runtimeAdapter is required)"

/** The frozen spec of a send, or a thrown refusal when the send carries none. */
export function requireFrozenExecution(sendOptions: DispatchParams["sendOptions"] | undefined) {
  const execution = sendOptions?.execution
  if (typeof execution?.runtimeAdapter !== "string" || execution.runtimeAdapter === "")
    throw new Error(MISSING_EXECUTION_SPEC_ERROR)
  return execution as typeof execution & { runtimeAdapter: string }
}

export function validateRuntimeFeatures(
  params: Pick<DispatchParams, "sendOptions" | "emit" | "sessionId">
) {
  const execution = requireFrozenExecution(params.sendOptions)
  const validationError = runtimeFeatureValidationError(params.sendOptions)
  if (validationError) throw new Error(validationError)
  for (const capability of requestedRuntimeCapabilities(params.sendOptions)) {
    if (!runtimeFeatureSupported(execution.runtimeAdapter, capability, execution)) {
      params.emit(capabilityError(params.sessionId, capability, "send"))
      throw new Error(`unsupported capability: ${capability}`)
    }
  }
}

export function dispatch(params: DispatchParams) {
  validateRuntimeFeatures(params)
  const adapterId = requireFrozenExecution(params.sendOptions).runtimeAdapter
  const adapter = resolveRuntimeAdapter(adapterId)
  if (!adapter) {
    // Fail closed: never guess a runtime. The two cases read differently on
    // purpose. `external` is a KNOWN adapter that this host cannot serve at
    // all (an external agent runs in the renderer's external-agent manager,
    // not here), so a frame carrying it means a turn was routed to the wrong
    // executor. Anything else is version skew between the resolver and this
    // host.
    throw new Error(
      adapterId === "external"
        ? 'runtimeAdapter "external" is not served by the sidecar: this turn belongs to the external-agent manager'
        : `unknown frozen runtimeAdapter: ${adapterId}`
    )
  }
  return adapter.dispatch(params)
}
