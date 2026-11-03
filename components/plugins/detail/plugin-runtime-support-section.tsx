"use client"

import { useTranslations } from "next-intl"
import type { PluginManifest } from "@/types/plugin"
import { collectPluginRuntimeProfileDiagnostics } from "@/lib/plugin/core/runtime-compatibility"
import { resolveAuthMethodSupport } from "@/lib/external-services/runtime-support"
import { useExternalServiceRuntimeProfile } from "@/hooks/plugins/use-external-service-runtime-profile"
import { RuntimeSupportNotice } from "../auth/runtime-support-notice"

/** Keep the complete method list available without expanding the fixed header. */
export function PluginRuntimeSupportSection({ manifest }: { manifest: PluginManifest }) {
  const t = useTranslations("plugins.auth.runtimeSupport")
  const context = useExternalServiceRuntimeProfile()
  const profile = context.local
  const diagnostics = collectPluginRuntimeProfileDiagnostics(manifest, profile, context)
  if (!manifest.authProviders?.length) return null
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">{t("title", { profile })}</summary>
      <ul className="max-h-60 space-y-3 overflow-y-auto py-2">
        {manifest.authProviders.flatMap((provider) =>
          (provider.methods ?? ["oauth-pkce"]).map((method) => {
            const support = resolveAuthMethodSupport(method, context, provider)
            const diagnostic = diagnostics.find(
              (item) => item.code === `runtime.${profile}.auth.${provider.id}.${method}`
            )
            return (
              <li key={`${provider.id}:${method}`}>
                <p>
                  {provider.label} · {t(`methods.${method}`)} ·{" "}
                  {t(`availability.${support.availability}`)}
                </p>
                <RuntimeSupportNotice
                  support={{
                    ...support,
                    reason: (diagnostic?.reason as typeof support.reason) ?? support.reason,
                  }}
                />
              </li>
            )
          })
        )}
      </ul>
    </details>
  )
}
