import { aiderRuntimePolicy } from "@cognia/agent-aider/manifest"
/** Composition root: packages own runtime behavior; this module supplies Host ports. */
import { acpRuntimePolicy } from "@cognia/agent-acp/runtime-policy"
import { codexRuntimePolicy } from "@cognia/agent-codex/runtime-policy"

import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import type { ProtocolAdapter } from "@cognia/agent-contracts/adapter"
import { ProtocolAdapterRegistry, protocolAdapterRegistry } from "../protocol-adapter"
import { createAcpAdapterFactory, isolateNativeAcp } from "./acp"
import { createAiderCliAdapterFactory } from "./aider"
import { createOpenClaudeAdapterFactory } from "./openclaude"
import { createCrushAdapterFactory } from "./crush"
import { createContinueAdapterFactory } from "./continue"
import { createRovoDevAdapterFactory } from "./rovo"
import { createCodebuffAdapterFactory } from "./codebuff"

import { createCodexAppServerAdapterFactory } from "./codex"
import { createSiwcAppServerAdapterFactory } from "./siwc"
import {
  openCodeV2RuntimePolicy,
  createOpenCodeV1AdapterFactory,
  createOpenCodeV2AdapterFactory,
} from "./opencode"
import { createA2aAdapterFactory } from "./a2a"
import { prepareDshManagedLaunch } from "@cognia/agent-dsh/managed-launch"
import { createDshSdkAdapterFactory, dshManagedLaunchHost } from "./dsh"
import { createPiRpcAdapterFactory, piRuntimePolicy } from "./pi"

export function registerBuiltinProtocolAdapters(registry: ProtocolAdapterRegistry): void {
  registry.register("acp", createAcpAdapterFactory(), acpRuntimePolicy)
  registry.register("codex-app-server", createCodexAppServerAdapterFactory(), codexRuntimePolicy)
  registry.register(
    "codex-siwc-app-server",
    createSiwcAppServerAdapterFactory(),
    codexRuntimePolicy
  )
  registry.register("opencode-v2", createOpenCodeV2AdapterFactory(), openCodeV2RuntimePolicy)
  registry.register("opencode", createOpenCodeV1AdapterFactory())
  registry.register("a2a", createA2aAdapterFactory())
  // Managed install/facts are local-host commands; the integration wiring
  // hands DSH the local process host (paired remote installation is not exposed).
  registry.register("dsh-sdk", createDshSdkAdapterFactory())
  // Pi's own RPC protocol, not ACP (ADR-0119).
  registry.register("pi-rpc", createPiRpcAdapterFactory(), piRuntimePolicy)
  registry.register("aider-cli", createAiderCliAdapterFactory(), aiderRuntimePolicy)
  registry.register("openclaude-cli", createOpenClaudeAdapterFactory())
  registry.register("crush-http", createCrushAdapterFactory())
  registry.register("continue-cli", createContinueAdapterFactory())
  registry.register("rovo-http", createRovoDevAdapterFactory())
  registry.register("codebuff-sdk", createCodebuffAdapterFactory())

  // Future: registry.register("http", () => new HttpClientAdapter())
}

/** Keep custom protocol factories authoritative; isolate only the built-in native Devin adapter. */
export function createConfiguredProtocolAdapter(
  config: ExternalAgentConfig
): ProtocolAdapter | undefined {
  return isolateNativeAcp(config, protocolAdapterRegistry.create(config.protocol))
}

export function prepareExternalAgentConnection(config: ExternalAgentConfig) {
  return prepareDshManagedLaunch(config, dshManagedLaunchHost)
}

export async function prepareExternalAgentTaskConfig(config: ExternalAgentConfig) {
  return (
    protocolAdapterRegistry.runtimePolicy(config.protocol).prepareTaskConfig?.(config) ?? config
  )
}
