/**
 * Read-only audit probes of current behavior, including defects.
 * Uses actual source functions with synthetic values and injected network I/O.
 * Run: node docs/evidence/2026-11-14-provider-configuration-mode-audit.probes.mjs
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { buildSync, transformSync } from "esbuild"

const root = process.cwd()
const output = resolve(root, ".cache/provider-configuration-mode-audit")
mkdirSync(output, { recursive: true })
const bundle = resolve(output, "provider-core.cjs")
buildSync({
  stdin: {
    contents: `
      export * from "./packages/provider-core/src/providers/runtime-adapters";
      export * from "./packages/provider-core/src/providers/api-test";
      export * from "./packages/provider-core/src/providers/completeness";
      export * from "./packages/provider-core/src/providers/model-discovery";
      export * from "./packages/provider-core/src/providers/local-provider-service";
      export * from "./packages/provider-types/src/profile-migration";
      export * from "./packages/provider-types/src/built-in-provider-catalog";
    `,
    resolveDir: root,
    loader: "ts",
    sourcefile: "provider-mode-audit.ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundle,
  logLevel: "silent",
})
const api = createRequire(import.meta.url)(bundle)
const observations = []
let requests = []
let statusCode = 200
api.setProviderCoreRuntimeAdapters({
  isTauri: () => false,
  proxyFetch: async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET", headers: init.headers })
    return new Response(JSON.stringify({ data: [{ id: "synthetic-model" }] }), {
      status: statusCode,
      headers: { "content-type": "application/json" },
    })
  },
})

async function check(id, run) {
  requests = []
  statusCode = 200
  const detail = await run()
  observations.push({ id, reproduced: true, ...detail })
}

await check("google-probe-ignores-endpoint-and-headers", async () => {
  const result = await api.probeProviderConnection({
    providerId: "google",
    apiKey: "synthetic-key",
    baseURL: "https://synthetic-gateway.invalid/v1beta",
    customHeaders: { "X-Synthetic-Tenant": "tenant-a" },
  })
  assert.equal(result.success, true)
  assert.ok(requests[0].url.startsWith("https://generativelanguage.googleapis.com/"))
  assert.equal(new Headers(requests[0].headers).get("X-Synthetic-Tenant"), null)
  return { configuredOrigin: "https://synthetic-gateway.invalid", request: requests[0] }
})

await check("openai-probe-ignores-protocol-and-headers", async () => {
  await api.probeProviderConnection({
    providerId: "openai",
    apiKey: "synthetic-key",
    baseURL: "https://synthetic-gateway.invalid/v1",
    protocol: "anthropic",
    model: "synthetic-model",
    customHeaders: { "X-Synthetic-Tenant": "tenant-a" },
  })
  assert.equal(requests[0].method, "GET")
  assert.equal(requests[0].url, "https://synthetic-gateway.invalid/v1/models")
  assert.equal(new Headers(requests[0].headers).get("X-Synthetic-Tenant"), null)
  return { configuredProtocol: "anthropic", request: requests[0] }
})

await check("anthropic-wire-http-400-counts-as-authoritative-verification", async () => {
  statusCode = 400
  const result = await api.probeProviderConnection({
    providerId: "synthetic-custom",
    protocol: "anthropic",
    baseURL: "https://synthetic-gateway.invalid/v1",
    apiKey: "synthetic-key",
    model: "rejected-model",
  })
  assert.equal(result.success, true)
  assert.equal(result.outcome, "verified")
  assert.equal(result.authoritative, true)
  return { simulatedStatus: 400, result }
})

await check("api-flavor-change-retains-verified-state", () => {
  const previous = {
    enabled: true,
    apiKey: "synthetic-key",
    baseURL: "https://synthetic-gateway.invalid/v1",
    defaultModel: "synthetic-model",
    apiFlavor: "chat",
  }
  const fingerprint = api.buildProviderVerificationFingerprint(previous)
  const next = { ...previous, apiFlavor: "responses" }
  assert.equal(api.buildProviderVerificationFingerprint(next), fingerprint)
  const result = api.evaluateBuiltInProviderCompleteness("openai", {
    ...next,
    verificationStatus: "verified",
    verificationFingerprint: fingerprint,
  })
  assert.equal(result.verificationStatus, "verified")
  // Positive control: the same implementation DOES invalidate a changed endpoint.
  const control = api.evaluateBuiltInProviderCompleteness("openai", {
    ...next,
    baseURL: "https://changed.invalid/v1",
    verificationStatus: "verified",
    verificationFingerprint: fingerprint,
  })
  assert.equal(control.verificationStatus, "stale")
  return {
    afterFlavorChange: result.verificationStatus,
    afterEndpointChange: control.verificationStatus,
  }
})

await check("bedrock-region-and-credential-change-retain-verification-fingerprint", () => {
  const previous = {
    defaultModel: "synthetic-model",
    bedrock: {
      authMode: "iam",
      region: "us-east-1",
      accessKeyId: "synthetic-access",
      secretAccessKey: "synthetic-old",
    },
  }
  const next = {
    ...previous,
    bedrock: { ...previous.bedrock, region: "eu-west-1", secretAccessKey: "synthetic-new" },
  }
  assert.equal(
    api.buildProviderVerificationFingerprint(previous),
    api.buildProviderVerificationFingerprint(next)
  )
  return { regionChanged: true, nestedCredentialChanged: true, fingerprintChanged: false }
})

await check("keyless-custom-provider-is-blocked-by-settings-guards", () => {
  const custom = {
    id: "synthetic-local",
    enabled: true,
    apiKey: "",
    baseURL: "http://synthetic-engine.invalid:8000/v1",
    defaultModel: "synthetic-model",
  }
  const result = api.evaluateCustomProviderCompleteness(custom)
  assert.equal(result.eligibility.enable.code, "missing_credential")
  assert.equal(result.eligibility.testConnection.code, "missing_credential")
  assert.equal(result.eligibility.runtime.code, "missing_credential")
  const dialog = readFileSync(
    resolve(root, "components/settings/provider/custom-provider-dialog.tsx"),
    "utf8"
  )
  assert.ok(dialog.includes('t("apiKeyOptional")'))
  assert.ok(dialog.includes("const canSave = !!name.trim() && canTest"))
  const local = api.evaluateBuiltInProviderCompleteness("ollama", { enabled: true })
  assert.equal(local.eligibility.runtime.allowed, true)
  return {
    optionalKeyInDialog: true,
    customGuard: result.eligibility.runtime,
    builtInLocalAllowed: true,
  }
})

await check("local-verification-without-fingerprint-never-becomes-stale", () => {
  const result = api.evaluateBuiltInProviderCompleteness("ollama", {
    enabled: true,
    baseURL: "http://different-engine.invalid:11434",
    verificationStatus: "verified",
  })
  assert.equal(result.verificationStatus, "verified")
  const localUi = readFileSync(
    resolve(root, "components/settings/provider/local-provider-settings.tsx"),
    "utf8"
  )
  assert.ok(localUi.includes('verificationStatus: "verified"'))
  assert.equal(localUi.includes("verificationFingerprint"), false)
  return { endpointChanged: true, missingFingerprintAcceptedAs: result.verificationStatus }
})

await check("authenticated-local-discovery-drops-credentials", async () => {
  api.setProviderCoreRuntimeAdapters({
    proxyFetch: async (url, init = {}) => {
      const headers = new Headers(init.headers)
      const authenticated =
        headers.get("Authorization") === "Bearer synthetic-key" &&
        headers.get("X-Synthetic-Tenant") === "tenant-a"
      requests.push({ url: String(url), authenticated })
      return new Response(JSON.stringify({ data: [{ id: "synthetic-model" }] }), {
        status: authenticated ? 200 : 401,
      })
    },
  })
  const url = "https://synthetic-engine.invalid/v1"
  const control = await api
    .createLocalProviderService("lmstudio", {
      baseUrl: url,
      apiKey: "synthetic-key",
      customHeaders: { "X-Synthetic-Tenant": "tenant-a" },
    })
    .listModels()
  assert.equal(control[0].id, "synthetic-model")
  await assert.rejects(api.discoverLocalProviderModels("lmstudio", url), /Authentication failed/)
  assert.equal(requests[0].authenticated, true)
  assert.equal(requests[1].authenticated, false)
  return { requests }
})

await check("profile-projection-drops-settings-protocol-and-custom-models", () => {
  const derived = api.deriveProfiles({
    catalog: api.getBuiltInProviderCatalog(),
    providerSettings: {
      openai: {
        enabled: true,
        apiProtocol: "anthropic",
        baseURL: "https://synthetic-gateway.invalid/v1",
      },
    },
    customProviders: [
      {
        id: "synthetic-custom",
        name: "Old gateway name",
        customName: "Synthetic gateway",
        apiProtocol: "anthropic",
        models: ["old-model"],
        customModels: ["model-a", "model-b"],
        defaultModel: "model-a",
        baseURL: "https://synthetic-gateway.invalid/v1",
      },
    ],
  })
  const transportFor = (id) => {
    const deployment = derived.deploymentProfiles.find((entry) => entry.id === id)
    return derived.transportProfiles.find((entry) => entry.id === deployment.transportProfileRef)
  }
  assert.equal(transportFor("openai").protocol, "openai")
  assert.equal(transportFor("synthetic-custom").protocol, "openai")
  const custom = derived.deploymentProfiles.find((entry) => entry.id === "synthetic-custom")
  assert.deepEqual(
    custom.models.map((model) => model.id),
    ["model-a", "old-model"]
  )
  assert.equal(
    derived.providerProfiles.find((entry) => entry.id === "synthetic-custom").displayName,
    "Old gateway name"
  )
  const sync = readFileSync(resolve(root, "lib/settings/provider-profile-sync.ts"), "utf8")
  assert.ok(sync.includes("customProviders: settings.customProviders as LegacyCustomProviderRow[]"))
  return {
    configuredProtocol: "anthropic",
    derivedBuiltInProtocol: transportFor("openai").protocol,
    derivedCustomProtocol: transportFor("synthetic-custom").protocol,
    configuredCustomModels: ["model-a", "model-b"],
    derivedCustomModels: custom.models.map((model) => model.id),
  }
})

await check("derived-google-auth-overrides-correct-gateway-auth", () => {
  const derived = api.deriveProfiles({
    catalog: api.getBuiltInProviderCatalog(),
    providerSettings: { google: { enabled: true, defaultModel: "synthetic-model" } },
  })
  const deployment = derived.deploymentProfiles.find((entry) => entry.id === "google")
  const transport = derived.transportProfiles.find(
    (entry) => entry.id === deployment.transportProfileRef
  )
  assert.equal(transport.auth.scheme, "bearer")
  // Execute the actual snapshot merge. Inject a correct provider snapshot and
  // the profile transport that loadSnapshotProfileMeta maps from the database.
  // Only unrelated routing dependencies are stubbed; no network or real DB.
  const source = readFileSync(resolve(root, "lib/gateway/snapshot-publisher.ts"), "utf8")
  const start = source.indexOf("export function buildGatewaySnapshot(")
  const end = source.indexOf("\n/**", start)
  assert.ok(start >= 0 && end > start, "Snapshot function boundary drifted")
  const js = transformSync(source.slice(start, end).replace("export function", "function"), {
    loader: "ts",
  }).code
  const baseline = {
    id: "google",
    protocol: "google",
    transport: { authScheme: "custom-header", authHeaderName: "x-goog-api-key" },
  }
  const merge = new Function(
    "buildProviders",
    "buildAliases",
    "getProviderRoutingRuntimeAdapters",
    "routerFusionSwitchesOf",
    `${js}\nreturn buildGatewaySnapshot`
  )(
    () => [baseline],
    () => [],
    () => ({}),
    () => ({})
  )
  const withoutProjection = merge({}, 1).providers[0]
  const withProjection = merge({}, 1, {
    profileVersion: 1,
    byLegacyId: {
      google: { deploymentId: "google", transport: { authScheme: transport.auth.scheme } },
    },
  }).providers[0]
  assert.equal(withoutProjection.transport.authHeaderName, "x-goog-api-key")
  assert.equal(withProjection.protocol, "google")
  assert.deepEqual(withProjection.transport, { authScheme: "bearer" })
  return {
    beforeProfileOverlay: withoutProjection.transport,
    afterProfileOverlay: withProjection.transport,
  }
})

await check("ancient-provider-discovery-is-still-labelled-fresh", () => {
  const snapshot = api.buildBuiltInProviderModelDiscoverySnapshot({
    providerId: "synthetic-provider",
    settings: {
      discoveredModels: [{ id: "old-account-model" }],
      discoveredModelsLastFetched: 1,
    },
  })
  assert.equal(snapshot.models[0].freshness, "fresh")
  return { fetchedAtMs: 1, freshness: snapshot.models[0].freshness, hasExpiryOrAccountInput: false }
})

const sourcePaths = [
  "packages/provider-core/src/providers/api-test.ts",
  "packages/provider-core/src/providers/completeness.ts",
  "packages/provider-core/src/providers/model-discovery.ts",
  "packages/provider-core/src/providers/local-provider-service.ts",
  "packages/provider-types/src/profile-migration.ts",
  "lib/settings/provider-profile-sync.ts",
  "lib/gateway/snapshot-publisher.ts",
  "components/settings/provider/local-provider-settings.tsx",
  "components/settings/provider/custom-provider-dialog.tsx",
]
const result = {
  scope:
    "Actual source functions with synthetic values and injected I/O; no live provider, real user database, browser or native Host",
  sourceHashes: Object.fromEntries(
    sourcePaths.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(resolve(root, path)))
        .digest("hex"),
    ])
  ),
  probes: observations.length,
  reproduced: observations.length,
  observations,
}
writeFileSync(resolve(output, "core-probe-results.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result, null, 2))
