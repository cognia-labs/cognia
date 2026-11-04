/** Package-authored slot capabilities, resolved through the Host gateway registry. */
import type { GatewayRuntimeConfig } from "@cognia/agent-contracts/gateway-task"
import { gatewayModelSlots as resolveGatewayModelSlots } from "./gateway-task"

export type { AgentModelSlotDescriptor } from "@cognia/agent-contracts/gateway-task"

// A hoisted declaration, not a re-export: model-option mocks load this module
// while `gateway-task` is still initializing.
export function gatewayModelSlots(config: GatewayRuntimeConfig) {
  return resolveGatewayModelSlots(config)
}
