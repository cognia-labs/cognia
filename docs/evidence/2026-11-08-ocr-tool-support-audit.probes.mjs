// Characterization probes: a passing test confirms the named defect.
// These are audit evidence, not regression tests accepting the defective behavior.
// Run: node --test docs/evidence/2026-11-08-ocr-tool-support-audit.probes.mjs
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { after, test } from "node:test"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../../", import.meta.url))
const cache = path.join(root, ".cache/ocr-tool-support-audit")
await mkdir(cache, { recursive: true })
const scratch = await mkdtemp(path.join(cache, "probe-"))
const findings = []
after(async () => {
  await writeFile(path.join(cache, "probes.json"), JSON.stringify(findings, null, 2))
  await rm(scratch, { recursive: true, force: true })
})
const record = (id, details) => findings.push({ id, ...details })

// Only host-resource seams are substituted. OCR routing, cache lookup, provider
// request construction, plugin dispatch and port dependency construction are real.
const seams = new Map([
  [
    "@cognia/plugin-sdk",
    "export const definePlugin=x=>x, definePluginTool=x=>x, definePluginManifest=x=>x",
  ],
  [
    "@cognia/plugin-sdk/api/ocr-provider",
    "export const buildOcrResultPart=x=>x; export const buildOcrSecurityEnvelope=()=>({})",
  ],
  [
    "@/lib/platform/detect",
    "export const detectPlatform=()=>globalThis.__ocrAuditPlatform??'web'; export const isHeadlessHost=()=>detectPlatform()==='headless'",
  ],
  [
    "@/lib/db/session-usage",
    "export const recordSurfaceUsage=async()=>{}; export const swallowUsageWrite=()=>{}",
  ],
  [
    "@/lib/tauri",
    "export const transport={call:async command=>{if(command==='ocr_list_available_backends' && globalThis.__ocrAuditBackends)return globalThis.__ocrAuditBackends;throw Error('Unexpected native transport invocation')}}",
  ],
  [
    "@/lib/modules/ports",
    `export async function loadPort(){return (await import(${JSON.stringify(path.join(root, "lib/ocr/port.ts"))})).port}`,
  ],
  [
    "@/lib/claude/plugin-tool-ipc",
    "export const handlePluginToolExec=async()=>{throw Error('Unexpected tool dispatch')}",
  ],
])
const relativeSeams = new Map([
  ["plugins/ocr/src/index.ts:./ocr-result-card", "export const OcrResultCard=()=>null"],
  [
    "lib/ocr/deps.ts:./credentials",
    "export const createOcrCredentialsResolver=()=>async()=>({secrets:globalThis.__ocrAuditSecrets??{}})",
  ],
  [
    "lib/ocr/deps.ts:./cache",
    "export const dexieOcrResultCache={read:async()=>null,write:async()=>{}}; export const dexieOcrPageCache={read:async()=>null,write:async()=>{}}",
  ],
  [
    "lib/ocr/port.ts:./user-settings",
    "export const loadUserOcrSettings=async()=>globalThis.__ocrAuditSettings",
  ],
  [
    "lib/ocr/port.ts:./pdf-loader",
    "export const createPdfLoader=()=>async()=>{throw Error('Unexpected PDF loader invocation')}",
  ],
  [
    "lib/automation/ocr-screen.ts:./client",
    "export const desktop={screenshot:async()=>({format:'png',bytes:'YWJj'})}",
  ],
  ["lib/connectors/inbound-ocr.ts:./audit", "export const appendAudit=async()=>{}"],
  ["lib/automation/ocr-click.ts:./client", "export const desktop={}"],
  [
    "lib/automation/ocr-click.ts:./computer-use-pip",
    "export const publishComputerUseActivity=()=>{},publishComputerUsePipFrame=()=>{},suppressComputerUsePipForCapture=()=>{}",
  ],
])
const entry = `
export * from './packages/ocr/src/index.ts';
export * from './packages/ocr/src/registry.ts';
export * from './packages/ocr/src/auto-router.ts';
export * from './packages/ocr/src/cache-contract.ts';
export {DEFAULT_OCR_SETTINGS} from './packages/ocr/src/types/index.ts';
export {buildMistralOcrProvider} from './packages/ocr/src/providers/mistral-ocr.ts';
export {buildPaddleOcrProvider} from './packages/ocr/src/providers/paddle-ocr.ts';
export {ocrPluginDefinition,runOcrTool} from './plugins/ocr/src/index.ts';
export {handleOcrSlashCommand} from './lib/slash-commands/actions/ocr.ts';
export {ocrScreen} from './lib/automation/ocr-screen.ts';
export {port} from './lib/ocr/port.ts';
export {createOcrRuntimeStatusResolver} from './lib/ocr/deps.ts';
export {buildStandaloneTools} from './lib/ai/chat/standalone-tools.ts';
export {isOcrToolAllowed} from './lib/claude/ocr-tool-gate.ts';
export {readWindowText} from './lib/reply-copilot/screen/local-ocr.ts';
export {hasOcrableInboundImage,runInboundOcr} from './lib/connectors/inbound-ocr.ts';
export {buildPluginAccessMap,classifyToolCallConfinement} from './sidecar/src/policy/confinement/classify.ts';
`
const outfile = path.join(scratch, "source.mjs")
await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts" },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
  tsconfig: path.join(root, "tsconfig.json"),
  plugins: [
    {
      name: "audit-host-seams",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          const key = `${path.relative(root, args.importer)}:${args.path}`
          if (relativeSeams.has(key)) return { path: key, namespace: "audit-relative" }
          if (seams.has(args.path)) return { path: args.path, namespace: "audit-seam" }
          if (args.path === "@cognia/ocr")
            return { path: path.join(root, "packages/ocr/src/index.ts") }
          if (args.path.startsWith("@cognia/ocr/")) {
            const sub = args.path.slice("@cognia/ocr/".length)
            return {
              path: path.join(
                root,
                "packages/ocr/src",
                sub === "types" ? "types/index.ts" : `${sub}.ts`
              ),
            }
          }
        })
        builder.onLoad({ filter: /.*/, namespace: "audit-seam" }, (args) => ({
          contents: seams.get(args.path),
          resolveDir: root,
        }))
        builder.onLoad({ filter: /.*/, namespace: "audit-relative" }, (args) => ({
          contents: relativeSeams.get(args.path),
          resolveDir: root,
        }))
      },
    },
  ],
})
const src = await import(pathToFileURL(outfile).href)
const settings = (extra = {}) => ({ ...src.DEFAULT_OCR_SETTINGS, ...extra })
const image = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
}
const result = (id, text = id, languages = []) => ({
  providerId: id,
  pages: [{ pageNumber: 1, text, markdown: text }],
  combinedText: text,
  combinedMarkdown: text,
  languages,
  durationMs: 1,
  cached: false,
})
const provider = (id, category = "document-cloud", extract) => ({
  id,
  label: id,
  category,
  shells: { browser: true, tauri: true, capacitor: true },
  credentialKeys: [],
  extract: extract ?? (async (input) => result(id, id, input.languages)),
})
const deps = (providers, saved = settings(), extra = {}) => {
  const registry = src.createOcrRegistry()
  providers.forEach((p) => registry.register(p))
  return {
    registry,
    settings: saved,
    platform: "web",
    osTag: "browser",
    credentialsResolver: async () => ({ secrets: {} }),
    runtimeStatus: async (p) => ({ providerId: p.id, shellSupported: true, ready: true }),
    cache: src.createNullOcrCache(),
    pageCache: src.createNullOcrPageCache(),
    ...extra,
  }
}

