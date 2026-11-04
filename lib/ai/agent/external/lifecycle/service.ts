/** Host assembly for the portable external-agent lifecycle service. */
import {
  ExternalAgentLifecycleService as CoreService,
  type LifecycleDependencies as CoreDependencies,
} from "@cognia/agent-runtime-kit/lifecycle/service"
import * as catalog from "../config/install-catalog"
import { externalAgentDuplicateInput } from "../config/duplicate-config"
import { externalAgentSandboxSupportsPlatform } from "../policy/security-policy"
import { EXTERNAL_AGENT_KEYRING_NAMESPACE } from "./credentials"
import type { RegistryDiscoveryResult } from "./registry-discovery"
export * from "@cognia/agent-runtime-kit/lifecycle/service"
export type LifecycleDependencies = Omit<
  CoreDependencies<RegistryDiscoveryResult>,
  "catalog" | "sandboxSupportsPlatform" | "duplicateConfig" | "discoverRegistry"
>
export class ExternalAgentLifecycleService extends CoreService<RegistryDiscoveryResult> {
  constructor(deps: LifecycleDependencies) {
    super({
      ...deps,
      catalog,
      sandboxSupportsPlatform: externalAgentSandboxSupportsPlatform,
      duplicateConfig: externalAgentDuplicateInput,
      discoverRegistry: async (platformKey) => {
        const { discoverRegistryAgents, registryCatalogEntry } =
          await import("./registry-discovery")
        const result = await discoverRegistryAgents({ platformKey })
        return {
          result,
          runtimes: result.entries
            .filter((entry) => entry.kind === "managed")
            .map((entry) =>
              registryCatalogEntry(entry, [catalog.normalizePlatform(platformKey.split("-")[0])])
            ),
        }
      },
    })
  }
}
// ============================================================================
// Production wiring
// ============================================================================

/**
 * Build the dependency set the app actually runs with.
 *
 * Exists — and is tested — because the injected-ports pattern has a standing
 * failure mode in this codebase: every test stubs the ports, so the real
 * wiring is the one path nothing exercises. If the store ever loses
 * `patchLifecycle`, or the manager's shape drifts from
 * {@link LifecycleRuntimeManager}, this function is where it surfaces.
 */
export async function createDefaultLifecycleDependencies(): Promise<LifecycleDependencies> {
  const [{ useExternalAgentStore }, { getExternalAgentManager }, { protocolAdapterRegistry }] =
    await Promise.all([
      import("@/stores/agent/external-agent-store"),
      import("../manager"),
      import("../protocol-adapter"),
    ])
  const { createKeyringStore } = await import("@/lib/credentials/keyring-store")
  const { getDeviceId } = await import("@/lib/device/device-identity")
  const { EXTERNAL_AGENT_SECURITY_POLICY_VERSION } = await import("../policy/security-policy")
  const { createHostRuntimeHost } = await import("./native-runtime-host")
  const { removeExternalAgentStateRoot } = await import("./state-root")

  const state = () => useExternalAgentStore.getState()

  return {
    store: {
      getAgent: (id) => state().getAgent(id),
      getAllAgents: () => state().getAllAgents(),
      addAgent: (input) => state().addAgent(input),
      updateAgent: (id, updates) => state().updateAgent(id, updates),
      removeAgent: (id) => state().removeAgent(id),
      replaceAgentConfig: (id, config) => state().replaceAgentConfig(id, config),
      patchLifecycle: (id, fields) => state().patchLifecycle(id, fields),
      setConnectionStatus: (id, status) => state().setConnectionStatus(id, status),
    },
    manager: getExternalAgentManager(),
    adapters: {
      isProtocolAvailable: (protocol) => protocolAdapterRegistry.has(protocol),
    },
    keyring: createKeyringStore(EXTERNAL_AGENT_KEYRING_NAMESPACE),
    stateRoots: { remove: removeExternalAgentStateRoot },
    // Absent on a host with no processes (browser, Capacitor). The service
    // then refuses every runtime operation with `platform_unsupported`, which
    // is the truth: such a host cannot see what is installed, let alone
    // install anything.
    runtimeHost: await createHostRuntimeHost(),
    // A host with no stable device identity gets a per-process one, which makes
    // every stored consent fail its host check rather than silently apply.
    hostId: (await getDeviceId()) ?? `ephemeral:${Math.random().toString(36).slice(2)}`,
    platform: detectPlatform(),
    policyRevision: EXTERNAL_AGENT_SECURITY_POLICY_VERSION,
    now: () => new Date(),
  }
}

/**
 * This host's Node-style platform id.
 *
 * A browser renderer has no platform and no spawn path either, so it reports
 * the one platform where the sandbox is always available — the same fallback
 * `externalAgentSandboxSupportsPlatform` makes, kept consistent so the two
 * cannot disagree about whether a web shell may configure an agent.
 */
function detectPlatform(): string {
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform
  }
  return "darwin"
}

let cachedService: ExternalAgentLifecycleService | null = null

/** The process-wide lifecycle service. */
export async function getExternalAgentLifecycleService(): Promise<ExternalAgentLifecycleService> {
  if (!cachedService) {
    cachedService = new ExternalAgentLifecycleService(await createDefaultLifecycleDependencies())
  }
  return cachedService
}

/** Drop the cached service. Tests only. */
export function __resetLifecycleServiceForTests(): void {
  cachedService = null
}
