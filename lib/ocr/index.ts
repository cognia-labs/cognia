/**
 * Boundary shim — the implementation moved into `@cognia/ocr` (the pure,
 * dependency-injected OCR core). Kept so existing `@/lib/ocr/index` importers and
 * the app-side composition roots (runtime.ts, deps.ts, cache.ts, credentials.ts)
 * stay unchanged.
 *
 * `extract` is re-exported through a metering wrapper rather than passed
 * straight through. OCR is billed per page (or per image, or per token) by
 * every cloud provider and was metered nowhere: a hundred-page PDF cost real
 * money and left the Usage tab unchanged. The wrapper lives here, not in the
 * package, because `@cognia/ocr` is one of the zero-`@/` standalone builds
 * (`pnpm build:packages`) and cannot reach the app's Dexie layer.
 */
import { extract as extractCore, type ExtractDeps } from "@cognia/ocr"
// `@cognia/ocr`'s root re-exports the types it uses but does not re-export
// `OcrInput` / `OcrResult` themselves; the subpath is where they live.
import type { OcrInput, OcrResult } from "@cognia/ocr/types"

import { recordSurfaceUsage, swallowUsageWrite } from "@/lib/db/session-usage"

export * from "@cognia/ocr"

/**
 * Run OCR and meter what it billed.
 *
 * A CACHED result is not metered: it cost nothing this time, and counting it
 * would make the same document look more expensive every time it is re-read.
 */
export async function extract(input: OcrInput, deps: ExtractDeps): Promise<OcrResult> {
  const result = await extractCore(input, deps)
  if (!result.cached && result.pages.length > 0) {
    swallowUsageWrite(
      recordSurfaceUsage({
        surface: "ocr",
        // One row per provider call: a cache miss that reads the same document
        // again was billed again, so keying the row on the produced text (as
        // this did) folded two paid extractions into one.
        operationId: `${result.providerId}:${crypto.randomUUID()}`,
        scopeId: result.providerId,
        usage: {
          providerId: result.providerId,
          // An OCR service sells one product, so it is its own model: the
          // `[day, provider, model]` budget rollup needs both to count it.
          model: result.providerId,
          durationMs: result.durationMs,
          // The provider's own USD projection when it made one. Absent, the
          // ledger prices the pages from the catalog or leaves them unpriced.
          ...(typeof result.costEstimate?.amount === "number"
            ? { costUsd: result.costEstimate.amount, costSource: "sdk", costKnown: true }
            : {}),
          unitBreakdown: { pages: result.pages.length },
        },
      })
    )
  }
  return result
}