test("F1: automatic routing invokes cloud with cloud fallback disabled", async () => {
  let calls = 0
  const cloud = provider("mistral-ocr", "document-cloud", async () => {
    calls++
    return result("mistral-ocr")
  })
  const local = provider("tesseract-wasm", "local", async () => {
    throw new src.OcrError("provider_failed", "tesseract-wasm", "fixture local failure")
  })
  const d = deps([local, cloud], settings({ cloudFallbackEnabled: false }))
  const out = await src.extract(image, d)
  assert.equal(out.providerId, "mistral-ocr")
  assert.equal(calls, 1)
  await assert.rejects(
    src.extract(image, {
      ...d,
      settings: settings({
        cloudFallbackEnabled: false,
        providerEnabled: { "mistral-ocr": false },
      }),
    }),
    { code: "provider_failed" }
  )
  assert.equal(calls, 1, "Explicit provider-disabled flag is respected as a control")
  const localHttp = provider("local-http", "local")
  const candidates = await src.listProviderCandidates({
    ...d,
    registry: deps([localHttp]).registry,
  })
  assert.deepEqual(
    candidates.map((p) => p.id),
    ["local-http"]
  )
  record("F1", {
    cloudFallbackEnabled: false,
    cloudCalls: calls,
    lastResortAlsoAutoSelectsLocalHttp: true,
  })
})

