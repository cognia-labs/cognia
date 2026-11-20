/**
 * Ask the execution Host whether it can run `run_code` (ADR-0117, Phase 4).
 *
 * `claude_sidecar_status` is an `execution`-target command, so on a paired
 * client or a desktop bound to a remote Host the routing transport sends it
 * to that Host — the one whose sidecar will register (or refuse) `run_code`
 * for the next turn. Not cached here: the picker hook holds its own answer and
 * re-asks when the Host or the sidecar generation changes, and the send path
 * asks once per turn that requested Code, because a stale "yes" would offer a
 * surface the sidecar then has to refuse.
 */

import { transport } from "@/lib/tauri"
import { parseCodeSandboxReport, supportedToolPresentations } from "./availability"
import type { CodeHostCapability } from "./availability"
import type { ToolPresentationMode } from "@cognia/agent-config-types/agent-composition"

/** The status command the capability rides on. */
export const CODE_HOST_STATUS_COMMAND = "claude_sidecar_status"

export async function readCodeHostCapability(): Promise<CodeHostCapability> {
  try {
    return parseCodeSandboxReport(await transport.call<unknown>(CODE_HOST_STATUS_COMMAND))
  } catch {
    // Web and mobile standalone have no Host to ask; a failed call is the
    // fail-closed answer, never "probably fine".
    return { state: "unavailable", reason: "unreachable" }
  }
}

/** The presentations the execution Host can run right now. */
export async function readCodeHostToolPresentations(): Promise<ToolPresentationMode[]> {
  return supportedToolPresentations(await readCodeHostCapability())
}
