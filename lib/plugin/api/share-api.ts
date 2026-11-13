/**
 * Plugin Share API (`ctx.share`) — create / revoke / inspect the app's
 * zero-knowledge public share links (ADR-0037) from a plugin.
 *
 * Wraps the owner-side `lib/share/client.ts` service + the local Dexie
 * mirror (`lib/db/shared-links.ts`). The encryption key never leaves the
 * client — `create` returns the full URL (with the `#k=` fragment); the
 * worker only ever stores the opaque encrypted envelope.
 *
 * SAFETY: `create`/`revoke`/`delete` mutate public state — creating a link
 * publishes (encrypted) data to the external share worker, so they need
 * `share:create` (a `DANGEROUS` permission: outward-facing egress).
 * Listing the local mirror + reading owner stats is `share:read`.
 */

import { createShareLink, revokeShareLink, getShareStats } from "@/lib/share/client"
import { listSharedLinks, getSharedLinkByCode, deleteSharedLink } from "@/lib/db/shared-links"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { pluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
import { assertPersonalSink, personalSinkContextForRun } from "@/lib/execution/personal-sink"
import type { PluginShareAPI } from "@cognia/plugin-contract/lib/plugin/api/share-api"
export type { PluginShareAPI } from "@cognia/plugin-contract/lib/plugin/api/share-api"

/**
 * Create the Share API for a plugin. `list`/`getByCode`/`getStats` need
 * `share:read`; `create`/`revoke`/`delete` need `share:create`.
 */
export function createShareAPI(pluginId: string): PluginShareAPI {
  const api: PluginShareAPI = {
    create: async (input) => {
      const source = pluginExecutionContext(pluginId) ?? {}
      await assertPersonalSink(
        personalSinkContextForRun(source, "plugin invocation unavailable"),
        { kind: "unknown", label: "public share" },
        // Plugins may supply file streams as well as JSON; the exact outbound
        // bytes are not available at this boundary, so no disclosure is possible.
        undefined,
        { kind: "public-share", pluginId }
      )
      return createShareLink(input, undefined, source)
    },
    revoke: (code) => revokeShareLink(code, undefined, pluginExecutionContext(pluginId)),
    list: (opts) => listSharedLinks(opts),
    getByCode: async (code) => (await getSharedLinkByCode(code)) ?? null,
    getStats: (code) => getShareStats(code, undefined, pluginExecutionContext(pluginId)),
    delete: (code) => deleteSharedLink(code),
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      list: "share:read",
      getByCode: "share:read",
      getStats: "share:read",
      create: "share:create",
      revoke: "share:create",
      delete: "share:create",
    },
    { egressMethods: ["create", "revoke", "getStats"] }
  )
}