test("F2a: PDF bytes reach image-only native provider without rasterization", async () => {
  let received
  const pdf = {
    source: {
      kind: "data-url",
      dataUrl: "data:application/pdf;base64,JVBERi0xLjc=",
      mimeType: "application/pdf",
    },
    providerId: "paddle-ocr",
  }
  const d = deps(
    [src.buildPaddleOcrProvider()],
    settings({
      providerConfig: {
        "paddle-ocr": {
          invoker: async (payload) => {
            received = payload
            throw Error("fixture decoder rejects PDF")
          },
        },
      },
    }),
    { platform: "tauri", osTag: "linux" }
  )
  await assert.rejects(src.extract(pdf, d), { code: "provider_failed" })
  assert.equal(received.mimeType, "application/pdf")
  assert.equal(Buffer.from(received.bytes).toString(), "%PDF-1.7")
  record("F2a", {
    receivedMime: received.mimeType,
    receivedMagic: "%PDF-1.7",
    nativeDecoder: "not invoked; Rust source owns image decoding",
  })
})

test("F2b: Mistral pageRange is neither sent nor applied to returned pages", async () => {
  let body
  const p = src.buildMistralOcrProvider({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body)
      return new Response(
        JSON.stringify({
          pages: [
            { index: 0, markdown: "first" },
            { index: 1, markdown: "second" },
          ],
        })
      )
    },
  })
  const d = deps([p], settings(), {
    credentialsResolver: async () => ({ secrets: { apiKey: "audit-fixture" } }),
  })
  const out = await src.extract(
    {
      source: {
        kind: "data-url",
        dataUrl: "data:application/pdf;base64,JVBERi0xLjc=",
        mimeType: "application/pdf",
      },
      providerId: p.id,
      pageRange: "2",
    },
    d
  )
  assert.equal(body.document.type, "document_url")
  assert.equal(body.pages, undefined)
  assert.deepEqual(
    out.pages.map((p) => p.pageNumber),
    [1, 2]
  )
  record("F2b", { requestedPages: "2", requestKeys: Object.keys(body), returnedPages: [1, 2] })
})

test("F3: changed page range and model reuse the same whole-result cache", async () => {
  const stored = new Map()
  const key = (k) => `${k.fileSha}|${k.providerId}|${[...k.languages].sort().join(",")}`
  let calls = 0
  const p = provider("fixture", "document-cloud", async (input, ctx) => {
    calls++
    return result("fixture", `${input.pageRange}:${ctx.config.model}`)
  })
  const d = deps([p], settings({ providerConfig: { fixture: { model: "old" } } }), {
    cache: {
      read: async (k) => {
        const hit = stored.get(key(k))
        return hit ? { ...hit, cached: true } : null
      },
      write: async (k) => {
        stored.set(key(k), k.result)
      },
    },
  })
  const first = await src.extract({ ...image, providerId: p.id, pageRange: "1" }, d)
  const second = await src.extract({ ...image, providerId: p.id, pageRange: "2" }, d)
  const changed = { ...d, settings: settings({ providerConfig: { fixture: { model: "new" } } }) }
  const third = await src.extract({ ...image, providerId: p.id, pageRange: "1" }, changed)
  assert.equal(first.combinedText, "1:old")
  assert.equal(second.combinedText, "1:old")
  assert.equal(third.combinedText, "1:old")
  assert.equal(calls, 1)
  record("F3", {
    first: first.combinedText,
    changedRange: second.combinedText,
    changedModel: third.combinedText,
    calls,
  })
})

test("F4: composed screen tool ignores selected provider and persisted settings", async () => {
  const registry = src.getSharedOcrRegistry()
  registry.clear()
  registry.register(provider("tesseract-wasm", "local"))
  registry.register(provider("fixture-saved"))
  globalThis.__ocrAuditSettings = settings({
    defaultProviderId: "fixture-saved",
    defaultLanguages: ["zh"],
    cloudFallbackEnabled: false,
  })
  const control = await src.port.extract(
    image,
    src.port.deps({ settings: await src.port.loadSettings() })
  )
  assert.equal(control.providerId, "fixture-saved")
  const out = await src.runOcrTool(
    { source: { kind: "screen" }, provider: "fixture-saved", format: "blocks" },
    {
      runtime: { isReady: () => true, extractScreen: src.ocrScreen },
    }
  )
  assert.equal(out.ok, true)
  assert.equal(out.result.providerId, "tesseract-wasm")
  assert.deepEqual(out.result.languages, ["en"])
  record("F4", {
    savedProvider: control.providerId,
    screenProvider: out.result.providerId,
    screenLanguages: out.result.languages,
    screenshot: "synthetic stub",
  })
  delete globalThis.__ocrAuditSettings
  registry.clear()
})

