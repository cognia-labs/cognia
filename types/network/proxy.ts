/**
 * Moved to `@cognia/plugin-contract`, which owns the plugin contract types.
 * This re-export keeps host imports of `@/types/network/proxy` working.
 */
export * from "@cognia/plugin-contract/types/network/proxy"

import type { ProxyRuntimeStatus } from "@cognia/plugin-contract/types/network/proxy"

/**
 * A long-lived process that carries the proxy policy in its environment
 * (`cognia_net::proxy_config::application::OwnerKind`). Host-only: plugins do
 * not see `proxy_get_active`, so this stays out of the plugin contract.
 */
export type ProxyOwnerKind = "agent-runtime"

/** One live owner and whether it runs on the published policy revision. */
export interface ProxyOwnerApplication {
  owner: ProxyOwnerKind
  /** How a new policy reaches it: only a replacement process sees it. */
  update: "process-restart"
  /** Opaque revision label it was started with. */
  appliedRevision: string
  state: "current" | "restart-pending"
}

/**
 * `proxy_get_active`. Every field past {@link ProxyRuntimeStatus} is absent
 * on an older Host; absent means unknown, never "all current".
 */
export interface ProxyActiveStatus extends ProxyRuntimeStatus {
  /** Opaque label of the published policy, bound to this Host process. */
  revision?: string
  downloadPolicyVersion?: number
  requestAdmissionVersion?: number
  applications?: ProxyOwnerApplication[]
}
