"use client"

/**
 * Offers to prepare a Python plugin's environment right after it was
 * installed, or after an enable failed because it was not ready (ENV01,
 * ADR-0258).
 *
 * Mounted at the app root next to the other plugin prompts: installs and
 * enables run from many pages. For each plugin queued by
 * `requestPythonPreparePrompt` it asks the Host for readiness first and only
 * asks the user when there is something to prepare (not prepared, needs uv,
 * stale, or failed); a plugin that needs nothing, is already ready, or runs
 * on the user's own environment passes without a dialog. The Host decides
 * whether there is anything to prepare: a plugin locked with `uv.lock`
 * (ENV02) may declare no `pythonDependencies` at all. Preparing then runs in the
 * background with a toast, and its progress shows on the plugin's card and
 * detail page. A plugin whose start was refused for want of this environment
 * is started again by the manager, and the toast says so.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import { usePythonReadinessText } from "@/hooks/plugins/use-python-readiness-text"
import {
  finishPythonPreparePrompt,
  subscribePythonPreparePrompts,
  type PythonPreparePromptState,
} from "@/lib/plugin/python/prepare-prompt-requests"
import {
  readinessCanPrepare,
  readinessNeedsUv,
  type PythonInstaller,
  type PythonLockSummary,
} from "@/lib/plugin/python/readiness"
import { usePluginStore } from "@/stores/plugin-runtime"
import { usePythonReadinessStore } from "@/stores/plugin-runtime/python-readiness-store"

import { PythonPrepareDialog } from "./python-prepare-dialog"

const EMPTY: PythonPreparePromptState = { current: null, queue: [] }
/** How long to wait for an installed plugin's row to reach the store. */
export const PYTHON_PREPARE_PROMPT_ROW_WAIT_MS = 10_000

interface Question {
  pluginId: string
  /** The manifest's requirements, which the Host ignores for a locked plugin. */
  dependencies: readonly string[]
  /** What preparing installs: the lock's pins, or the requirements. */
  packages: readonly string[]
  installer: PythonInstaller
  lock: PythonLockSummary | null
  needsUv: boolean
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
  const describeReadiness = usePythonReadinessText()
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
      if (!python) {
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
      setQuestion({
        pluginId,
        dependencies,
        packages: report.lock ? report.lock.packages : dependencies,
        installer: report.readiness.installer,
        lock: report.lock,
        needsUv: readinessNeedsUv(report.readiness),
      })
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
    const { pluginId: id, dependencies, needsUv } = asking
    const pluginName = name
    setQuestion(null)
    finishPythonPreparePrompt(id)
    const toastId = toast.loading(t("toast.preparing", { name: pluginName }))
    void (async () => {
      try {
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        await getPluginManager().installPythonDeps(id, [...dependencies], { installUv: needsUv })
        // A plugin whose start this preparation unblocked was started again.
        const result = usePythonReadinessStore.getState().lastPreparationByPluginId[id]
        const resumed = result?.status === "succeeded" && result.resumed
        toast.success(t(resumed ? "toast.resumed" : "toast.ready", { name: pluginName }), {
          id: toastId,
        })
      } catch (error) {
        // A cause the Host named reads better than the installer's text.
        const after = usePythonReadinessStore.getState().byPluginId[id]?.readiness
        const description =
          after?.state === "failed" && after.cause
            ? describeReadiness(after)
            : error instanceof Error
              ? error.message
              : String(error)
        toast.error(t("toast.failed", { name: pluginName }), { id: toastId, description })
      }
    })()
  }

  return (
    <PythonPrepareDialog
      open={asking !== null}
      pluginName={name}
      dependencies={asking?.packages ?? []}
      installer={asking?.installer ?? null}
      lock={asking?.lock ?? null}
      needsUv={asking?.needsUv ?? false}
      onConfirm={prepare}
      onLater={later}
    />
  )
}