test("F5: slash --provider auto is dispatched as a literal provider id", async () => {
  const d = deps([provider("fixture")], settings({ defaultProviderId: "fixture" }), {
    filePathResolver: async () => ({
      blob: new Blob(["fixture"], { type: "image/png" }),
      mimeType: "image/png",
    }),
  })
  const control = await src.handleOcrSlashCommand({
    argv: "fixture.png",
    deps: d,
    extract: src.extract,
  })
  assert.equal(control.result.providerId, "fixture")
  const out = await src.handleOcrSlashCommand({
    argv: "fixture.png --provider auto",
    deps: d,
    extract: src.extract,
  })
  assert.equal(out.errorCode, "provider_failed")
  assert.match(out.system, /provider "auto" is not registered/)
  record("F5", { withoutFlag: control.result.providerId, withAutoFlag: out.system })
})

test("F6: production readiness rejects mobile-native providers before probing them", async () => {
  const status = src.createOcrRuntimeStatusResolver(settings(), async () => ({ secrets: {} }))
  const statuses = await Promise.all(
    ["apple-vision", "mlkit-android"].map((id) => status(provider(id, "local"), "mobile"))
  )
  assert.ok(statuses.every((s) => s.ready === false && s.reason === "backend-not-bound"))
  record("F6", { statuses, nativePlugins: "not called by this readiness branch" })
})

test("F7: standalone tool map drops OCR's dotted registered name", () => {
  const tools = src.buildStandaloneTools(
    {
      pluginTools: [
        { name: "ocr.extract", description: "OCR", jsonSchema: { type: "object" } },
        { name: "safe_tool", description: "Control", jsonSchema: { type: "object" } },
      ],
    },
    "ocr-audit"
  )
  assert.equal(tools.tools["ocr.extract"], undefined)
  assert.deepEqual(tools.rejected, ["ocr.extract"])
  record("F7", { availableTools: Object.keys(tools.tools), rejected: tools.rejected })
})

test("F8: native Tesseract backend id does not match production readiness lookup", async () => {
  const rust = await readFile(path.join(root, "crates/cognia-ocr/src/backend/tesseract.rs"), "utf8")
  const backendId = /fn id\(&self\) -> &'static str\s*\{\s*"([^"]+)"/.exec(rust)?.[1]
  assert.equal(backendId, "tesseract")
  globalThis.__ocrAuditPlatform = "headless"
  globalThis.__ocrAuditBackends = [backendId]
  try {
    const status = src.createOcrRuntimeStatusResolver(settings(), async () => ({ secrets: {} }))
    const actual = await status(provider("tesseract-native", "local"), "headless")
    assert.equal(actual.ready, false)
    assert.equal(actual.reason, "backend-not-bound")
    const control = await status(provider(backendId, "local"), "headless")
    assert.equal(control.ready, true)
    record("F8", {
      rustBackendId: backendId,
      providerId: actual.providerId,
      status: actual.reason,
      matchingIdControlReady: control.ready,
    })
  } finally {
    delete globalThis.__ocrAuditPlatform
    delete globalThis.__ocrAuditBackends
  }
})

test("F9: OCR opt-out manifest filter retains the screenshot plugin OCR entry", async () => {
  const source = await readFile(path.join(root, "lib/claude/build-options.ts"), "utf8")
  const filter = /if \(!ocrAllowedForChat\) \{\s*manifest = manifest\.filter\([^\n]+\)\s*\}/.exec(
    source
  )?.[0]
  assert.ok(filter, "Source filter changed; reassess this characterization")
  const allowed = src.isOcrToolAllowed({ character: { enableOcr: false } })
  assert.equal(allowed, false)
  // Execute the source's exact isolated filter, not a reimplementation. This
  // proves the filter's scope; it is not a full resolveSendOptions/device run.
  const applyFilter = new Function("manifest", "ocrAllowedForChat", `${filter}\nreturn manifest`)
  const kept = applyFilter(
    [
      { pluginId: "cognia-ocr", name: "ocr.extract" },
      { pluginId: "cognia-screenshot", name: "extract_screenshot_ocr" },
    ],
    allowed
  )
  assert.deepEqual(
    kept.map((t) => t.name),
    ["extract_screenshot_ocr"]
  )
  record("F9", {
    enableOcr: false,
    kept: kept.map((t) => t.name),
    scope: "isolated production source filter; capture permissions remain separate",
  })
})

