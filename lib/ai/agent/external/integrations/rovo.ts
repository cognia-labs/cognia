/** App-owned bearer-authenticated Rovo service; wire types remain in its package. */
import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type { AgentFetch, AgentProcessHost } from "@cognia/agent-contracts/host"
import { RovoDevAdapter, type RovoDevServiceLauncher } from "@cognia/agent-rovo/client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
import { redactCredentialText } from "@/lib/security/redact-credentials"
import { spawnPlacementFor } from "@/lib/sandbox/spawn-placement-registry"
import { runsExternalAgentProcessesLocally } from "../agent-transport"
import { buildAgentEnv } from "../config/env-builder"
import { createAgentTransportProcessHost } from "../host/process-host"
import { configuredApprovalPolicy, isToolPreApproved } from "../policy/tool-preapproval"

function requireLocal(id: string): void {
  if (!runsExternalAgentProcessesLocally() || spawnPlacementFor(id))
    throw new Error(
      "Rovo service launch requires this local process host without a selected runtime environment"
    )
}
export function createRovoDevAdapter(
  processHost = createAgentTransportProcessHost("local"),
  fetch: AgentFetch = platformStreamingFetch
): RovoDevAdapter {
  return new RovoDevAdapter({
    fetch,
    launch: createRovoDevServiceLauncher(processHost, fetch),
    outboundGate: hasNoLeakingPiiDeep,
    redactDiagnostic: redactCredentialText,
    approvalPolicy: configuredApprovalPolicy,
    isToolPreApproved,
  })
}
export function createRovoDevAdapterFactory(
  processHost = createAgentTransportProcessHost("local"),
  fetch: AgentFetch = platformStreamingFetch
): ProtocolAdapterFactory {
  return () => createRovoDevAdapter(processHost, fetch)
}

export { RovoOwnershipError } from "@cognia/agent-rovo/service-launcher"
import { createRovoDevServiceLauncher as createLauncher } from "@cognia/agent-rovo/service-launcher"
export function createRovoDevServiceLauncher(
  processHost: AgentProcessHost,
  fetch: AgentFetch
): RovoDevServiceLauncher {
  return createLauncher(processHost, fetch, {
    assertLocal: requireLocal,
    resolveEnvironment: buildAgentEnv,
  })
}
