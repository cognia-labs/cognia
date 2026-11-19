import { extract, type ExtractDeps } from "./index"
import type { CacheLookupKey, OcrPageCache, OcrResultCache } from "./cache-contract"
import { createOcrRegistry } from "./registry"
import {
  DEFAULT_OCR_SETTINGS,
  type OcrInput,
  type OcrPage,
  type OcrProvider,
  type OcrResult,
  type UserOcrSettings,
} from "./types"

// In-memory stand-ins for the Dexie caches. `extract()` only needs the
// OcrResultCache / OcrPageCache contract, so this suite exercises the
// `cached:true` and `useCache:false` behaviours without booting Dexie — which
// is what lets it travel with the pipeline into the package.
const resultStore = new Map<string, OcrResult>()
const pageStore = new Map<string, OcrPage>()

function cacheId(key: CacheLookupKey): string {
  const langs = [...key.languages]
    .map((l) => l.toLowerCase())
    .sort()
    .join(",")
  return `${key.fileSha}|${key.providerId}|${langs}|${key.requestHash ?? ""}`
}

const memoryResultCache: OcrResultCache = {
  async read(key) {
    const hit = resultStore.get(cacheId(key))
    // The persistent cache marks a read-back result as cached; mirror that.
    return hit ? { ...hit, cached: true } : null
  },
  async write(input) {
    resultStore.set(cacheId(input), input.result)
  },
}

const memoryPageCache: OcrPageCache = {
  async read(key) {
    return pageStore.get(`${cacheId(key)}|p${key.pageNumber}`) ?? null
  },
  async write(key, page) {
    pageStore.set(`${cacheId(key)}|p${key.pageNumber}`, page)
  },
}
import { OcrError } from "./errors"

function makeProvider(overrides: Partial<OcrProvider> & { onCall?: () => void } = {}): OcrProvider {
  return {
    id: overrides.id ?? "mock",
    label: overrides.label ?? "Mock",
    category: overrides.category ?? "document-cloud",
    shells: overrides.shells ?? { browser: true, tauri: true, capacitor: true },
    credentialKeys: overrides.credentialKeys ?? [],
    reusesMainProviderKey: overrides.reusesMainProviderKey,
    async extract(input): Promise<OcrResult> {
      overrides.onCall?.()
      return {
        providerId: overrides.id ?? "mock",
        pages: [
          { pageNumber: 1, markdown: "# page 1", text: "page 1" },
          { pageNumber: 2, markdown: "# page 2", text: "page 2" },
        ],
        combinedMarkdown: "",
        combinedText: "",
        languages: input.languages ?? [],
        durationMs: 0,
        cached: false,
      }
    },
  }
}

function makeDeps(overrides: Partial<ExtractDeps> = {}): ExtractDeps {
  const registry = overrides.registry ?? createOcrRegistry()
  return {
    registry,
    settings: overrides.settings ?? { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "mock" },
    platform: overrides.platform ?? "web",
    osTag: overrides.osTag,
    credentialsResolver: overrides.credentialsResolver ?? (async () => ({ secrets: {} })),
    cache: overrides.cache ?? memoryResultCache,
    pageCache: overrides.pageCache ?? memoryPageCache,
    attachmentResolver: overrides.attachmentResolver,
    filePathResolver: overrides.filePathResolver,
    onResult: overrides.onResult,
  }
}

const sampleInput: OcrInput = {
  source: {
    kind: "data-url",
    dataUrl: "data:image/png;base64,YWJj",
    mimeType: "image/png",
  },
}

beforeEach(() => {
  resultStore.clear()
  pageStore.clear()
})