test("F10: Reply Copilot escalates a local-only screen read to cloud OCR", async () => {
  const registry = src.getSharedOcrRegistry()
  const requests = []
  registry.clear()
  registry.register(
    provider("tesseract-wasm", "local", async () => ({
      ...result("tesseract-wasm"),
      pages: [
        {
          pageNumber: 1,
          text: "fixture",
          markdown: "fixture",
          blocks: [{ text: "fixture", confidence: 0.2, bbox: { x: 1, y: 1, width: 5, height: 5 } }],
        },
      ],
    }))
  )
  registry.register(
    src.buildMistralOcrProvider({
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body).document)
        return Response.json({ pages: [{ index: 0, markdown: "cloud fixture" }] })
      },
    })
  )
  globalThis.__ocrAuditSecrets = { apiKey: "fixture" }
  globalThis.__ocrAuditSettings = settings({
    confidenceEscalation: "escalate",
    cloudFallbackEnabled: false,
    providerEnabled: { "mistral-ocr": false },
  })
  try {
    const shot = { bytes: "YWJj", format: "png", width: 100, height: 100 }
    const out = await src.readWindowText(shot)
    assert.equal(out.providerId, "mistral-ocr")
    assert.deepEqual(requests, [{ type: "image_url", image_url: "data:image/png;base64,YWJj" }])
    globalThis.__ocrAuditSettings.confidenceEscalation = "off"
    assert.equal((await src.readWindowText(shot)).providerId, "tesseract-wasm")
    assert.equal(requests.length, 1)
    record("F10", { cloudRequestBodies: requests.length, controlProvider: "tesseract-wasm" })
  } finally {
    registry.clear()
    delete globalThis.__ocrAuditSecrets
    delete globalThis.__ocrAuditSettings
  }
})

test("F11: inbound eager OCR runs independently of the IM tool opt-out", async () => {
  const bus = await readFile(path.join(root, "lib/connectors/bus.ts"), "utf8")
  const eager =
    /if \(hasOcrableInboundImage\(event\.segments\)\) \{\s*await runInboundOcr\(event\)\.catch\(\(\) => undefined\)\s*\}/.exec(
      bus
    )
  assert.ok(eager, "Eager OCR branch changed; reassess this characterization")
  assert.ok(eager.index < bus.indexOf("// ── Step 2: adapter instance lookup", eager.index))
  const runEager = new Function(
    "event",
    "hasOcrableInboundImage",
    "runInboundOcr",
    `return (async () => {${eager[0]}})()`
  )
  assert.equal(src.isOcrToolAllowed({ imSession: true, allowOcrOverride: false }), false)
  const registry = src.getSharedOcrRegistry()
  registry.clear()
  registry.register(provider("tesseract-wasm", "local"))
  globalThis.__ocrAuditSettings = settings({ ocrInboundImages: true })
  const event = () => ({ segments: [{ type: "image", dataBase64: "YWJj", mimeType: "image/png" }] })
  try {
    const inline = event()
    await runEager(inline, src.hasOcrableInboundImage, src.runInboundOcr)
    assert.equal(inline.segments[0].ocrText, "tesseract-wasm")
    globalThis.__ocrAuditSettings.ocrInboundImages = false
    const control = event()
    await runEager(control, src.hasOcrableInboundImage, src.runInboundOcr)
    assert.equal(control.segments[0].ocrText, undefined)
    record("F11", {
      imToolAllowed: false,
      eagerOcrText: inline.segments[0].ocrText,
      globalOffControl: "skipped",
    })
  } finally {
    registry.clear()
    delete globalThis.__ocrAuditSettings
  }
})

