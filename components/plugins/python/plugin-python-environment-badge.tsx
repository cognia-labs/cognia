"use client"

/**
 * The state of a Python plugin's environment on its card, Library row and
 * detail header (ENV01, ADR-0258 §2): runnable, dependencies not ready (with
 * the action that prepares them), or installed, when the user runs it on an
 * environment the Host does not manage.
 *
 * Renders nothing for plugins without a Python side, and nothing until the
 * Host answered: a state nobody computed is not shown. The tooltip says why,
 * from the same Host answer.
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckCircle2Icon, LoaderCircleIcon, PackageIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  usePythonEnvironment,
  type PythonEnvironmentManifest,
} from "@/hooks/plugins/use-python-environment"
import { usePythonReadinessText } from "@/hooks/plugins/use-python-readiness-text"
import { cn } from "@/lib/utils"

export interface PluginPythonEnvironmentBadgeProps {
  plugin: { id: string; manifest: unknown }
  className?: string
}

export function PluginPythonEnvironmentBadge({
  plugin,
  className,
}: PluginPythonEnvironmentBadgeProps) {
  // Most rows are not Python plugins: they render nothing and subscribe to
  // nothing.
  const manifest = plugin.manifest as PythonEnvironmentManifest | undefined
  if (manifest?.type !== "python" && manifest?.type !== "hybrid") return null
  return <PythonEnvironmentBadge pluginId={plugin.id} manifest={manifest} className={className} />
}

function PythonEnvironmentBadge({
  pluginId,
  manifest,
  className,
}: {
  pluginId: string
  manifest: PythonEnvironmentManifest
  className?: string
}) {
  const t = useTranslations("plugins.pythonEnvironment")
  const environment = usePythonEnvironment(pluginId, manifest)
  const describe = usePythonReadinessText()
  const { readiness, summary } = environment
  if (!environment.applies || !readiness || !summary) return null
  const detail = describe(readiness)
  const preparing = readiness.state === "preparing"

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1", className)}
      data-testid={`plugin-python-environment-${pluginId}`}
      data-python-environment={summary}
    >
      {summary === "runnable" && (
        <Badge variant="secondary" className="gap-1 text-xs" title={detail}>
          <CheckCircle2Icon className="size-3 shrink-0" />
          {t("badge.runnable")}
        </Badge>
      )}
      {summary === "installed" && (
        <Badge variant="outline" className="gap-1 text-xs" title={detail}>
          <PackageIcon className="size-3 shrink-0" />
          {t("badge.installed")}
        </Badge>
      )}
      {summary === "not-ready" && (
        <>
          <Badge
            variant="outline"
            className="gap-1 border-amber-500/40 text-xs text-amber-700 dark:text-amber-300"
            title={preparing && environment.progress ? environment.progress : detail}
          >
            {preparing ? (
              <LoaderCircleIcon className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
            ) : (
              <AlertTriangleIcon className="size-3 shrink-0" />
            )}
            {preparing ? t("badge.preparing") : t("badge.notReady")}
          </Badge>
          {environment.canPrepare && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs pointer-coarse:h-10"
              onClick={environment.requestPrepare}
            >
              {t("prepare")}
            </Button>
          )}
        </>
      )}
    </div>
  )
}
