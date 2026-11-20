import { getTwinSource } from "@/lib/db/twin-sources"
import { readTwinSourceOriginal } from "@/lib/db/twin-source-originals"
import { currentRouterFusionGateSettings } from "@/lib/router-fusion/gate/current-settings"
import { ledgerUtilityCalls } from "@/lib/router-fusion/gate/utility-ledger"
import { createAnthropicLlmClient } from "@/lib/twin/distill"
import { type JobWorkerConfig, type SourceLoader } from "@/lib/twin/job-worker"
import {
  buildTwinRuntimeAdapters,
  deriveTwinVectorStoreConfig,
} from "@/lib/twin/runtime/build-deps"
import type { TwinRuntimeSettings, TwinSource } from "@/types/twin"

/**
 * Load a source for ingest. A source with a kept original is parsed from the
 * file (its OCR fallback and page map need the bytes); one without — text
 * sources, and binary sources imported before originals were kept — from its
 * stored text. A kept original whose bytes are gone is read from the preview
 * text as Markdown, which is all that is left of it.
 */
export function buildSourceLoader(): SourceLoader {
  return async (source: TwinSource) => {
    const refreshed = await getTwinSource(source.id)
    if (!refreshed) throw new Error(`twin source ${source.id} disappeared mid-load`)
    const baseMetadata = refreshed.speakers?.length
      ? { baseMetadata: { speakers: refreshed.speakers } }
      : {}
    const original = await readTwinSourceOriginal(refreshed)
    if (original && refreshed.original) {
      return {
        id: refreshed.id,
        filename: refreshed.original.filename,
        format: refreshed.format,
        binary: new Uint8Array(await original.arrayBuffer()),
        mimeType: refreshed.original.mediaType,
        ...baseMetadata,
      }
    }
    return {
      id: refreshed.id,
      filename: refreshed.title,
      format: refreshed.original ? "markdown" : refreshed.format,
      text: refreshed.source,
      ...baseMetadata,
    }
  }
}

export function isTwinWorkerConfigComplete(settings: TwinRuntimeSettings): boolean {
  if (!settings.workerEnabled) return false
  if (!deriveTwinVectorStoreConfig(settings)) return false
  if (!settings.llm.apiKey) return false
  return true
}

export async function buildTwinWorkerConfig(
  settings: TwinRuntimeSettings
): Promise<JobWorkerConfig | null> {
  if (!settings.workerEnabled || !settings.llm.apiKey) return null
  const runtime = await buildTwinRuntimeAdapters(settings)
  if (!runtime.ready) return null
  const llm = createAnthropicLlmClient({
    provider: settings.llm.provider,
    model: settings.llm.model,
    apiKey: settings.llm.apiKey,
    baseURL: settings.llm.baseURL,
  })
  return {
    embedding: settings.embedding,
    vectorBackend: settings.storage.vectorBackend,
    store: runtime.adapters.store,
    sourceLoader: buildSourceLoader(),
    nameHints: settings.extraNameHints,
    // Distillation is background generation, so Router + Fusion reserves and
    // settles every sub-agent call the worker makes when `utilityLedger` is on
    // (ADR-0188 D27). Off — the default — `ledgerUtilityCalls` hands `llm` back
    // untouched and no Router + Fusion module is loaded.
    llm: ledgerUtilityCalls(llm, {
      binding: {
        surface: "utilityLedger",
        origin: "utility",
        featureId: "twin-distill-worker",
        providerId: settings.llm.provider,
        modelId: settings.llm.model,
        workspaceId: null,
      },
      settings: await currentRouterFusionGateSettings(),
    }),
  }
}