test("F12: sidecar file verdict and OCR reader do not use the same path", async () => {
  const workspace = path.join(scratch, "workspace")
  const outside = path.join(scratch, "outside")
  const credentialPath = path.join(outside, ".netrc")
  const policy = { enabled: true, roots: [workspace] }
  const tool = "mcp__cognia-plugin-tools__ocr.extract"
  const access = src.buildPluginAccessMap([
    { name: "ocr.extract", access: "read", pathParams: ["path"] },
  ])
  const verdict = (file) =>
    src.classifyToolCallConfinement(policy, tool, { path: file }, workspace, access)
  assert.equal(verdict(path.join(outside, "scan.png")), null)
  assert.equal(verdict(credentialPath), "deny")
  const modelPath = `${credentialPath} `
  assert.equal(verdict(modelPath), null)
  let requestedRead
  const out = await src.runOcrTool(
    { path: modelPath },
    {
      runtime: {
        isReady: () => true,
        extractFile: async (file) => {
          requestedRead = file
          return result("fixture")
        },
      },
    }
  )
  assert.equal(out.ok, true)
  assert.equal(requestedRead, credentialPath)
  record("F12", {
    outsideReadRestriction: null,
    exactCredentialVerdict: "deny",
    paddedCredentialVerdict: null,
    requestedTrimmedPath: true,
  })
})

test("F13: registered OCR executor drops the attempt abort signal", async () => {
  const entered = Promise.withResolvers()
  const reply = Promise.withResolvers()
  let tool
  const cloud = src.buildMistralOcrProvider({
    fetchImpl: async (_url, options) => {
      entered.resolve(options.signal)
      await reply.promise
      return Response.json({ pages: [{ index: 0, markdown: "fixture" }] })
    },
  })
  const d = deps([cloud], settings(), {
    credentialsResolver: async () => ({ secrets: { apiKey: "fixture" } }),
  })
  await src.ocrPluginDefinition.activate({
    logger: { info() {} },
    agent: {
      registerTool(value) {
        tool = value
      },
    },
    messagePart: { registerPartRenderer() {} },
    ocr: { isReady: () => true, extract: (input) => src.extract(input, d) },
  })
  const controller = new AbortController()
  const pending = tool.execute(
    { source: { kind: "data_url", value: image.source.dataUrl }, provider: cloud.id },
    { signal: controller.signal }
  )
  const requestSignal = await entered.promise
  controller.abort()
  reply.resolve()
  assert.equal(requestSignal, undefined)
  assert.equal((await pending).ok, true)
  record("F13", { executorAborted: true, providerGotSignal: false, underlyingCompleted: true })
})

test("F15: a cache write failure after local OCR triggers a cloud call", async () => {
  let localCalls = 0
  let cloudCalls = 0
  const local = provider("tesseract-wasm", "local", async () => {
    localCalls++
    return result("tesseract-wasm")
  })
  const cloud = provider("mistral-ocr", "document-cloud", async () => {
    cloudCalls++
    return result("mistral-ocr")
  })
  const d = deps([local, cloud], settings(), {
    cache: {
      read: async () => null,
      write: async ({ providerId }) => {
        if (providerId === local.id) throw Error("fixture cache write failed")
      },
    },
  })
  assert.equal((await src.extract(image, d)).providerId, cloud.id)
  assert.equal(localCalls, 1)
  assert.equal(cloudCalls, 1)
  assert.equal((await src.extract({ ...image, useCache: false }, d)).providerId, local.id)
  assert.equal(localCalls, 2)
  assert.equal(cloudCalls, 1)
  record("F15", { localCalls, cloudCalls, noCacheControlProvider: local.id })
})

test("F16: slash text format returns Markdown despite distinct plain text", async () => {
  const fixture = provider("fixture", "local", async () => ({
    ...result("fixture", "plain text"),
    combinedMarkdown: "**plain text**",
  }))
  const d = deps([fixture], settings({ defaultProviderId: fixture.id }), {
    filePathResolver: async () => ({
      blob: new Blob(["fixture"], { type: "image/png" }),
      mimeType: "image/png",
    }),
  })
  const run = (format) =>
    src.handleOcrSlashCommand({
      argv: `fixture.png --format ${format}`,
      deps: d,
      extract: src.extract,
    })
  const plain = await run("text")
  const markdown = await run("markdown")
  assert.equal(plain.result.combinedText, "plain text")
  assert.equal(plain.composerText, "**plain text**")
  assert.equal(plain.system, markdown.system)
  record("F16", { textFormatOutput: plain.composerText, formatsReturnSameSystemText: true })
})
