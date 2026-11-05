/**
 * Where each "Load unpacked" plugin was loaded from.
 *
 * The native installer copies the picked directory into the plugin runtime
 * root and keeps no note of the original, and the install origin records only
 * `{ kind: "local", via: "directory" }`. So the DevTools file watcher could
 * watch nothing but the installed copy, and an author editing their own folder
 * saw no reload at all. This registry keeps the folder, per plugin, so the
 * watcher can watch it and reinstall from it before each reload.
 *
 * A record is trusted only while the plugin's install origin is still a local
 * directory: reinstalling the same id from GitHub or a cogpack replaces the
 * origin row, and a stale folder must not overwrite that install.
 *
 * A watcher-driven reinstall skips the pre-install chain, so it refuses any
 * change the chain would have asked about: a different plugin id, or a
 * different permission surface. Those need "Load unpacked" again.
 */

import { loggers } from "@cognia/logging"
import type { PluginManifest } from "@/types/plugin"
import type { PluginInstallOriginRecord } from "@/types/plugin/plugin-cogset"
import type { LocalPluginInspection } from "./convert-local-source"
import type {
  InstallFromDirectoryOptions,
  InstallFromDirectoryReceipt,
} from "./install-from-directory"

export const UNPACKED_SOURCES_STORAGE_KEY = "cognia:plugin-unpacked-sources:v1"

export interface UnpackedSourceRecord {
  pluginId: string
  sourceDir: string
  recordedAt: number
}

export interface UnpackedSourceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): UnpackedSourceStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage
}

function isRecord(value: unknown): value is UnpackedSourceRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<UnpackedSourceRecord>
  return (
    typeof record.pluginId === "string" &&
    typeof record.sourceDir === "string" &&
    record.sourceDir.length > 0 &&
    typeof record.recordedAt === "number"
  )
}

export function readUnpackedSources(
  storage: UnpackedSourceStorage | null = defaultStorage()
): Record<string, UnpackedSourceRecord> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(UNPACKED_SOURCES_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return {}
    const records: Record<string, UnpackedSourceRecord> = {}
    for (const [pluginId, value] of Object.entries(parsed)) {
      if (isRecord(value) && value.pluginId === pluginId) records[pluginId] = value
    }
    return records
  } catch (error) {
    loggers.plugin.warn("[unpacked-sources] failed to read the registry", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}

function writeUnpackedSources(
  records: Record<string, UnpackedSourceRecord>,
  storage: UnpackedSourceStorage | null
): void {
  if (!storage) return
  try {
    storage.setItem(UNPACKED_SOURCES_STORAGE_KEY, JSON.stringify(records))
  } catch (error) {
    loggers.plugin.warn("[unpacked-sources] failed to write the registry", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function recordUnpackedSource(
  pluginId: string,
  sourceDir: string,
  deps: { storage?: UnpackedSourceStorage | null; now?: () => number } = {}
): void {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage
  const records = readUnpackedSources(storage)
  records[pluginId] = { pluginId, sourceDir, recordedAt: (deps.now ?? Date.now)() }
  writeUnpackedSources(records, storage)
}

export function forgetUnpackedSource(
  pluginId: string,
  storage: UnpackedSourceStorage | null = defaultStorage()
): void {
  const records = readUnpackedSources(storage)
  if (!(pluginId in records)) return
  delete records[pluginId]
  writeUnpackedSources(records, storage)
}

/** Whether an origin row still says the plugin was installed from a folder. */
function isDirectoryOrigin(record: PluginInstallOriginRecord | undefined): boolean {
  return record?.origin.kind === "local" && record.origin.via === "directory"
}

/**
 * The unpacked folders the watcher may use for `pluginIds`: recorded, and the
 * plugin's install origin is still a local directory.
 */
export async function listWatchableUnpackedSources(
  pluginIds: readonly string[],
  deps: {
    storage?: UnpackedSourceStorage | null
    getOrigin?: (pluginId: string) => Promise<PluginInstallOriginRecord | undefined>
  } = {}
): Promise<Array<{ pluginId: string; sourceDir: string }>> {
  const records = readUnpackedSources(deps.storage === undefined ? defaultStorage() : deps.storage)
  const getOrigin =
    deps.getOrigin ??
    (async (pluginId: string) => {
      const { getInstallOrigin } = await import("@/lib/db/plugin-install-origins")
      return getInstallOrigin(pluginId)
    })
  const watchable: Array<{ pluginId: string; sourceDir: string }> = []
  for (const pluginId of pluginIds) {
    const record = records[pluginId]
    if (!record) continue
    try {
      if (isDirectoryOrigin(await getOrigin(pluginId))) {
        watchable.push({ pluginId, sourceDir: record.sourceDir })
      }
    } catch (error) {
      // Unknown origin: watching the folder could overwrite another install.
      loggers.plugin.warn(`[unpacked-sources] could not read the origin of ${pluginId}`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return watchable
}

/** The parts of a manifest the pre-install chain asks the user about. */
function reviewedSurface(
  manifest: Pick<PluginManifest, "permissions" | "optionalPermissions" | "networkAccess">
): string {
  const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort()
  return JSON.stringify({
    permissions: sorted(manifest.permissions),
    optionalPermissions: sorted(manifest.optionalPermissions),
    networkAccess: manifest.networkAccess ?? null,
  })
}

export interface ResyncUnpackedSourceDeps {
  inspect: (sourceDir: string) => Promise<LocalPluginInspection>
  install: (
    sourceDir: string,
    options: InstallFromDirectoryOptions
  ) => Promise<InstallFromDirectoryReceipt>
}

function defaultResyncDeps(): ResyncUnpackedSourceDeps {
  return {
    inspect: async (sourceDir) => {
      const { inspectLocalPluginSource } = await import("./convert-local-source")
      return inspectLocalPluginSource(sourceDir)
    },
    install: async (sourceDir, options) => {
      const { installPluginFromDirectory } = await import("./install-from-directory")
      return installPluginFromDirectory(sourceDir, options)
    },
  }
}

/**
 * Reinstall `pluginId` from its unpacked folder, ahead of a watcher reload.
 *
 * Re-reads the whole folder, so a converted bundle (Claude Code, Codex, ...)
 * gets a fresh overlay, and throws instead of installing when the folder now
 * describes a different plugin or a different permission surface than the one
 * the user approved.
 */
export async function resyncUnpackedSource(
  pluginId: string,
  sourceDir: string,
  installed: Pick<PluginManifest, "permissions" | "optionalPermissions" | "networkAccess">,
  deps: ResyncUnpackedSourceDeps = defaultResyncDeps()
): Promise<void> {
  const inspection = await deps.inspect(sourceDir)
  const manifest = inspection.manifest
  if (!inspection.convertible || !manifest) {
    throw new Error(`${sourceDir} can no longer be installed as a Cognia plugin`)
  }
  if (manifest.id !== pluginId) {
    throw new Error(
      `${sourceDir} now declares plugin ${manifest.id}, not ${pluginId}; use Load unpacked to install it`
    )
  }
  if (reviewedSurface(manifest) !== reviewedSurface(installed)) {
    throw new Error(
      `${pluginId} changed its permissions or network access; use Load unpacked to review them`
    )
  }
  await deps.install(sourceDir, {
    pluginName: manifest.name ?? pluginId,
    version: manifest.version,
    ...(inspection.native ? {} : { generatedFiles: inspection.generatedFiles }),
  })
}
