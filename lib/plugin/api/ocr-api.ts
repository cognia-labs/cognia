/**
 * Plugin OCR Provider API.
 *
 * Lets a plugin contribute a custom `OcrProvider` to the shared OCR
 * registry (`@cognia/ocr/registry:registerOcrProvider`). Plugins call
 * `ctx.ocr.registerProvider(provider)` from `activate()`, or declare
 * `manifest.ocrProviders[]` and let `lib/plugin/bridge/ocr-providers-bridge.ts`
 * register on enable.
 *
 * The registration handle is auto-revoked when the plugin is disabled
 * (`clearOcrProvidersForPlugin(pluginId)`), so manual cleanup is
 * belt-and-braces.
 *
 * Provider ids are namespaced as `<pluginId>:<providerId>` to prevent
 * collisions with built-ins and across plugins. The registry's internal
 * duplicate check fires if the same plugin tries to register twice.
 *
 * Registration goes straight to the `@cognia/ocr` registry the OCR module
 * dispatches from, because it is synchronous and holds no host resource.
 * Extraction goes through the `ocr` port (ADR-0250 §14), which supplies the
 * person's settings, credentials, caches and metering.
 *
 * See ADR-0026 §2 §A.
 */

import { createPluginSystemLogger } from "../core/logger"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { registerOcrProvider, getSharedOcrRegistry } from "@cognia/ocr/registry"
import { OcrError } from "@cognia/ocr/errors"
import { loadPort } from "@/lib/modules/ports"
import type { OcrDepsOptions, OcrPort } from "@/types/modules/ports/ocr"
import type { OcrProvider } from "@/types/ocr"
import type { OcrInput, OcrResult } from "@/types/ocr"
import { ocrScreen } from "@/lib/automation/ocr-screen"
import { handleOcrSlashCommand, type SlashOcrResult } from "@/lib/slash-commands/actions/ocr"
import { detectPlatform } from "@/lib/platform/detect"
import type { PluginOcrAPI } from "@cognia/plugin-contract/lib/plugin/api/ocr-api"
export type { PluginOcrAPI } from "@cognia/plugin-contract/lib/plugin/api/ocr-api"

// Track which provider ids each plugin has registered so we can drop them
// all on plugin disable without leaning on the registry's plugin-aware
// helpers (which don't exist — the OCR registry predates plugin lifecycle).
const ownedByPlugin = new Map<string, Set<string>>()

interface PluginOcrRuntime {
  listAvailableProviders(): string[]
  extract(input: OcrInput): Promise<OcrResult>
  extractFile(path: string, options?: Omit<OcrInput, "source">): Promise<OcrResult>
  extractScreen(options?: { languages?: string[] }): Promise<OcrResult>
  runSlashCommand(argv: string): Promise<SlashOcrResult>
}

/**
 * The extraction half of this API reaches real host resources —
 * `extractFile` reads an arbitrary path through the Tauri filesystem plugin
 * and `extractScreen` captures the desktop — so it goes through
 * `createGuardedAPI`. The contract catalog declares the same permissions, but
 * its `ocr` namespace is `enforcement: "shadow"` (audit-only), so the guard is
 * what actually enforces them.
 *
 * `registerProvider` / `listRegistered` / `listAvailableProviders` / `isReady`
 * stay unguarded: they only read or mutate this plugin's own slice of the
 * provider registry and touch no user data.
 */
