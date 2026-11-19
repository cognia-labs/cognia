/**
 * Android ML Kit Text Recognition OCR provider.
 *
 * Delegates to `@pantrist/capacitor-plugin-ml-kit-text-recognition` (v8):
 * the plugin exports `CapacitorPluginMlKitTextRecognition` with a single method
 * `detectText({ base64Image, rotation? })` returning `{ text, blocks }`
 * where each block carries `text`, a `boundingBox` (left/top/right/bottom)
 * and a `recognizedLanguage`. This binding uses the Latin recognizer and
 * takes no language or script parameters. Only available in the Capacitor
 * mobile shell, and only when the native plugin is bundled into the
 * mobile app.
 */

import { makeDefaultLoader, withPlugin } from "@/lib/capacitor/_shared"
import { OcrError } from "@/lib/ocr/errors"
import { bytesToBase64, normalizeImage } from "@/lib/utils/image-bytes"
import {
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "@/types/ocr"

/** npm package that ships the Capacitor ML Kit text-recognition plugin. */
export const MLKIT_PLUGIN_PACKAGE = "@pantrist/capacitor-plugin-ml-kit-text-recognition"
const NATIVE_PLUGIN_NAME = "CapacitorPluginMlKitTextRecognition"

/** Block shape returned by the upstream plugin (`Block extends TextBase`). */
export interface MlKitTextBlock {
  text: string
  boundingBox?: { left: number; top: number; right: number; bottom: number } | null
  recognizedLanguage?: string
}

/**
 * Upstream plugin surface — mirrors `TextRecognitionPlugin` from
 * `@pantrist/capacitor-plugin-ml-kit-text-recognition/src/definitions.ts`.
 */
export interface MlKitTextRecognitionPluginShape {
  detectText(options: { base64Image: string; rotation?: number }): Promise<{
    text: string
    blocks?: MlKitTextBlock[]
  }>
}

export interface MlkitAndroidConfig {
  pluginLoader?: () => Promise<MlKitTextRecognitionPluginShape>
}

let pluginLoader: (() => Promise<MlKitTextRecognitionPluginShape>) | null = null

export function __setMlkitAndroidPluginLoader(
  impl: (() => Promise<MlKitTextRecognitionPluginShape>) | null
): void {
  pluginLoader = impl
}

/** Use the same native bridge registry as the other Capacitor adapters. */
export const loadMlKitTextRecognitionPlugin = makeDefaultLoader<MlKitTextRecognitionPluginShape>(
  MLKIT_PLUGIN_PACKAGE,
  NATIVE_PLUGIN_NAME
)

export function hasNativeTextRecognition(): boolean {
  const cap = (
    globalThis as typeof globalThis & {
      Capacitor?: {
        Plugins?: Record<string, MlKitTextRecognitionPluginShape>
        PluginHeaders?: Array<{ name: string; methods?: Array<{ name: string }> }>
      }
    }
  ).Capacitor
  return (
    typeof cap?.Plugins?.[NATIVE_PLUGIN_NAME]?.detectText === "function" ||
    (cap?.PluginHeaders?.some(
      (header) =>
        header.name === NATIVE_PLUGIN_NAME &&
        header.methods?.some((method) => method.name === "detectText")
    ) ??
      false)
  )
}

/** Map the plugin's left/top/right/bottom box to the x/y/width/height bbox. */
export function mapMlKitBlock(block: MlKitTextBlock): OcrBlock {
  const box = block.boundingBox
  return {
    text: block.text,
    bbox: box
      ? {
          x: box.left,
          y: Math.min(box.top, box.bottom),
          width: box.right - box.left,
          height: Math.abs(box.bottom - box.top),
        }
      : undefined,
    kind: "paragraph",
  }
}

export function buildMlkitAndroidProvider(): OcrProvider {
  return {
    id: "mlkit-android",
    label: "ML Kit Text Recognition (Android)",
    category: "local",
    shells: { browser: false, tauri: false, capacitor: true },
    credentialKeys: [],
    async extract(input, ctx) {
      return mlkitAndroidExtract(input, ctx)
    },
  }
}

export async function mlkitAndroidExtract(
  input: OcrInput,
  ctx: OcrProviderContext
): Promise<OcrResult> {
  if (ctx.platform !== "mobile") {
    throw new OcrError(
      "unsupported_shell",
      "mlkit-android",
      "ML Kit Text Recognition is only available in the Capacitor mobile shell."
    )
  }
  const config = (ctx.config ?? {}) as MlkitAndroidConfig
  const loader = config.pluginLoader ?? pluginLoader ?? loadMlKitTextRecognitionPlugin
  const normalized = await normalizeImage(input.source)
  const start = Date.now()
  const outcome = await withPlugin(loader, async (plugin) =>
    plugin.detectText({ base64Image: bytesToBase64(normalized.bytes) })
  )
  if ("kind" in outcome) {
    if (outcome.kind === "unsupported") {
      throw new OcrError(
        "unsupported_shell",
        "mlkit-android",
        `ML Kit Text Recognition requires the ${MLKIT_PLUGIN_PACKAGE} Capacitor plugin, which is not included in this build.`
      )
    }
    throw new OcrError("provider_failed", "mlkit-android", outcome.message)
  }
  const blocks: OcrBlock[] = (outcome.blocks ?? []).map(mapMlKitBlock)
  return {
    providerId: "mlkit-android",
    pages: [
      {
        pageNumber: 1,
        markdown: outcome.text,
        text: outcome.text,
        blocks,
      },
    ],
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

export const mlkitAndroidProvider = buildMlkitAndroidProvider()
