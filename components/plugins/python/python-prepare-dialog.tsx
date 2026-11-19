"use client"

/**
 * The consent to prepare a Python plugin's environment (ENV01, ADR-0258).
 *
 * Preparing downloads the plugin's packages and writes an environment on the
 * Host, so it is asked for on its own, never folded into install or enable.
 * The dialog names what will happen: the packages, the installer the Host
 * will use, and the network and disk it costs. Dismissing it is "later":
 * nothing is installed, and the plugin stays "dependencies not ready".
 *
 * A plugin locked with `uv.lock` (ENV02) lists what its lock pins and says
 * whether it installs offline from bundled wheels. When uv is missing
 * (`needs-uv`) the same consent covers installing uv first, and says so.
 *
 * Shared by the prompt after an install (`PythonPreparePromptHost`) and the
 * detail page's environment section, so both ask the same question.
 */

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { PackageIcon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { PythonInstaller, PythonLockSummary } from "@/lib/plugin/python/readiness"

export interface PythonPrepareDialogProps {
  open: boolean
  pluginName: string
  /** What preparing installs: the lock's pins, or the declared requirements. */
  dependencies: readonly string[]
  /** The installer the Host reported; `null` when it has not answered. */
  installer: PythonInstaller | null
  /** The plugin's `uv.lock`, when it is locked. */
  lock?: Pick<PythonLockSummary, "offline"> | null
  /** uv is missing and is installed first. */
  needsUv?: boolean
  onConfirm: () => void
  /** Closed without preparing. */
  onLater: () => void
}

export function PythonPrepareDialog({
  open,
  pluginName,
  dependencies,
  installer,
  lock = null,
  needsUv = false,
  onConfirm,
  onLater,
}: PythonPrepareDialogProps) {
  const t = useTranslations("plugins.pythonEnvironment.dialog")
  // The confirm button closes the dialog too; that close is not "later".
  const confirmed = useRef(false)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        if (confirmed.current) confirmed.current = false
        else onLater()
      }}
    >
      <AlertDialogContent data-testid="python-prepare-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
            {t("title", { name: pluginName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {lock
              ? t("bodyLocked", {
                  name: pluginName,
                  count: dependencies.length,
                  offline: String(lock.offline),
                })
              : t("body", {
                  name: pluginName,
                  count: dependencies.length,
                  installer: installer ?? "unknown",
                })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-sm">
          {needsUv && (
            <p className="text-xs" data-testid="python-prepare-needs-uv">
              {t("needsUv")}
            </p>
          )}
          <p className="text-xs font-medium text-muted-foreground">
            {lock ? t("packagesLocked") : t("packages")}
          </p>
          <ul
            className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs"
            data-testid="python-prepare-dependencies"
          >
            {dependencies.map((dependency) => (
              <li key={dependency} className="break-all">
                {dependency}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {lock?.offline ? t("impactOffline") : t("impact")}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("later")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              confirmed.current = true
              onConfirm()
            }}
          >
            {needsUv ? t("confirmWithUv") : t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