export function createOcrAPI(
  pluginId: string,
  runtime: PluginOcrRuntime = defaultOcrRuntime
): PluginOcrAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginOcrAPI = {
    registerProvider(provider) {
      const prefixed = `${pluginId}:${provider.id}`
      const owned = ownedByPlugin.get(pluginId) ?? new Set<string>()
      if (owned.has(prefixed)) {
        throw new Error(
          `[ocr-api] plugin ${pluginId} already registered an OCR provider with id "${provider.id}"`
        )
      }
      const wrapped: OcrProvider = { ...provider, id: prefixed }
      registerOcrProvider(wrapped)
      owned.add(prefixed)
      ownedByPlugin.set(pluginId, owned)
      logger.info(`[ocr] registered provider "${prefixed}"`)
      return {
        providerId: prefixed,
        unregister: () => {
          if (!owned.has(prefixed)) return
          // The registry has `unregister(id)` returning a boolean.
          getSharedOcrRegistry().unregister(prefixed)
          owned.delete(prefixed)
          if (owned.size === 0) ownedByPlugin.delete(pluginId)
          logger.info(`[ocr] unregistered provider "${prefixed}"`)
        },
      }
    },
    listRegistered() {
      return Array.from(ownedByPlugin.get(pluginId) ?? [])
    },
    listAvailableProviders: runtime.listAvailableProviders,
    isReady: () => runtime.listAvailableProviders().length > 0,
    extract: runtime.extract,
    extractFile: runtime.extractFile,
    extractScreen: runtime.extractScreen,
    runSlashCommand: runtime.runSlashCommand,
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      extract: ["media:image:read", "database:write"],
      extractFile: ["native:filesystem", "media:image:read", "database:write"],
      extractScreen: [
        "automation:screenshot",
        "native:screen",
        "media:image:read",
        "database:write",
      ],
      runSlashCommand: ["native:filesystem", "media:image:read", "database:write"],
    },
    {
      unguarded: ["registerProvider", "listRegistered", "listAvailableProviders", "isReady"],
    }
  )
}

/** The `ocr` port; a host without OCR fails with a typed error. */
async function ocrPort(): Promise<OcrPort> {
  const ocr = await loadPort("ocr")
  if (!ocr) throw new OcrError("unsupported_shell", "ocr", "OCR is not available on this host")
  return ocr
}

/** The port and its deps at the person's settings. */
async function hostOcr(
  options: Omit<OcrDepsOptions, "settings"> = {}
): Promise<{ ocr: OcrPort; deps: ReturnType<OcrPort["deps"]> }> {
  const ocr = await ocrPort()
  return { ocr, deps: ocr.deps({ ...options, settings: await ocr.loadSettings() }) }
}

async function resolveFilePath(path: string): Promise<{
  blob: Blob
  mimeType: string
  bytes: Uint8Array
}> {
  if (detectPlatform() !== "tauri") {
    throw new Error("file-path OCR requires the desktop app")
  }
  const { readFile } = await import("@tauri-apps/plugin-fs")
  const bytes = await readFile(path)
  const mimeType = mimeFromPath(path)
  return { blob: new Blob([bytes as BlobPart], { type: mimeType }), mimeType, bytes }
}

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  pdf: "application/pdf",
}

function mimeFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? ""
  return EXTENSION_MIME[extension] ?? "application/octet-stream"
}

const defaultOcrRuntime: PluginOcrRuntime = {
  listAvailableProviders: () =>
    getSharedOcrRegistry()
      .list()
      .map((provider) => provider.id),
  extract: async (input) => {
    const { ocr, deps } = await hostOcr()
    return ocr.extract(input, deps)
  },
  extractFile: async (path, options = {}) => {
    const { ocr, deps } = await hostOcr({ filePathResolver: resolveFilePath })
    return ocr.extract({ ...options, source: { kind: "file-path", path } }, deps)
  },
  extractScreen: (options) => ocrScreen(options),
  runSlashCommand: async (argv) => {
    const { ocr, deps } = await hostOcr({ filePathResolver: resolveFilePath })
    return handleOcrSlashCommand({ argv, deps, extract: ocr.extract })
  },
}

/**
 * Plugin-disable hook — drop every OCR provider the plugin owns. Called by
 * the plugin manager when disabling/unloading; safe to call multiple times.
 */
export function clearOcrProvidersForPlugin(pluginId: string): void {
  const owned = ownedByPlugin.get(pluginId)
  if (!owned) return
  for (const id of owned) {
    getSharedOcrRegistry().unregister(id)
  }
  ownedByPlugin.delete(pluginId)
}

/** Test-only. */
export function __resetOcrApiForTesting(): void {
  ownedByPlugin.clear()
}
