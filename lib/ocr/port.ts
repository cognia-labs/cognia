// The OCR module's implementation of the `ocr` port
// (`types/modules/ports/ocr.ts`, ADR-0250 §14). `lib/modules/ports.ts` loads it
// the first time a user asks for the port, on any host: the providers it
// dispatches to are the ones the module's runtime installed there.

import { DEFAULT_OCR_SETTINGS } from "@/types/ocr"
import type { OcrPort } from "@/types/modules/ports/ocr"
import { listProviderCandidates } from "./auto-router"
import { buildOcrDeps } from "./deps"
import { extract } from "./index"
import { createPdfLoader } from "./pdf-loader"
import { extractPdf } from "./pdf-router"
import { getSharedOcrRegistry } from "./registry"
import { loadUserOcrSettings } from "./user-settings"

export const port: OcrPort = {
  loadSettings: async () => (await loadUserOcrSettings()) ?? DEFAULT_OCR_SETTINGS,
  deps: (options = {}) => buildOcrDeps(options),
  extract: (input, deps) => extract(input, deps ?? buildOcrDeps()),
  pdfDeps: ({ settings } = {}) => {
    const extractDeps = buildOcrDeps({ settings })
    return { loadPdf: createPdfLoader(), extractDeps, settings: extractDeps.settings }
  },
  extractPdf,
  candidates: (deps, { cloudFallback } = {}) =>
    listProviderCandidates({
      registry: deps.registry,
      settings:
        cloudFallback === false ? { ...deps.settings, cloudFallbackEnabled: false } : deps.settings,
      platform: deps.platform,
      osTag: deps.osTag,
      localPreference: deps.settings.platformOverrides,
      runtimeStatus: deps.runtimeStatus,
      localReadiness: deps.localReadiness,
      hasCredentials: deps.hasCredentials,
    }),
  providers: () => getSharedOcrRegistry().list(),
}
