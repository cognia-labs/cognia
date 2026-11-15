import type { PluginManifestDexieBlock } from "@/types/plugin"
import { listBuiltinPrebootManifests } from "@/lib/plugin/core/builtin-preboot-manifests"

/**
 * Every bundled plugin that declares `dexie.tables`.
 *
 * Derived from the generated pre-boot snapshot rather than a hand-kept list of
 * `plugins/<id>/plugin.json` imports: database boot runs before the plugin
 * manager, and the snapshot is the one place the host reads built-in manifest
 * data without depending on plugin source. Imports no plugin code.
 */
export function getBuiltinPluginDexieManifests(): Map<string, PluginManifestDexieBlock> {
  const manifests = new Map<string, PluginManifestDexieBlock>()
  for (const [id, manifest] of listBuiltinPrebootManifests()) {
    if (!manifest.dexie?.tables?.length) continue
    manifests.set(id, manifest.dexie)
  }
  return manifests
}
