/**
 * Public OCR surface — `extract()` is what composer, slash command, and the
 * plugin tool all call.
 *
 * Responsibilities:
 *   1. Resolve `OcrInput.source` to a Blob + mime type (callers pass an
 *      `attachmentResolver` / `filePathResolver` when those source kinds are
 *      in play; data-url / blob sources resolve inline).
 *   2. Compute the cache key, read through the Dexie cache, short-circuit on hit.
 *   3. Pick the provider (explicit id or auto-router).
 *   4. Call `provider.extract()`, wrap timing + cost, write back to the cache.
 *
 * The function is shaped so that every external dependency (registry,
 * settings, platform detection, credentials lookup) is injectable. Test code
 * passes a small fake provider; production code passes the shared registry +
 * `keyring`-backed credentials resolver.
 */

import type { NativePlatform } from "./types/platform"
import { sha256Blob, sha256Bytes, sha256String } from "./hash"
import type { OcrPageCache, OcrResultCache } from "./cache-contract"
import {
  combinePageMarkdown,
  combinePageText,
  isPdfMimeType,
  normalizeLanguages,
} from "./image-prep"
import { OCR_PROVIDER_CAPABILITIES } from "./capabilities"
import type { PdfLoader } from "./pdf-router"
import { readBlobAsArrayBuffer } from "./blob-utils"
import { buildOcrDocument } from "./document"
import { decideEscalation, documentConfidence } from "./confidence"
import { OcrError } from "./errors"
import {
  type OcrCredentials,
  type OcrInput,
  type OcrProvider,
  type OcrProviderConfig,
  type OcrResult,
  type OcrSource,
  type UserOcrSettings,
} from "./types"
import type { OcrRegistry } from "./registry"
import { isOnDeviceOcrProvider } from "./registry"
import { listProviderCandidates, resolveProviderById } from "./auto-router"
import type { HasCredentialsFn, LocalReadinessFn } from "./auto-router"
import type { OcrRuntimeStatusResolver } from "./runtime-status"

export interface ResolvedSource {
  blob: Blob
  mimeType: string
  /** Bytes already on hand — providers can re-use without another fetch. */
  bytes?: Uint8Array
}

export interface AttachmentResolver {
  (attachmentId: string): Promise<ResolvedSource>
}

export interface FilePathResolver {
  (path: string): Promise<ResolvedSource>
}

export interface CredentialsResolver {
  (providerId: string, keys: readonly string[]): Promise<OcrCredentials>
}

export interface ExtractDeps {
  registry: OcrRegistry
  settings: UserOcrSettings
  platform: NativePlatform
  /** Sub-OS tag for the auto-router's local preference table. */
  osTag?: "windows" | "macos" | "linux" | "ios" | "android" | "browser"
  /** Pulls credentials from the keyring (Tauri) or encrypted Dexie (web). */
  credentialsResolver: CredentialsResolver
  /**
   * Read-through result cache. REQUIRED on purpose: an optional cache would let
   * a missed construction site silently stop persisting OCR output. Callers that
   * genuinely want no persistence pass `createNullOcrCache()`.
   */
  cache: OcrResultCache
  /** Per-page cache for the streaming PDF path. Same required-on-purpose rule. */
  pageCache: OcrPageCache
  /** Required only when callers pass `kind: "attachment-id"` sources. */
  attachmentResolver?: AttachmentResolver
  /** Required only when callers pass `kind: "file-path"` sources. */
  filePathResolver?: FilePathResolver
  /** Host PDF loader used when the selected engine requires image pages. */
  loadPdf?: PdfLoader
  /** Host restriction for inputs that must stay on the device. */
  onDeviceOnly?: boolean
  /** Model-owned requests cannot override the saved provider enablement. */
  requireEnabledProvider?: boolean
  /** Hook for tests / observability — every extract result flows through here. */
  onResult?: (result: OcrResult) => void
  /** Runtime truth used by auto-routing; production hosts should always provide it. */
  runtimeStatus?: OcrRuntimeStatusResolver
  /** Legacy split probes retained for embedders while they migrate to runtimeStatus. */
  localReadiness?: LocalReadinessFn
  hasCredentials?: HasCredentialsFn
}

