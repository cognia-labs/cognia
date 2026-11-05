/**
 * Installed frontend plugins use the same CJS bundle contract and host-shared
 * modules as the desktop loader. Read and evaluate each load so replaced bytes
 * are never hidden by Node's CommonJS cache. Native ESM / TypeScript imports
 * remain available for the source-development path; each of their loads gets a
 * fresh module graph from `esm-reload-hook`.
 */
import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { evaluatePluginBundle } from "@/lib/plugin/core/evaluate-plugin-bundle"
import { primeSharedModulesFor } from "@/lib/plugin/core/shared-modules"
import { installPluginReloadHook, pluginEntryUrl } from "./esm-reload-hook"

export type NodeFrontendImporter = (
  absPath: string,
  pluginId: string
) => Promise<Record<string, unknown>>

type DynamicImport = (spec: string) => Promise<Record<string, unknown>>

export function makeNodeFrontendImporter(dynamicImport?: DynamicImport): NodeFrontendImporter {
  const generation = new Map<string, number>()
  return async (absPath: string, pluginId: string) => {
    if (!dynamicImport && ![".mjs", ".mts", ".ts", ".tsx"].includes(extname(absPath))) {
      const code = await readFile(absPath, "utf8")
      await primeSharedModulesFor(code)
      return evaluatePluginBundle(code, absPath)
    }
    const gen = (generation.get(pluginId) ?? 0) + 1
    generation.set(pluginId, gen)
    const url = pluginEntryUrl(absPath, gen)
    if (dynamicImport) return dynamicImport(url)
    installPluginReloadHook()
    return import(url)
  }
}
