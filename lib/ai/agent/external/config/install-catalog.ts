/** Bind pure catalog algorithms to the one governed app catalog. */
import CATALOG from "@/protocol/external-agent-runtimes.json"
import { createRuntimeCatalog } from "@cognia/agent-runtime-kit/lifecycle/catalog"
import type { ExternalAgentRuntimeCatalog } from "@cognia/agent-contracts/external-agent-lifecycle"
import { externalAgentPresetIdOf } from "./preset-identity"
import { baseCommandName } from "../policy/security-policy"
export * from "@cognia/agent-runtime-kit/lifecycle/catalog"
export const runtimeCatalog = createRuntimeCatalog(
  CATALOG as unknown as ExternalAgentRuntimeCatalog,
  { presetId: externalAgentPresetIdOf, baseCommandName }
)
export const {
  EXTERNAL_AGENT_RUNTIME_CATALOG_VERSION,
  EXTERNAL_AGENT_RUNTIMES,
  UNPINNED_LAUNCH_WAIVERS,
  findRuntimeById,
  findRuntimeByPresetId,
  catalogedPresetIds,
  findRuntimeForConfig,
  deriveRuntimeBinding,
  normalizePlatform,
  runtimeSupportsPlatform,
  isDistributionInstallable,
  selectDistribution,
  resolveSystemLaunch,
  isUnpinnedLaunch,
  hasUnpinnedLaunchWaiver,
  canonicalLaunchCommandString,
  isWindowsExceptionEligible,
  offeredProviders,
  hasJsProviderChoice,
} = runtimeCatalog
