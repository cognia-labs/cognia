/** Hermes uses the Host's verified process, state-root and bridge ports. */
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import {
  createHermesControlledDaemonHost as createCoordinator,
  type HermesControlledDaemonDeps as CoordinatorDeps,
} from "@cognia/agent-acp/hermes-daemon"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { normalizeFsPath } from "@/lib/files/permissions"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import { agentInvoke, runsExternalAgentProcessesLocally } from "../agent-transport"
import { buildAgentEnv } from "../config/env-builder"
import { resolveBundledAgentBridge } from "../host/native-bridge"
import { createAgentTransportProcessHost } from "../host/process-host"
import { getExternalAgentStateRootInfo } from "../lifecycle/state-root"
import { AGENT_STATE_KEY_ENV, AGENT_STATE_KEY_PATTERN } from "../policy/security-policy"

export function hermesStateKey(configId: string): string {
  if (!AGENT_STATE_KEY_PATTERN.test(configId))
    throw new Error("Hermes requires a valid original configuration state key")
  return configId
}
export function createHermesControlledDaemonHost(deps: HermesControlledDaemonDeps) {
  return createCoordinator({
    ...deps,
    ownsLocalProcesses: () => deps.ownsLocalProcesses(),
    fingerprint: (text) => bytesToHex(sha256(utf8ToBytes(text))),
    normalizePath: normalizeFsPath,
    isWithinRoot: isPathUnderRoot,
    stateKey: hermesStateKey,
    stateKeyEnv: AGENT_STATE_KEY_ENV,
  })
}
export type HermesControlledDaemonDeps = Omit<
  CoordinatorDeps,
  "fingerprint" | "normalizePath" | "isWithinRoot" | "stateKey" | "stateKeyEnv"
>
let defaultPrepare: ReturnType<typeof createHermesControlledDaemonHost> | undefined
export function prepareHermesControlledDaemon(config: ExternalAgentConfig) {
  defaultPrepare ??= createHermesControlledDaemonHost({
    processHost: createAgentTransportProcessHost("local"),
    ownsLocalProcesses: runsExternalAgentProcessesLocally,
    stateRootInfo: getExternalAgentStateRootInfo,
    processInfo: (id) => agentInvoke("get_external_agent_info", { agentId: id }),
    resolveBridge: resolveBundledAgentBridge,
    resolveEnvironment: buildAgentEnv,
  })
  return defaultPrepare(config)
}