async function resolveSource(
  source: OcrSource,
  deps: Pick<ExtractDeps, "attachmentResolver" | "filePathResolver">
): Promise<ResolvedSource> {
  if (source.kind === "blob") {
    return { blob: source.blob, mimeType: source.mimeType || source.blob.type }
  }
  if (source.kind === "data-url") {
    const match = /^data:([^;,]+)(?:;[^,]*)*;base64,(.+)$/.exec(source.dataUrl)
    if (!match) {
      throw new OcrError("invalid_input", "extract", "Data URL must be base64-encoded.")
    }
    const mimeType = source.mimeType || match[1]!
    const b64 = match[2]!
    const bin =
      typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary")
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return {
      blob: new Blob([bytes as BlobPart], { type: mimeType }),
      mimeType,
      bytes,
    }
  }
  if (source.kind === "file-path") {
    if (!deps.filePathResolver) {
      throw new OcrError(
        "invalid_input",
        "extract",
        "file-path source requires a filePathResolver."
      )
    }
    return deps.filePathResolver(source.path)
  }
  if (!deps.attachmentResolver) {
    throw new OcrError(
      "invalid_input",
      "extract",
      "attachment-id source requires an attachmentResolver."
    )
  }
  return deps.attachmentResolver(source.attachmentId)
}

async function computeFileSha(resolved: ResolvedSource): Promise<string> {
  if (resolved.bytes) return sha256Bytes(resolved.bytes)
  return sha256Blob(resolved.blob)
}

function pickProviderConfig(settings: UserOcrSettings, providerId: string): OcrProviderConfig {
  return settings.providerConfig[providerId] ?? {}
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OcrError("aborted", "extract", "OCR cancelled.")
}

async function callProvider(
  provider: OcrProvider,
  input: OcrInput,
  deps: ExtractDeps,
  signal: AbortSignal | undefined
): Promise<OcrResult> {
  checkCancelled(signal)
  const credentials = await deps.credentialsResolver(provider.id, provider.credentialKeys)
  checkCancelled(signal)
  const start = Date.now()
  try {
    const out = await provider.extract(input, {
      credentials,
      config: pickProviderConfig(deps.settings, provider.id),
      signal,
      platform: deps.platform,
    })
    checkCancelled(signal)
    const durationMs = out.durationMs > 0 ? out.durationMs : Date.now() - start
    return rebuildResult(out, provider.id, durationMs)
  } catch (err) {
    // Duck-type as well as instanceof so cross-module require chains (rare in
    // app code, common in Jest) still preserve the original error code.
    if (
      err instanceof OcrError ||
      (err !== null &&
        typeof err === "object" &&
        (err as { name?: string }).name === "OcrError" &&
        "code" in err &&
        "providerId" in err)
    ) {
      throw err
    }
    throw new OcrError(
      "provider_failed",
      provider.id,
      err instanceof Error ? err.message : String(err),
      err
    )
  }
}

/** Re-normalize an OcrResult so we always emit consistent combined fields. */
function rebuildResult(raw: OcrResult, providerId: string, durationMs: number): OcrResult {
  const combinedMarkdown = raw.combinedMarkdown || combinePageMarkdown(raw.pages)
  const combinedText = raw.combinedText || combinePageText(raw.pages)
  // Phase 2 — synthesize the typed IR from the per-page output when a provider
  // didn't supply one. Additive: combined fields above are unchanged.
  const document = raw.document ?? buildOcrDocument(raw.pages, providerId)
  return {
    ...raw,
    providerId,
    combinedMarkdown,
    combinedText,
    durationMs,
    cached: false,
    document,
  }
}

