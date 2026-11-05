/**
 * Lark's contribution to the vendor-neutral IM framework (ADR-0250 §14,
 * `lib/connectors/vendor-contribution.ts`). Listed in `../_vendors.ts`.
 *
 * Every framework file that reads the seam loads this module, so it imports
 * only light constants eagerly; each hook loads the code it needs.
 */

import type { ConnectorVendorContribution } from "@/lib/connectors/vendor-contribution"
import { LARK_CAPS } from "./capability"

export const larkContribution: ConnectorVendorContribution = {
  platform: "lark",
  capabilities: LARK_CAPS,
  buildAdapter: async (row) => (await import("./build")).buildLarkAdapter(row),
  loadIdentityProbe: async () => (await import("./whoami")).probeBotIdentity,
  completeOAuth: async (code, state) => {
    const { handleLarkOAuth } = await import("@/lib/auth-providers/feishu/oauth-handler")
    await handleLarkOAuth(code, { state })
  },
  passiveTransport: {
    // Only webhook mode waits for pushes; long-connection keeps its own socket health.
    applies: (row) => (row.settings as { transport?: string } | undefined)?.transport === "webhook",
    ping: async (row) => (await import("./health")).pingLark(row),
    failureReason: "lark_ping_failed",
  },
  avatar: {
    hosts: [
      "feishucdn.com",
      "larksuitecdn.com",
      "byteimg.com",
      "feishu.cn",
      "sf1-ttcdn-tos.pstatp.com",
    ],
    resolve: async (context) => (await import("./avatar")).resolveLarkAvatar(context),
  },
  // The chat-surface retry sweep and the bind-request expiry sweep. Without a
  // runtime-wide driver a surface that failed once stayed failed until a
  // restart (only adapter start, `bot.added` and the settings button retried
  // it), and an expired bind code stayed `pending`. They start once the
  // schedule module loads; disposing before then cancels the start.
  startRuntimeServices: () => {
    let disposed = false
    let handles: Array<{ dispose(): void }> = []
    void import("./surface-schedule")
      .then(({ startBindRequestExpirySweep, startLarkSurfaceSweep }) => {
        if (disposed) return
        handles = [startLarkSurfaceSweep(), startBindRequestExpirySweep()]
      })
      .catch((error: unknown) => {
        console.warn("[lark] runtime sweeps failed to start", error)
      })
    return [
      {
        dispose() {
          disposed = true
          for (const handle of handles) handle.dispose()
          handles = []
        },
      },
    ]
  },
}
