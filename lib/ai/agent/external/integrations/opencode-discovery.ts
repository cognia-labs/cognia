/** OpenCode v2 discovery through the Host's feature-call channel. */
import {
  validateOpenCodeV2Discovery,
  type OpenCodeV2Discovery,
} from "@cognia/agent-opencode/discovery"

import { defaultClient } from "@/lib/ai/agent/execution/sidecar-feature-client"

export async function discoverOpenCodeV2ViaSidecar(
  abortSignal?: AbortSignal
): Promise<OpenCodeV2Discovery> {
  const result = await defaultClient.requestResult(
    {
      operation: "opencode-v2-discover",
      credentials: {},
    },
    abortSignal
  )
  return validateOpenCodeV2Discovery(result)
}