/**
 * E2E hook: when running under `NEXT_PUBLIC_E2E=1` the renderer may publish
 * `window.__cogniaE2EOcrMock` (a function `(input) => Promise<OcrResult> |
 * OcrResult`) to short-circuit provider selection entirely. The mock's
 * return value is forwarded through the standard `onResult` callback and
 * caching path is skipped. Dead-code-eliminated in production because the
 * global is only installed by the dev-only bridge in
 * `lib/dev/expose-test-globals.tsx`.
 */
function readOcrMockHook(): ((input: OcrInput) => Promise<OcrResult> | OcrResult) | null {
  if (typeof window === "undefined") return null
  const w = window as {
    __cogniaE2EOcrMock?: (input: OcrInput) => Promise<OcrResult> | OcrResult
  }
  return typeof w.__cogniaE2EOcrMock === "function" ? w.__cogniaE2EOcrMock : null
}

/**
 * The single public entry point used by composer / slash command / plugin tool.
 * `deps` carries every dependency (registry, settings, platform, credentials)
 * so tests can stub each independently. Callers in app code construct deps
 * once via `lib/ocr/runtime.ts` (browser) or via `useOcr()` (React).
 */
export async function extract(input: OcrInput, deps: ExtractDeps): Promise<OcrResult> {
  checkCancelled(input.signal)

  const mock = readOcrMockHook()
  if (mock) {
    const out = await mock(input)
    checkCancelled(input.signal)
    deps.onResult?.(out)
    return out
  }

  if (
    (deps.requireEnabledProvider || deps.onDeviceOnly) &&
    input.providerId !== undefined &&
    deps.settings.providerEnabled[input.providerId] === false
  ) {
    throw new OcrError(
      "unsupported_shell",
      input.providerId,
      "The requested OCR provider is disabled."
    )
  }
  const explicitProvider =
    input.providerId === undefined
      ? undefined
      : resolveProviderById(deps.registry, input.providerId, deps.platform)
  if (explicitProvider && deps.onDeviceOnly && !isOnDeviceOcrProvider(explicitProvider)) {
    throw new OcrError(
      "unsupported_shell",
      explicitProvider.id,
      "This OCR input requires an on-device engine."
    )
  }
  const resolved = await resolveSource(input.source, deps)
  checkCancelled(input.signal)
  const useCache = input.useCache !== false
  const fileSha = useCache ? await computeFileSha(resolved) : ""
  checkCancelled(input.signal)
  const languages = normalizeLanguages(input.languages, deps.settings.defaultLanguages)

  // An explicit request is strict. Auto/default selection gets an ordered,
  // readiness-gated chain and may continue after retryable provider failures.
  const candidates = explicitProvider
    ? [explicitProvider]
    : await listProviderCandidates({
        registry: deps.registry,
        settings: deps.settings,
        platform: deps.platform,
        osTag: deps.osTag,
        localPreference: deps.settings.platformOverrides,
        runtimeStatus: deps.runtimeStatus,
        localReadiness: deps.localReadiness,
        hasCredentials: deps.hasCredentials,
        allowsProvider: deps.onDeviceOnly ? isOnDeviceOcrProvider : undefined,
      })
  if (candidates.length === 0) {
    throw new OcrError(
      "provider_failed",
      "auto-router",
      "No ready OCR provider is available for the current shell. Configure one in settings → OCR."
    )
  }

  // Hand a blob-backed input down to the provider so file-path / attachment
  // sources don't have to be re-resolved.
  const providerInput: OcrInput = {
    ...input,
    languages,
    source: { kind: "blob", blob: resolved.blob, mimeType: resolved.mimeType },
  }
  const isPdf = isPdfMimeType(resolved.mimeType)
  const runProvider = async (provider: OcrProvider): Promise<OcrResult> => {
    const nativePdf = OCR_PROVIDER_CAPABILITIES[provider.id]?.pdfNative
    if (
      !isPdf ||
      provider.id === "mistral-ocr" ||
      (!input.pageRange?.trim() && nativePdf && nativePdf !== "no")
    ) {
      return callProvider(provider, providerInput, deps, input.signal)
    }
    const { defaultPdfLoader, extractPdf } = await import("./pdf-router")
    const result = await extractPdf(
      {
        bytes: resolved.bytes ?? new Uint8Array(await readBlobAsArrayBuffer(resolved.blob)),
        pageRange: input.pageRange,
        languages,
      },
      {
        loadPdf: deps.loadPdf ?? defaultPdfLoader,
        extractDeps: deps,
        ocrProviderId: provider.id,
        signal: input.signal,
        ocrPage: (page) =>
          callProvider(provider, { ...page, format: input.format }, deps, input.signal),
      }
    )
    return rebuildResult(result, provider.id, result.durationMs)
  }

  // Bind the cached result to the primary request and the current escalation
  // authority. A result produced by a now-disallowed target must be a miss.
  const targetId = deps.settings.escalationProviderId ?? deps.settings.cloudFallbackProviderId
  const target =
    input.providerId === undefined && deps.settings.confidenceEscalation === "escalate"
      ? candidates.find(
          (candidate) =>
            candidate.id === targetId &&
            (candidate.category === "local" || deps.settings.cloudFallbackEnabled)
        )
      : undefined
  let lastError: unknown
  for (const [index, provider] of candidates.entries()) {
    checkCancelled(input.signal)
    const escalation = target?.id === provider.id ? undefined : target
    const key = {
      fileSha,
      providerId: provider.id,
      languages,
      requestHash: useCache
        ? await sha256String(
            JSON.stringify([
              resolved.mimeType,
              input.pageRange?.trim(),
              input.format ?? deps.settings.defaultFormat,
              pickProviderConfig(deps.settings, provider.id),
              isPdf && deps.settings.pdfTextLayerFastPath,
              escalation && [
                escalation.id,
                deps.settings.confidenceThreshold,
                pickProviderConfig(deps.settings, escalation.id),
              ],
            ])
          )
        : undefined,
    }
    checkCancelled(input.signal)
    if (useCache) {
      let hit: OcrResult | null = null
      try {
        hit = await deps.cache.read(key)
      } catch {
        // Local storage failure is a miss, never a provider failure.
      }
      checkCancelled(input.signal)
      if (hit) {
        deps.onResult?.(hit)
        return hit
      }
    }

    let result: OcrResult
    try {
      result = await runProvider(provider)
    } catch (error) {
      checkCancelled(input.signal)
      lastError = error
      if (
        input.providerId !== undefined ||
        index === candidates.length - 1 ||
        !isRetryableProviderError(error)
      )
        throw error
      continue
    }
    checkCancelled(input.signal)
    let cacheable = true
    if (
      escalation &&
      decideEscalation({
        settings: deps.settings,
        primaryProviderId: provider.id,
        confidence: documentConfidence(result.document),
      }).escalate
    ) {
      try {
        result = await runProvider(escalation)
      } catch {
        checkCancelled(input.signal)
        // A transient escalation failure shouldn't suppress a later retry.
        cacheable = false
      }
    }

    checkCancelled(input.signal)
    if (useCache && cacheable) {
      try {
        await deps.cache.write({ ...key, result, bytesIn: resolved.blob.size })
      } catch {
        // The OCR result is already usable. Storage must not trigger egress.
      }
    }
    checkCancelled(input.signal)
    deps.onResult?.(result)
    return result
  }

  throw lastError
}

function isRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof OcrError)) return true
  return (
    error.code === "unsupported_shell" ||
    error.code === "missing_credentials" ||
    error.code === "rate_limited" ||
    error.code === "provider_failed"
  )
}

export { OcrError } from "./errors"
export type {
  OcrRuntimeStatus,
  OcrRuntimeStatusResolver,
  OcrModelRuntimeStatus,
  OcrUnavailableReason,
} from "./runtime-status"
