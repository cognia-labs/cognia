/**
 * Give each load of an ESM / TypeScript plugin a fresh module graph.
 *
 * Node caches ES modules by URL for the life of the process, so the importer
 * stamps the entry URL with a per-load generation. That alone re-ran only the
 * entry: every module it imported resolved to its old URL and came from cache.
 * After an update replaced the plugin's files, a re-enable ran the new entry
 * against the old versions of its own modules.
 *
 * This resolve hook copies the entry's stamp onto every module the plugin
 * imports from inside its own folder. Anything outside that folder, and
 * anything under a `node_modules` inside it, keeps its cached instance: the
 * SDK and React resolve through a workspace symlink to their real path, and a
 * second instance of either breaks the host's singletons.
 *
 * Dependency-free on purpose: a test loads this file in a real `node` process,
 * where the ESM loader it hooks actually runs.
 */
import { existsSync, realpathSync } from "node:fs"
import { registerHooks, type RegisterHooksOptions } from "node:module"
import { dirname, join, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const GENERATION_PARAM = "cognia-plugin-gen"
const ROOT_PARAM = "cognia-plugin-root"

/** The nearest folder above `entryPath` holding a `plugin.json`, else its own folder. */
export function findPluginRoot(entryPath: string): string {
  let dir = dirname(entryPath)
  for (;;) {
    if (existsSync(join(dir, "plugin.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return dirname(entryPath)
    dir = parent
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The URL to import a plugin entry by for load number `generation`.
 *
 * The root is stored as its real path because Node resolves every module to
 * its real path; comparing against a symlinked root (macOS `/var` vs
 * `/private/var`) would leave every child unstamped.
 */
export function pluginEntryUrl(entryPath: string, generation: number): string {
  const url = pathToFileURL(entryPath)
  url.searchParams.set(GENERATION_PARAM, String(generation))
  url.searchParams.set(ROOT_PARAM, realpathOr(findPluginRoot(entryPath)))
  return url.href
}

/** `resolvedUrl` with the importing module's stamp, when it belongs to the same plugin. */
export function stampResolvedUrl(resolvedUrl: string, parentUrl: string | undefined): string {
  if (!parentUrl?.startsWith("file:") || !resolvedUrl.startsWith("file:")) return resolvedUrl
  const parent = new URL(parentUrl)
  const generation = parent.searchParams.get(GENERATION_PARAM)
  const root = parent.searchParams.get(ROOT_PARAM)
  if (!generation || !root) return resolvedUrl
  const resolved = new URL(resolvedUrl)
  const path = fileURLToPath(resolved)
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (!path.startsWith(rootPrefix)) return resolvedUrl
  if (path.slice(rootPrefix.length).split(sep).includes("node_modules")) return resolvedUrl
  resolved.searchParams.set(GENERATION_PARAM, generation)
  resolved.searchParams.set(ROOT_PARAM, root)
  return resolved.href
}

let installed = false

/** Register the resolve hook once per process. */
export function installPluginReloadHook(
  register: (options: RegisterHooksOptions) => unknown = registerHooks
): void {
  if (installed) return
  register({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context)
      const url = stampResolvedUrl(result.url, context.parentURL)
      return url === result.url ? result : { ...result, url }
    },
  })
  installed = true
}
