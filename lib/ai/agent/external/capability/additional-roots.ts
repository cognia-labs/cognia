/**
 * Whether an external agent takes more than one workspace root (ADR-0147,
 * 2026-11-08 amendment; ADR-0090 external SSOT).
 *
 * A multi-repository run gives an agent the task copies of the workspace's
 * other repositories as extra roots beside its working directory. Only an
 * agent whose capability profile says it takes them
 * (`workspace.additional-roots` is `native` or `equivalent`) is handed them;
 * every other one works in the primary repository only, as the capability
 * matrix says. That covers the documented refusals (Codex's static
 * `writableRoots`, Aider's one workspace per session, A2A's remote agent, an
 * OpenCode V2 session's single location) and `unknown` alike: an ACP agent
 * that did not advertise `sessionCapabilities.additionalDirectories` at its
 * handshake would refuse the whole session if it were handed them.
 */

import {
  isCapabilityUsable,
  type ExternalAgentCapabilityProfileV1,
} from "@cognia/agent-config-types/external-agent-capability"

export function acceptsAdditionalRoots(
  profile: Pick<ExternalAgentCapabilityProfileV1, "effective"> | null | undefined
): boolean {
  const cell = profile?.effective["workspace.additional-roots"]
  return cell ? isCapabilityUsable(cell.level) : false
}