describe("extract — dispatch", () => {
  it("rasterizes the requested PDF page before calling an image-only engine", async () => {
    const d = makeDeps()
    const renderToDataUrl = jest.fn(async () => ({
      dataUrl: sampleInput.source.kind === "data-url" ? sampleInput.source.dataUrl : "",
      width: 10,
      height: 20,
    }))
    const getPage = jest.fn(async (pageNumber: number) => ({
      pageNumber,
      renderToDataUrl,
      getTextContent: async () => ({ items: [] }),
    }))
    const engine = makeProvider({ id: "paddle-ocr", category: "local" })
    const recognize = jest.fn(async (...args: Parameters<OcrProvider["extract"]>) => ({
      ...(await engine.extract(...args)),
      costEstimate: { unit: "image" as const, amount: 0.01, currency: "USD" as const },
    }))
    d.registry.register({ ...engine, extract: recognize })
    const output = await extract(
      {
        source: {
          kind: "data-url",
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,JVBERi0x",
        },
        providerId: engine.id,
        pageRange: "2",
      },
      { ...d, loadPdf: async () => ({ numPages: 3, getPage }) } as ExtractDeps
    )
    expect(output.pages.map((page) => page.pageNumber)).toEqual([2])
    expect(output.costEstimate?.amount).toBe(0.01)
    expect(getPage).toHaveBeenCalledTimes(1)
    expect(recognize.mock.calls[0]?.[0].source).toMatchObject({ mimeType: "image/png" })
  })
  it("does not reuse OCR text across provider model changes", async () => {
    const d = makeDeps()
    d.registry.register(makeProvider({ id: "mock" }))
    await extract(sampleInput, d)
    const next = await extract(sampleInput, {
      ...d,
      settings: { ...d.settings, providerConfig: { mock: { model: "new-model" } } },
    })
    expect(next.cached).toBe(false)
  })

  it("keeps an explicit local provider when confidence is low", async () => {
    const d = makeDeps({
      settings: { ...DEFAULT_OCR_SETTINGS, confidenceEscalation: "escalate" },
    })
    const cloud = jest.fn(makeProvider({ id: "mistral-ocr" }).extract)
    d.registry.register({ ...makeProvider({ id: "mistral-ocr" }), extract: cloud })
    const local = makeProvider({ id: "mock", category: "local" })
    d.registry.register({
      ...local,
      extract: async (input, ctx) => {
        const out = await local.extract(input, ctx)
        out.pages[0].blocks = [{ text: "page 1", confidence: 0.2 }]
        return out
      },
    })
    await expect(extract({ ...sampleInput, providerId: "mock" }, d)).resolves.toMatchObject({
      providerId: "mock",
    })
    expect(cloud).not.toHaveBeenCalled()
  })
  it("aborts immediately when the signal is already triggered", async () => {
    const deps = makeDeps()
    deps.registry.register(makeProvider({ id: "mock" }))
    const controller = new AbortController()
    controller.abort()
    await expect(
      extract({ ...sampleInput, signal: controller.signal }, deps)
    ).rejects.toMatchObject({ code: "aborted" })
  })

  it("resolves a data-url source and calls the provider", async () => {
    let called = 0
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock", onCall: () => called++ }))
    const result = await extract(sampleInput, makeDeps({ registry: reg }))
    expect(called).toBe(1)
    expect(result.providerId).toBe("mock")
    expect(result.cached).toBe(false)
    expect(result.pages).toHaveLength(2)
  })

  it("rebuilds combined markdown / text from per-page entries when blank", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const result = await extract(sampleInput, makeDeps({ registry: reg }))
    expect(result.combinedMarkdown).toContain("page 1")
    expect(result.combinedMarkdown).toContain("page 2")
    expect(result.combinedMarkdown).toContain("---")
    expect(result.combinedText).toBe("page 1\n\npage 2")
  })

  it("never lets an agent dispatch to an explicitly disabled provider", async () => {
    const d = makeDeps()
    const provider = makeProvider({ id: "mock" })
    const recognize = jest.fn(provider.extract)
    d.registry.register({ ...provider, extract: recognize })
    await expect(
      extract(
        { ...sampleInput, providerId: provider.id },
        {
          ...d,
          requireEnabledProvider: true,
          settings: { ...d.settings, providerEnabled: { [provider.id]: false } },
        }
      )
    ).rejects.toMatchObject({ code: "unsupported_shell" })
    expect(recognize).not.toHaveBeenCalled()
  })

  it("honours an explicit providerId via the input", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "alpha" }))
    reg.register(makeProvider({ id: "beta" }))
    const result = await extract(
      { ...sampleInput, providerId: "beta" },
      makeDeps({ registry: reg })
    )
    expect(result.providerId).toBe("beta")
  })

  it("falls back to the auto-router when no providerId is set", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "tess", category: "local" }))
    reg.register(makeProvider({ id: "mistral", category: "document-cloud" }))
    const settings: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "auto" }
    const result = await extract(
      sampleInput,
      makeDeps({ registry: reg, settings, platform: "web" })
    )
    // The web-default local engine is tesseract-wasm; we didn't register it,
    // so the router lands on the cloud fallback (mistral here, since it's the
    // only cloud provider) before the last-resort.
    expect(["tess", "mistral"]).toContain(result.providerId)
  })
})

