"use client"

/**
 * Offers to prepare a Python plugin's environment right after it was
 * installed, or after an enable failed because it was not ready (ENV01,
 * ADR-0258).
 *
 * Mounted at the app root next to the other plugin prompts: installs and
 * enables run from many pages. For each plugin queued by
 * `requestPythonPreparePrompt` it asks the Host for readiness first and only
 * asks the user when there is something to prepare (not prepared, stale, or
 * failed); a plugin that needs nothing, is already ready, or runs on the
 * user's own environment passes without a dialog. Preparing then runs in the
 * background with a toast, and its progress shows on the plugin's card and
 * detail page.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import {
  finishPythonPreparePrompt,
  subscribePythonPreparePrompts,
  type PythonPreparePromptState,
} from "@/lib/plugin/python/prepare-prompt-requests"
import { readinessCanPrepare, type PythonInstaller } from "@/lib/plugin/python/readiness"
import { usePluginStore } from "@/stores/plugin-runtime"

import { PythonPrepareDialog } from "./python-prepare-dialog"

const EMPTY: PythonPreparePromptState = { current: null, queue: [] }
/** How long to wait for an installed plugin's row to reach the store. */
export const PYTHON_PREPARE_PROMPT_ROW_WAIT_MS = 10_000

interface Question {
  pluginId: string
  dependencies: readonly string[]
  installer: PythonInstaller
}

type PythonManifestFields = { type?: string; pythonDependencies?: string[] } | undefined

function pythonFields(pluginId: string): PythonManifestFields {
  return usePluginStore.getState().plugins[pluginId]?.manifest as PythonManifestFields
}

/**
 * The plugin's manifest once the store has it. Installers write the row and
 * then rescan, so a prompt can arrive a moment before the row does.
 */
function waitForManifest(pluginId: string, signal: AbortSignal): Promise<PythonManifestFields> {
  const present = pythonFields(pluginId)
  if (present) return Promise.resolve(present)
  return new Promise((resolve) => {
    const finish = (manifest: PythonManifestFields) => {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener("abort", onAbort)
      resolve(manifest)
    }
    const onAbort = () => finish(undefined)
    const timer = setTimeout(() => finish(undefined), PYTHON_PREPARE_PROMPT_ROW_WAIT_MS)
    const unsubscribe = usePluginStore.subscribe(() => {
      const manifest = pythonFields(pluginId)
      if (manifest) finish(manifest)
    })
    signal.addEventListener("abort", onAbort)
  })
}

export function PythonPreparePromptHost() {
  const t = useTranslations("plugins.pythonEnvironment")
  const [prompts, setPrompts] = useState<PythonPreparePromptState>(EMPTY)
  const [question, setQuestion] = useState<Question | null>(null)
  useEffect(() => subscribePythonPreparePrompts(setPrompts), [])
  const pluginId = prompts.current
  const asking = question !== null && question.pluginId === pluginId ? question : null
  const name = usePluginDisplayName(asking?.pluginId ?? null)

  useEffect(() => {
    if (!pluginId) return
    const controller = new AbortController()
    void (async () => {
      const manifest = await waitForManifest(pluginId, controller.signal)
      if (controller.signal.aborted) return
      const dependencies = manifest?.pythonDependencies ?? []
      const python = manifest?.type === "python" || manifest?.type === "hybrid"
      if (!python || dependencies.length === 0) {
        finishPythonPreparePrompt(pluginId)
        return
      }
      let report = null
      try {
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        report = await getPluginManager().getPythonReadiness(pluginId)
      } catch (error) {
        console.warn(`[plugin:${pluginId}] Python readiness unavailable`, error)
      }
      if (controller.signal.aborted) return
      if (!report || !readinessCanPrepare(report.readiness) || !("installer" in report.readiness)) {
        finishPythonPreparePrompt(pluginId)
        return
      }
      setQuestion({ pluginId, dependencies, installer: report.readiness.installer })
    })()
    return () => controller.abort()
  }, [pluginId])

  const later = () => {
    if (!asking) return
    setQuestion(null)
    finishPythonPreparePrompt(asking.pluginId)
  }

  const prepare = () => {
    if (!asking) return
    const { pluginId: id, dependencies } = asking
    const pluginName = name
    setQuestion(null)
    finishPythonPreparePrompt(id)
    const toastId = toast.loading(t("toast.preparing", { name: pluginName }))
    void (async () => {
      try {
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        await getPluginManager().installPythonDeps(id, [...dependencies])
        toast.success(t("toast.ready", { name: pluginName }), { id: toastId })
      } catch (error) {
        toast.error(t("toast.failed", { name: pluginName }), {
          id: toastId,
          description: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }

  return (
    <PythonPrepareDialog
      open={asking !== null}
      pluginName={name}
      dependencies={asking?.dependencies ?? []}
      installer={asking?.installer ?? null}
      onConfirm={prepare}
      onLater={later}
    />
  )
}
