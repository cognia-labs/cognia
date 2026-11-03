/** ES-33: one machine-readable matrix. No React or native transport dependencies. */
import type {
  AuthMethod,
  PluginAuthProviderDef,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type { PluginRuntimeProfile } from "@/types/plugin"

export const EXTERNAL_SERVICE_RUNTIME_FACETS = [
  "auth-method:oauth-pkce",
  "auth-method:oauth-confidential",
  "auth-method:client-credentials",
  "auth-method:device-code",
  "auth-method:api-key",
  "auth:confidential-exchange",
  "auth:callback",
  "secrets:persistent",
  "network:cross-origin",
  "sync:background",
] as const
export type Facet = (typeof EXTERNAL_SERVICE_RUNTIME_FACETS)[number]
export type RuntimeRecoveryAction =
  | "use-desktop"
  | "pair-with-desktop"
  | "use-always-on-host"
  | "unlock-vault"
  | "use-another-method"
  | "keep-app-open"
export const RUNTIME_SUPPORT_REASONS = [
  "runtime-supported",
  "device-code-deferred",
  "no-interactive-browser",
  "confidential-exchange-unavailable",
  "no-external-callback",
  "non-persistent-until-vault-unlock",
  "vendor-cors-required",
  "background-sync-unavailable",
  "host-process-required",
] as const
export type RuntimeSupportReason = (typeof RUNTIME_SUPPORT_REASONS)[number]
/** Manifests may cite a matrix reason id in `runtimeCompatibility.<profile>.reason`. */
export function isRuntimeSupportReason(value: unknown): value is RuntimeSupportReason {
  return (RUNTIME_SUPPORT_REASONS as readonly unknown[]).includes(value)
}
export interface RuntimeSupportCell {
  availability: "supported" | "degraded" | "blocked"
  reason: RuntimeSupportReason
  recovery: RuntimeRecoveryAction[]
}
const cell = (
  availability: RuntimeSupportCell["availability"],
  reason: RuntimeSupportReason,
  recovery: RuntimeRecoveryAction[] = []
): RuntimeSupportCell => ({ availability, reason, recovery })
function host(interactive: boolean): Record<Facet, RuntimeSupportCell> {
  return {
    "auth-method:oauth-pkce": interactive
      ? cell("supported", "runtime-supported")
      : cell("blocked", "no-interactive-browser", ["use-another-method"]),
    "auth-method:oauth-confidential": interactive
      ? cell("supported", "runtime-supported")
      : cell("blocked", "no-interactive-browser", ["use-another-method"]),
    "auth-method:client-credentials": cell("supported", "runtime-supported"),
    "auth-method:device-code": cell("blocked", "device-code-deferred", ["use-another-method"]),
    "auth-method:api-key": cell("supported", "runtime-supported"),
    "auth:confidential-exchange": cell("supported", "runtime-supported"),
    "auth:callback": interactive
      ? cell("supported", "runtime-supported")
      : cell("blocked", "no-external-callback", ["use-another-method"]),
    "secrets:persistent": cell("supported", "runtime-supported"),
    "network:cross-origin": cell("supported", "runtime-supported"),
    "sync:background": cell("supported", "host-process-required", [
      "keep-app-open",
      "use-always-on-host",
    ]),
  }
}
function client(browser: boolean): Record<Facet, RuntimeSupportCell> {
  const confidential = () =>
    cell("blocked", "confidential-exchange-unavailable", [
      "pair-with-desktop",
      "use-always-on-host",
    ])
  return {
    ...host(true),
    "auth-method:oauth-confidential": confidential(),
    "auth-method:client-credentials": confidential(),
    "auth:confidential-exchange": confidential(),
    "secrets:persistent": browser
      ? cell("degraded", "non-persistent-until-vault-unlock", ["unlock-vault"])
      : cell("supported", "runtime-supported"),
    "network:cross-origin": cell("degraded", "vendor-cors-required", ["pair-with-desktop"]),
    "sync:background": cell("blocked", "background-sync-unavailable", [
      "pair-with-desktop",
      "use-always-on-host",
    ]),
  }
}
export const EXTERNAL_SERVICE_RUNTIME_SUPPORT: Record<
  PluginRuntimeProfile,
  Record<Facet, RuntimeSupportCell>
> = {
  browser: client(true),
  tauri: host(true),
  mobile: client(false),
  headless: host(false),
}
/**
 * Where each facet is served. A client with an active paired gateway forwards
 * confidential exchange and plugin network calls to that Host, but its secrets,
 * OAuth callbacks and background runtime stay local. A bare profile means both.
 */
export interface RuntimeSupportContext {
  local: PluginRuntimeProfile
  gateway: PluginRuntimeProfile
}
export type RuntimeSupportTarget = PluginRuntimeProfile | RuntimeSupportContext
/** Facets executed through the plugin gateway (`auth:exchange`, `network:fetch`). */
export const GATEWAY_RUNTIME_FACETS: ReadonlySet<Facet> = new Set<Facet>([
  "auth:confidential-exchange",
  "auth-method:client-credentials",
  "auth-method:oauth-confidential",
  "network:cross-origin",
])
export function runtimeProfileForFacet(
  facet: Facet,
  target: RuntimeSupportTarget
): PluginRuntimeProfile {
  if (typeof target === "string") return target
  return GATEWAY_RUNTIME_FACETS.has(facet) ? target.gateway : target.local
}
export function resolveRuntimeSupport(
  facet: Facet,
  target: RuntimeSupportTarget
): RuntimeSupportCell {
  return EXTERNAL_SERVICE_RUNTIME_SUPPORT[runtimeProfileForFacet(facet, target)][facet]
}
export class RuntimeSupportError extends Error {
  readonly code = "NOT_SUPPORTED"
  readonly reason: RuntimeSupportReason
  readonly recovery: RuntimeRecoveryAction[]
  constructor(
    readonly facet: Facet,
    readonly profile: PluginRuntimeProfile,
    support: RuntimeSupportCell
  ) {
    super(`External service unavailable: ${support.reason}`)
    this.name = "RuntimeSupportError"
    this.reason = support.reason
    this.recovery = [...support.recovery]
  }
}
export function assertRuntimeSupported(facet: Facet, target: RuntimeSupportTarget): void {
  const support = resolveRuntimeSupport(facet, target)
  if (support.availability === "blocked")
    throw new RuntimeSupportError(facet, runtimeProfileForFacet(facet, target), support)
}
export function authMethodFacets(method: AuthMethod, provider?: PluginAuthProviderDef): Facet[] {
  const facets: Facet[] = [`auth-method:${method}`]
  if (method === "oauth-pkce" || method === "oauth-confidential") facets.push("auth:callback")
  // An API key is entered by the user and never exchanged, so a confidential
  // token endpoint declared for the provider's OAuth methods does not apply.
  const usesTokenEndpoint = method !== "api-key"
  if (
    method === "client-credentials" ||
    method === "oauth-confidential" ||
    (usesTokenEndpoint &&
      provider?.tokenEndpoints?.some(
        (endpoint) => endpoint.clientSecret && endpoint.clientSecret !== "none"
      ))
  )
    facets.push("auth:confidential-exchange")
  if (method === "api-key") facets.push("secrets:persistent")
  return facets
}
/** Most restrictive prerequisite is also the reason displayed by every method picker. */
export function resolveAuthMethodSupport(
  method: AuthMethod,
  target: RuntimeSupportTarget,
  provider?: PluginAuthProviderDef
): RuntimeSupportCell {
  const cells = authMethodFacets(method, provider).map((facet) =>
    resolveRuntimeSupport(facet, target)
  )
  return (
    cells.find((entry) => entry.availability === "blocked") ??
    cells.find((entry) => entry.availability === "degraded") ??
    cells[0]
  )
}
export function renderRuntimeSupportTable(): string {
  const profiles = ["browser", "tauri", "mobile", "headless"] as const
  return [
    "| Facet | browser | tauri | mobile | headless |",
    "| --- | --- | --- | --- | --- |",
    ...EXTERNAL_SERVICE_RUNTIME_FACETS.map(
      (facet) =>
        `| ${facet} | ${profiles
          .map((profile) => {
            const c = resolveRuntimeSupport(facet, profile)
            return `${c.availability}: ${c.reason}${c.recovery.length ? ` (${c.recovery.join(", ")})` : ""}`
          })
          .join(" | ")} |`
    ),
  ].join("\n")
}