describe("extract — source resolvers", () => {
  it("invokes the attachmentResolver for attachment-id sources", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const attachmentResolver = jest.fn(async () => ({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      mimeType: "image/png",
    }))
    await extract(
      { source: { kind: "attachment-id", attachmentId: "att_1" } },
      makeDeps({ registry: reg, attachmentResolver })
    )
    expect(attachmentResolver).toHaveBeenCalledWith("att_1")
  })

  it("throws invalid_input when an attachment source has no resolver", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    await expect(
      extract({ source: { kind: "attachment-id", attachmentId: "x" } }, makeDeps({ registry: reg }))
    ).rejects.toMatchObject({ code: "invalid_input" })
  })

  it("invokes the filePathResolver for file-path sources", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const filePathResolver = jest.fn(async () => ({
      blob: new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }),
      mimeType: "image/png",
    }))
    await extract(
      { source: { kind: "file-path", path: "/tmp/x.png" } },
      makeDeps({ registry: reg, filePathResolver })
    )
    expect(filePathResolver).toHaveBeenCalledWith("/tmp/x.png")
  })

  it("throws invalid_input when a file-path source has no resolver", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    await expect(
      extract({ source: { kind: "file-path", path: "/tmp/x.png" } }, makeDeps({ registry: reg }))
    ).rejects.toMatchObject({ code: "invalid_input" })
  })

  it("throws invalid_input on a malformed data URL", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    await expect(
      extract(
        {
          source: { kind: "data-url", dataUrl: "data:image/png,not-base64", mimeType: "image/png" },
        },
        makeDeps({ registry: reg })
      )
    ).rejects.toMatchObject({ code: "invalid_input" })
  })

  it("resolves a blob source inline", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const blob = new Blob([new Uint8Array([7, 8])], { type: "image/jpeg" })
    const result = await extract(
      { source: { kind: "blob", blob, mimeType: "image/jpeg" } },
      makeDeps({ registry: reg })
    )
    expect(result.providerId).toBe("mock")
  })
})

describe("extract — caching", () => {
  it.each(["read", "write"] as const)(
    "keeps the local result when cache %s fails",
    async (method) => {
      const d = makeDeps({
        cache: {
          ...memoryResultCache,
          [method]: () => Promise.reject(new Error("cache unavailable")),
        },
      })
      const local = makeProvider({ id: "paddle-ocr", category: "local" })
      const cloud = jest.fn(makeProvider({ id: "mistral-ocr" }).extract)
      d.registry.register(local)
      d.registry.register({ ...makeProvider({ id: "mistral-ocr" }), extract: cloud })
      const deps = {
        ...d,
        platform: "tauri" as const,
        settings: { ...d.settings, defaultProviderId: local.id, cloudFallbackEnabled: true },
      }
      await expect(extract(sampleInput, deps)).resolves.toMatchObject({ providerId: local.id })
      expect(cloud).not.toHaveBeenCalled()
    }
  )

  it("reuses an escalated result only while that target is allowed", async () => {
    const d = makeDeps()
    const local = makeProvider({ id: "paddle-ocr", category: "local" })
    const cloud = jest.fn(makeProvider({ id: "mistral-ocr" }).extract)
    const recognize = jest.fn(
      async (input: OcrInput, ctx: Parameters<OcrProvider["extract"]>[1]) => ({
        ...(await local.extract(input, ctx)),
        pages: [
          {
            pageNumber: 1,
            text: "local",
            markdown: "local",
            blocks: [{ text: "local", kind: "paragraph" as const, confidence: 0.1 }],
          },
        ],
      })
    )
    d.registry.register({ ...local, extract: recognize })
    d.registry.register({ ...makeProvider({ id: "mistral-ocr" }), extract: cloud })
    const settings = {
      ...d.settings,
      defaultProviderId: local.id,
      cloudFallbackEnabled: true,
      confidenceEscalation: "escalate" as const,
      escalationProviderId: "mistral-ocr",
    }
    const deps = { ...d, platform: "tauri" as const, settings }
    await expect(extract(sampleInput, deps)).resolves.toMatchObject({
      providerId: "mistral-ocr",
      cached: false,
    })
    await expect(extract(sampleInput, deps)).resolves.toMatchObject({
      providerId: "mistral-ocr",
      cached: true,
    })
    expect(recognize).toHaveBeenCalledTimes(1)
    await expect(
      extract(sampleInput, { ...deps, settings: { ...settings, cloudFallbackEnabled: false } })
    ).resolves.toMatchObject({ providerId: local.id })
    expect(cloud).toHaveBeenCalledTimes(1)
  })

  it("discards an in-flight result from a provider that cannot be interrupted", async () => {
    const controller = new AbortController()
    const onResult = jest.fn()
    const write = jest.fn(memoryResultCache.write)
    const d = makeDeps({ onResult, cache: { ...memoryResultCache, write } })
    const provider = makeProvider()
    let started!: () => void
    const inFlight = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    d.registry.register({
      ...provider,
      extract: async (input, ctx) => {
        started()
        await pending
        return provider.extract(input, ctx)
      },
    })
    const result = extract({ ...sampleInput, signal: controller.signal }, d)
    await inFlight
    controller.abort()
    release()
    await expect(result).rejects.toMatchObject({ code: "aborted" })
    expect(write).not.toHaveBeenCalled()
    expect(onResult).not.toHaveBeenCalled()
  })
  it("returns cached:true on the second call with the same input", async () => {
    let called = 0
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock", onCall: () => called++ }))
    const deps = makeDeps({ registry: reg })
    const first = await extract(sampleInput, deps)
    const second = await extract(sampleInput, deps)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(called).toBe(1)
  })

  it("skips both read and write when useCache is false", async () => {
    let called = 0
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock", onCall: () => called++ }))
    const deps = makeDeps({ registry: reg })
    await extract({ ...sampleInput, useCache: false }, deps)
    await extract({ ...sampleInput, useCache: false }, deps)
    expect(called).toBe(2)
  })

  it("invokes onResult for every dispatch (cached or fresh)", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const onResult = jest.fn()
    const deps = makeDeps({ registry: reg, onResult })
    await extract(sampleInput, deps)
    await extract(sampleInput, deps)
    expect(onResult).toHaveBeenCalledTimes(2)
  })
})

