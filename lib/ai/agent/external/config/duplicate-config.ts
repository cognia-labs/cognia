import { agentStateIsolationFor } from "../policy/security-policy"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import {
  externalAgentDuplicateInput as duplicate,
  duplicateDroppedEnvKeys as dropped,
  type ExternalAgentDuplicateOptions,
} from "@cognia/agent-runtime-kit/lifecycle/duplicate-config"
export {
  uniqueDuplicateName,
  type ExternalAgentDuplicateOptions,
} from "@cognia/agent-runtime-kit/lifecycle/duplicate-config"
const isolationEnvKeys = (config: ExternalAgentConfig) =>
  Object.keys(
    agentStateIsolationFor(config.process!.command, config.process?.args ?? [])?.env ?? {}
  )
export function externalAgentDuplicateInput(
  source: ExternalAgentConfig,
  options: ExternalAgentDuplicateOptions | string
) {
  return duplicate(source, options, isolationEnvKeys)
}
export function duplicateDroppedEnvKeys(source: ExternalAgentConfig) {
  return dropped(source, isolationEnvKeys)
}
