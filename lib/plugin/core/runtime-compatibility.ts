import type {
  ExtensionCompatibilityDiagnostic,
  PluginManifest,
  PluginRuntimeProfile,
} from "@/types/plugin"
import {
  resolveAuthMethodSupport,
  resolveRuntimeSupport,
  type RuntimeSupportTarget,
} from "@/lib/external-services/runtime-support"

/**
 * Resolve one plugin's declared availability for a concrete host profile.
 * `supportTarget` lets a client with a paired gateway judge exchange and
 * network facets on that Host; it defaults to the profile itself.
 */
export function collectPluginRuntimeProfileDiagnostics(
  manifest: PluginManifest,
  runtimeProfile: PluginRuntimeProfile,
  supportTarget: RuntimeSupportTarget = runtimeProfile
): ExtensionCompatibilityDiagnostic[] {
  const declared = collectDeclaredDiagnostics(manifest, runtimeProfile)
  const derived: ExtensionCompatibilityDiagnostic[] = []
  for (const provider of manifest.authProviders ?? []) {
    const methods = provider.methods ?? ["oauth-pkce"]
    const support = methods.map((method) => ({
      method,
      ...resolveAuthMethodSupport(method, supportTarget, provider),
    }))
    const allBlocked = support.every((entry) => entry.availability === "blocked")
    for (const entry of support) {
      if (entry.availability === "supported") continue
      derived.push({
        code: `runtime.${runtimeProfile}.auth.${provider.id}.${entry.method}`,
        severity: allBlocked ? "error" : "warning",
        field: `authProviders.${provider.id}.methods`,
        message: `${provider.label}: ${entry.method}: ${entry.reason}`,
        reason: entry.reason,
        recovery: [...entry.recovery],
      })
    }
  }
  const addFacet = (facet: "sync:background" | "network:cross-origin") => {
    const entry = resolveRuntimeSupport(facet, supportTarget)
    if (entry.availability === "supported") return
    derived.push({
      code: `runtime.${runtimeProfile}.${facet}`,
      severity: "warning",
      message: `${facet}: ${entry.reason}`,
      reason: entry.reason,
      recovery: [...entry.recovery],
    })
  }
  if (manifest.permissions?.includes("sync:run")) addFacet("sync:background")
  const networkDomains = [
    ...(manifest.networkAccess?.allowedDomains ?? []),
    ...(manifest.networkAccess?.rules?.map((rule) => rule.domain) ?? []),
  ]
  if (
    networkDomains.some((domain) => !["localhost", "127.0.0.1", "[::1]"].includes(domain)) &&
    (runtimeProfile === "browser" || runtimeProfile === "mobile")
  )
    addFacet("network:cross-origin")
  // plugin-contract has zero Host aliases, so the honesty warning lives here.
  if (
    manifest.runtimeCompatibility?.[runtimeProfile]?.availability === "supported" &&
    derived.some((entry) => entry.severity === "error")
  ) {
    derived.push({
      code: `runtime.${runtimeProfile}.declaration-mismatch`,
      severity: "warning",
      field: `runtimeCompatibility.${runtimeProfile}`,
      message: `Declared support conflicts with Host-derived runtime requirements.`,
    })
  }
  return [...declared, ...derived]
}

function collectDeclaredDiagnostics(
  manifest: PluginManifest,
  runtimeProfile: PluginRuntimeProfile
): ExtensionCompatibilityDiagnostic[] {
  const compatibilityMap = manifest.runtimeCompatibility
  let compatibility = compatibilityMap?.[runtimeProfile]
  let fallbackSurface: "browser" | "tauri" | undefined

  if (!compatibility && runtimeProfile === "mobile") {
    fallbackSurface = "browser"
    compatibility = compatibilityMap?.browser
  } else if (!compatibility && runtimeProfile === "headless") {
    const nativeOrNodeTarget =
      manifest.type !== "frontend" ||
      Boolean(manifest.engines?.node || compatibilityMap?.tauri?.entrypoint === "node")
    fallbackSurface = nativeOrNodeTarget ? "tauri" : "browser"
    compatibility = compatibilityMap?.[fallbackSurface]
  }

  const fallbackNote = fallbackSurface ? ` (inherited from ${fallbackSurface} compatibility)` : ""
  if (!compatibility) {
    if (runtimeProfile === "tauri") return []
    return [
      {
        code: `runtime.${runtimeProfile}.unsupported`,
        severity: "error",
        message: `Plugin ${manifest.id} does not declare ${runtimeProfile} runtime compatibility.`,
        hint: `Add ${runtimeProfile} runtime compatibility metadata before enabling this plugin in ${runtimeProfile} mode.`,
      },
    ]
  }
  if (compatibility.availability === "supported") return []
  if (compatibility.availability === "degraded") {
    return [
      {
        code: `runtime.${runtimeProfile}.degraded`,
        severity: "warning",
        message:
          compatibility.reason ||
          `Plugin ${manifest.id} is only partially supported in ${runtimeProfile} runtime${fallbackNote}.`,
        hint: compatibility.entrypoint
          ? `${runtimeProfile} bundle entrypoint: ${compatibility.entrypoint}`
          : undefined,
        reason: compatibility.reason,
        recovery: compatibility.recovery,
      },
    ]
  }
  return [
    {
      code: `runtime.${runtimeProfile}.unsupported`,
      severity: "error",
      message:
        compatibility.reason ||
        `Plugin ${manifest.id} is blocked in ${runtimeProfile} runtime${fallbackNote}.`,
      hint: compatibility.entrypoint
        ? `Declared ${runtimeProfile} entrypoint: ${compatibility.entrypoint}`
        : undefined,
      reason: compatibility.reason,
      recovery: compatibility.recovery,
    },
  ]
}
