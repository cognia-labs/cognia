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
import type { PythonInstaller } from "@/lib/plugin/python/readiness"

export interface PythonPrepareDialogProps {
  open: boolean
  pluginName: string
  dependencies: readonly string[]
  /** The installer the Host reported; `null` when it has not answered. */
  installer: PythonInstaller | null
  onConfirm: () => void
  /** Closed without preparing. */
  onLater: () => void
}

export function PythonPrepareDialog({
  open,
  pluginName,
  dependencies,
  installer,
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
            {t("body", {
              name: pluginName,
              count: dependencies.length,
              installer: installer ?? "unknown",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-sm">
          <p className="text-xs font-medium text-muted-foreground">{t("packages")}</p>
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
          <p className="text-xs text-muted-foreground">{t("impact")}</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("later")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              confirmed.current = true
              onConfirm()
            }}
          >
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
