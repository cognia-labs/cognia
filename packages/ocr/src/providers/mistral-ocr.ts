/**
 * Mistral OCR 4 provider.
 *
 * Endpoint: POST https://api.mistral.ai/v1/ocr
 *   body: { model, document: { type, image_url|document_url } }
 *   response: { pages: [{ index, markdown, dimensions }], usage_info, ... }
 *
 * OCR 4 can also return structural blocks. The current public OCR result keeps
 * the Markdown response as its lossless representation until Mistral's block
 * labels are mapped onto Cognia's narrower block-kind union.
 */

import { bytesToDataUrl, isPdfMimeType, normalizeImage, parsePageRanges } from "../image-prep"
import { OcrError } from "../errors"
import {
  MISTRAL_OCR_DEFAULT_MODEL,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "../types"
import { cloudFetch, parseJson, requireSecret } from "./_http"

interface MistralOcrPage {
  index: number
  markdown?: string
  dimensions?: { dpi?: number; height?: number; width?: number }
}

interface MistralOcrResponse {
  pages: MistralOcrPage[]
  usage_info?: { pages_processed?: number; doc_size_bytes?: number }
}

const MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/ocr"

export interface MistralOcrConfig {
  model?: string
  endpoint?: string
  fetchImpl?: typeof fetch
}

export function buildMistralOcrProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "mistral-ocr",
    label: "Mistral OCR",
    category: "document-cloud",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["apiKey"],
    async extract(input, ctx) {
      return mistralExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function mistralExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const apiKey = requireSecret("mistral-ocr", ctx.credentials.secrets, "apiKey")
  const config = (ctx.config ?? {}) as MistralOcrConfig
  const normalized = await normalizeImage(input.source)
  const configuredModel = typeof config.model === "string" ? config.model : undefined
  // 4.0 retired; saved configs for it retain the supported 4.x path.
  const model =
    !configuredModel || configuredModel === "mistral-ocr-4-0"
      ? MISTRAL_OCR_DEFAULT_MODEL
      : configuredModel
  const endpoint = (typeof config.endpoint === "string" && config.endpoint) || MISTRAL_ENDPOINT

  const dataUrl = bytesToDataUrl(normalized.bytes, normalized.mimeType)
  const document = isPdfMimeType(normalized.mimeType)
    ? { type: "document_url" as const, document_url: dataUrl }
    : { type: "image_url" as const, image_url: dataUrl }
  let pageSelection: string | undefined
  if (document.type === "document_url" && input.pageRange?.trim()) {
    try {
      const ranges = parsePageRanges(input.pageRange)
      if (!ranges?.length) throw new Error("Select at least one PDF page")
      pageSelection = ranges
        .map(([start, end]) => (start === end ? String(start - 1) : `${start - 1}-${end - 1}`))
        .join(",")
    } catch (error) {
      throw new OcrError("invalid_input", "mistral-ocr", String(error), error)
    }
  }

  const start = Date.now()
  const res = await cloudFetch({
    providerId: "mistral-ocr",
    url: endpoint,
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model,
      document,
      ...(pageSelection ? { pages: pageSelection } : {}),
      // OCR 4 adds native paragraph bounding boxes and structural labels.
      // Request them now so the response remains forward-compatible even
      // while the public OcrPage contract continues to use Markdown.
      include_blocks:
        model === MISTRAL_OCR_DEFAULT_MODEL ||
        model === "mistral-ocr-4" ||
        model === "mistral-ocr-latest",
    },
    signal: ctx.signal,
    fetchImpl: fetchImpl ?? config.fetchImpl,
  })
  const data = parseJson<MistralOcrResponse>("mistral-ocr", res.body)

  const pages = (data.pages ?? []).map((p, i) => {
    const markdown = p.markdown ?? ""
    return {
      pageNumber: typeof p.index === "number" ? p.index + 1 : i + 1,
      markdown,
      text: markdownToPlainText(markdown),
      width: p.dimensions?.width,
      height: p.dimensions?.height,
    }
  })

  const durationMs = Date.now() - start
  return {
    providerId: "mistral-ocr",
    pages,
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs,
    cached: false,
    costEstimate:
      data.usage_info?.pages_processed !== undefined
        ? {
            unit: "page",
            // OCR API pricing: $4 per 1000 pages ($0.004/page).
            amount: data.usage_info.pages_processed * 0.004,
            currency: "USD",
          }
        : undefined,
  }
}

/**
 * Strip common Markdown decorations to produce plain text. Lightweight on
 * purpose — providers that return bbox / structured blocks ship their own
 * `text` field; for Mistral we synthesize it from the Markdown.
 */
function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim()
}

/** Default provider instance used by the shared registry. */
export const mistralOcrProvider = buildMistralOcrProvider()
