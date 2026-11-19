"use client"

/**
 * One Python plugin's environment (ENV01, ADR-0258): the Host's readiness,
 * how the last preparation ended, the progress of a running one, and the
 * actions that refresh and prepare it.
 *
 * The plugin card, the status badge, the detail page and the prepare prompt
 * all read it, and the state lives in `usePythonReadinessStore`, so a
 * preparation started in one place shows everywhere.
 *
 * `prepare` downloads and installs packages: it runs only after the user
 * agreed in `PythonPrepareDialog`. `requestPrepare` is how everything else
 * asks for that consent. A plugin locked with `uv.lock` (ENV02) installs what
 * its lock pins, and when the Host reported `needs-uv` the same consent
 * covers installing uv first.
 *
 * The plugin manager is imported lazily, as the rest of the plugin UI does:
 * cards render on first paint and must not pull the manager into it.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"

import { getPythonLogs, subscribePythonLogs } from "@/lib/plugin/python/log-buffer"
import { requestPythonPreparePrompt } from "@/lib/plugin/python/prepare-prompt-requests"
import {
  readinessCanPrepare,
  readinessNeedsUv,
  summarizeReadiness,
  type PythonEnvironmentSummary,
  type PythonLockSummary,
  type PythonReadiness,
  type PythonReadinessReport,
} from "@/lib/plugin/python/readiness"
import {
  usePythonReadinessStore,
  type PythonPreparationResult,
} from "@/stores/plugin-runtime/python-readiness-store"

const NO_DEPENDENCIES: readonly string[] = []
const NO_LOGS: readonly never[] = []

/** The manifest fields readiness depends on. */
export interface PythonEnvironmentManifest {
  type?: string
  pythonDependencies?: readonly string[]
}

export interface PythonEnvironment {
  /** A python or hybrid plugin: it has an environment at all. */
  applies: boolean
  /** The requirements the plugin declares. */
  dependencies: readonly string[]
  /** Its `uv.lock`, when the Host reported it locked (ENV02). */
  lock: PythonLockSummary | null
  /** What preparing installs: the lock's pins, or the declared requirements. */
  packages: readonly string[]
  /** Preparing installs uv first: the plugin is locked and uv is missing. */
  needsUv: boolean
  /** The Host's last answer; `null` until it answered, or when it could not. */
  report: PythonReadinessReport | null
  readiness: PythonReadiness | null
  summary: PythonEnvironmentSummary | null
  /** Whether a preparation can start now (not prepared, needs uv, stale or failed). */
  canPrepare: boolean
  lastPreparation: PythonPreparationResult | null
  /** The latest line the running preparation printed. */
  progress: string | null
  refresh: () => Promise<void>
  /** Ask the user for consent to prepare, wherever they are. */
  requestPrepare: () => void
  /** Prepare now. Consent first: see `PythonPrepareDialog`. */
  prepare: () => Promise<PythonPreparationResult>
}

/** The newest `progress` line a dependency install streamed for `pluginId`. */
function latestInstallProgress(
  logs: readonly { kind: string; generation?: string; data: unknown }[]
) {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const entry = logs[index]
    if (entry?.kind !== "progress" || entry.generation !== "installation") continue
    const message = (entry.data as { message?: unknown } | null)?.message
    if (typeof message === "string" && message.trim()) return message.trim()
  }
  return null
}

export function usePythonEnvironment(
  pluginId: string | null,
  manifest: PythonEnvironmentManifest | undefined
): PythonEnvironment {
  const dependencies = manifest?.pythonDependencies ?? NO_DEPENDENCIES
  const applies = pluginId !== null && (manifest?.type === "python" || manifest?.type === "hybrid")
  const report = usePythonReadinessStore((state) =>
    pluginId ? (state.byPluginId[pluginId] ?? null) : null
  )
  const lastPreparation = usePythonReadinessStore((state) =>
    pluginId ? (state.lastPreparationByPluginId[pluginId] ?? null) : null
  )
  const readiness = applies ? (report?.readiness ?? null) : null
  const lock = applies ? (report?.lock ?? null) : null
  const needsUv = readinessNeedsUv(readiness)
  const preparing = readiness?.state === "preparing"

  const logs = useSyncExternalStore(
    subscribePythonLogs,
    () => (pluginId && preparing ? getPythonLogs(pluginId) : NO_LOGS),
    () => NO_LOGS
  )
  const progress = useMemo(
    () => (preparing ? latestInstallProgress(logs) : null),
    [logs, preparing]
  )

  const refresh = useCallback(async () => {
    if (!applies || !pluginId) return
    try {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().getPythonReadiness(pluginId)
    } catch (error) {
      // No manager (web profile, tests) or no Host: the views show nothing
      // rather than a state nobody computed.
      console.warn(`[plugin:${pluginId}] Python readiness unavailable`, error)
    }
  }, [applies, pluginId])

  // Ask once per plugin and declared requirements: an update that changes
  // them makes the last answer about another package.
  const dependencyKey = dependencies.join("\n")
  const askedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!applies || !pluginId) return
    const key = `${pluginId}\n${dependencyKey}`
    if (askedFor.current === key) return
    askedFor.current = key
    void refresh()
  }, [applies, pluginId, dependencyKey, refresh])

  const requestPrepare = useCallback(() => {
    if (pluginId) requestPythonPreparePrompt(pluginId)
  }, [pluginId])

  const prepare = useCallback(async (): Promise<PythonPreparationResult> => {
    if (!applies || !pluginId) {
      return { status: "failed", message: "not a Python plugin" }
    }
    try {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      const outcome = await getPluginManager().installPythonDeps(pluginId, [...dependencies], {
        installUv: needsUv,
      })
      // The manager records whether it also restarted the plugin.
      const recorded = usePythonReadinessStore.getState().lastPreparationByPluginId[pluginId]
      return recorded?.status === "succeeded"
        ? recorded
        : { status: "succeeded", outcome: outcome ?? null, resumed: false }
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) }
    }
  }, [applies, pluginId, dependencies, needsUv])

  return {
    applies,
    dependencies,
    lock,
    packages: lock ? lock.packages : dependencies,
    needsUv,
    report: applies ? report : null,
    readiness,
    summary: readiness ? summarizeReadiness(readiness) : null,
    canPrepare: readiness !== null && readinessCanPrepare(readiness),
    lastPreparation: applies ? lastPreparation : null,
    progress,
    refresh,
    requestPrepare,
    prepare,
  }
}