describe("extract — error wrapping", () => {
  it("continues the automatic candidate chain after a retryable failure", async () => {
    const calls: string[] = []
    const reg = createOcrRegistry()
    reg.register({
      ...makeProvider({ id: "paddle-ocr", category: "local" }),
      async extract() {
        calls.push("paddle-ocr")
        throw new OcrError("provider_failed", "paddle-ocr", "runtime unavailable")
      },
    })
    reg.register({
      ...makeProvider({ id: "mistral-ocr", category: "document-cloud" }),
      async extract(input) {
        calls.push("mistral-ocr")
        return makeProvider({ id: "mistral-ocr" }).extract(input, {
          credentials: { secrets: {} },
          config: {},
          platform: "tauri",
        })
      },
    })
    const result = await extract(
      sampleInput,
      makeDeps({
        registry: reg,
        platform: "tauri",
        osTag: "linux",
        settings: { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "auto" },
        localReadiness: () => true,
        hasCredentials: () => true,
      })
    )
    expect(calls).toEqual(["paddle-ocr", "mistral-ocr"])
    expect(result.providerId).toBe("mistral-ocr")
  })

  it("never falls back when the request names an explicit provider", async () => {
    let fallbackCalls = 0
    const reg = createOcrRegistry()
    reg.register({
      ...makeProvider({ id: "paddle-ocr", category: "local" }),
      async extract() {
        throw new OcrError("provider_failed", "paddle-ocr", "runtime unavailable")
      },
    })
    reg.register(makeProvider({ id: "mistral-ocr", onCall: () => fallbackCalls++ }))
    await expect(
      extract({ ...sampleInput, providerId: "paddle-ocr" }, makeDeps({ registry: reg }))
    ).rejects.toMatchObject({ providerId: "paddle-ocr" })
    expect(fallbackCalls).toBe(0)
  })

  it("does not fall back after unsupported-language errors", async () => {
    let fallbackCalls = 0
    const reg = createOcrRegistry()
    reg.register({
      ...makeProvider({ id: "paddle-ocr", category: "local" }),
      async extract() {
        throw new OcrError("unsupported_language", "paddle-ocr", "unsupported")
      },
    })
    reg.register(
      makeProvider({ id: "mistral-ocr", category: "document-cloud", onCall: () => fallbackCalls++ })
    )
    await expect(
      extract(
        sampleInput,
        makeDeps({
          registry: reg,
          platform: "tauri",
          osTag: "linux",
          settings: { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "auto" },
          localReadiness: () => true,
          hasCredentials: () => true,
        })
      )
    ).rejects.toMatchObject({ code: "unsupported_language" })
    expect(fallbackCalls).toBe(0)
  })

  it("wraps a plain provider exception into provider_failed", async () => {
    const reg = createOcrRegistry()
    reg.register({
      ...makeProvider({ id: "boom" }),
      async extract() {
        throw new Error("network is down")
      },
    })
    await expect(
      extract({ ...sampleInput, providerId: "boom" }, makeDeps({ registry: reg }))
    ).rejects.toMatchObject({ code: "provider_failed", providerId: "boom" })
  })

  it("preserves a provider-thrown OcrError verbatim", async () => {
    const reg = createOcrRegistry()
    reg.register({
      ...makeProvider({ id: "ratelimited" }),
      async extract() {
        throw new OcrError("rate_limited", "ratelimited", "slow down")
      },
    })
    await expect(
      extract({ ...sampleInput, providerId: "ratelimited" }, makeDeps({ registry: reg }))
    ).rejects.toMatchObject({ code: "rate_limited" })
  })
})
