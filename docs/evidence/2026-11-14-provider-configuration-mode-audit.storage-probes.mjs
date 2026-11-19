// Read-only production-source probes. All credentials below are synthetic.
// Run from the repository root with:
//   node docs/evidence/2026-11-14-provider-configuration-mode-audit.storage-probes.mjs
// These assert the observed gaps, not desired product acceptance. Integration
// seams are injected; no browser, OS keyring, account or provider is contacted.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
// The docs workspace may install a different TypeScript CLI package. Resolve
// the compiler API used by the application from the repository root.
const require = createRequire(path.join(root, "package.json"))
const ts = require("typescript")
const outputDir = path.join(root, ".cache/provider-configuration-mode-audit")
const loaded = new Map()
const probes = []

async function source(relativePath) {
  if (loaded.has(relativePath)) return loaded.get(relativePath)
  const text = await readFile(path.join(root, relativePath), "utf8")
  const ast = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true)
  assert.equal(ast.parseDiagnostics.length, 0, `${relativePath}: parse drift`)
  const result = { relativePath, text, ast }
  loaded.set(relativePath, result)
  return result
}

function oneNode(file, predicate, description) {
  const found = []
  const visit = (node) => {
    if (predicate(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file.ast)
  assert.equal(found.length, 1, `${file.relativePath}: expected one ${description}`)
  return found[0]
}

function variable(file, name) {
  return oneNode(
    file,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(file.ast) === name,
    name
  )
}

function ref(file, node) {
  return `${file.relativePath}:${file.ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
}

function runTs(text, globals = {}, imports = {}) {
  const exports = {}
  const code = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const context = vm.createContext({
    exports,
    URL,
    console,
    ...globals,
    require(id) {
      assert(Object.hasOwn(imports, id), `unexpected import: ${id}`)
      return imports[id]
    },
  })
  vm.runInContext(code, context)
  return { exports, context }
}

function observe(id, refs, result, scope) {
  probes.push({ id, refs, result, scope, status: "reproduced" })
}

const completenessFile = await source("packages/provider-core/src/providers/completeness.ts")
const completeness = runTs(
  completenessFile.text,
  {},
  {
    "@cognia/provider-types": {},
    "@cognia/provider-types/built-in-provider-catalog": {},
    "./provider-adapters": {},
  }
).exports

const settingsFile = await source("lib/db/settings.ts")
const defaultsNode = variable(settingsFile, "DEFAULTS").initializer
assert(ts.isObjectLiteralExpression(defaultsNode))
const appearanceFile = await source("packages/plugin-contract/src/types/appearance/index.ts")
const appearanceNode = variable(appearanceFile, "DEFAULT_APPEARANCE_SLICE").initializer
assert(ts.isObjectLiteralExpression(appearanceNode))
assert(!appearanceNode.properties.some(ts.isSpreadAssignment), "appearance spread drift")
const defaultKeys = []
for (const prop of defaultsNode.properties) {
  if (ts.isSpreadAssignment(prop)) {
    assert.equal(
      prop.expression.getText(settingsFile.ast),
      "omitAgentFlowMode(DEFAULT_APPEARANCE_SLICE)"
    )
    defaultKeys.push(
      ...appearanceNode.properties.map((entry) => entry.name.getText(appearanceFile.ast))
    )
  } else {
    assert(prop.name, "default property drift")
    defaultKeys.push(prop.name.getText(settingsFile.ast))
  }
}
assert(!defaultKeys.includes("providerSettings"))
assert(!defaultKeys.includes("customProviders"))
const defaultsKeyShape = Object.fromEntries(defaultKeys.map((key) => [key, undefined]))
const transferFile = await source("lib/settings/profile-transfer.ts")
const transfer = runTs(
  transferFile.text,
  {},
  {
    "@/lib/db/settings": { DEFAULTS: defaultsKeyShape },
  }
).exports

const fingerprint = completeness.buildProviderVerificationFingerprint({
  apiKey: "synthetic-api-key",
  apiKeys: ["synthetic-rotated-key"],
  baseURL: "https://provider.example/v1",
  defaultModel: "synthetic-model",
  customHeaders: { "X-Synthetic": "synthetic-header" },
})
assert.equal(JSON.parse(fingerprint).apiKey, "synthetic-api-key")
const providerSettings = {
  openrouter: {
    providerId: "openrouter",
    enabled: true,
    apiKey: "synthetic-api-key",
    apiKeys: ["synthetic-rotated-key"],
    oauthRefreshToken: "synthetic-refresh-token",
    verificationFingerprint: fingerprint,
    openRouterSettings: {
      provisioningApiKey: "synthetic-provisioning-key",
      byokKeys: [{ id: "synthetic-byok", config: '{"api_key":"synthetic-byok-key"}' }],
    },
    cliProxyAPISettings: { managementKey: "synthetic-management-key" },
    bedrock: { secretAccessKey: "synthetic-aws-secret", sessionToken: "synthetic-aws-session" },
  },
}

const exportFile = await source("components/settings/provider/provider-import-export.tsx")
const exportNode = variable(exportFile, "handleExport")
let downloaded = ""
runTs(`const handleExport = ${exportNode.initializer.getText(exportFile.ast)}; handleExport();`, {
  selectedProviders: ["openrouter"],
  providerSettings,
  customProviders: {},
  includeApiKeys: false,
  exportFormat: "json",
  Blob: class {
    constructor(parts) {
      downloaded = parts.join("")
    }
  },
  URL: { createObjectURL: () => "blob:synthetic", revokeObjectURL() {} },
  document: { createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } },
  setExportDialogOpen() {},
  onClose: undefined,
})
const exportedProvider = JSON.parse(downloaded).providerSettings.openrouter
assert.equal(exportedProvider.apiKey, undefined)
assert.equal(exportedProvider.apiKeys, undefined)
assert.equal(exportedProvider.oauthRefreshToken, "synthetic-refresh-token")
assert.equal(exportedProvider.openRouterSettings.provisioningApiKey, "synthetic-provisioning-key")
assert.equal(exportedProvider.bedrock.secretAccessKey, "synthetic-aws-secret")
assert.equal(JSON.parse(exportedProvider.verificationFingerprint).apiKey, "synthetic-api-key")
observe(
  "provider-export-default-leaks-secondary-credentials",
  [ref(exportFile, exportNode)],
  {
    apiKeyRemoved: true,
    apiKeysRemoved: true,
    leakedFields: [
      "oauthRefreshToken",
      "openRouterSettings.provisioningApiKey",
      "openRouterSettings.byokKeys[].config",
      "cliProxyAPISettings.managementKey",
      "bedrock.secretAccessKey",
      "bedrock.sessionToken",
      "verificationFingerprint",
    ],
  },
  "Actual handleExport AST; fake download DOM; synthetic settings; no rendered UI."
)

const customRoundtrip = {
  id: "custom-roundtrip",
  providerId: "custom-roundtrip",
  customName: "Synthetic roundtrip gateway",
  enabled: true,
  baseURL: "https://roundtrip.example/v1",
  apiKey: "synthetic-roundtrip-key",
  apiProtocol: "openai",
  apiFlavor: "responses",
  customHeaders: { "X-Tenant": "synthetic-import-tenant" },
  customModels: ["synthetic-import-model"],
  defaultModel: "synthetic-import-model",
  enabledModels: ["synthetic-import-model"],
  inferenceDefaults: { temperature: 0.2 },
  customModelMetadata: { "synthetic-import-model": { contextLength: 12345 } },
}
let customDownload = ""
runTs(`const handleExport = ${exportNode.initializer.getText(exportFile.ast)}; handleExport();`, {
  selectedProviders: [customRoundtrip.id],
  providerSettings: {},
  customProviders: { [customRoundtrip.id]: customRoundtrip },
  includeApiKeys: true,
  exportFormat: "json",
  Blob: class {
    constructor(parts) {
      customDownload = parts.join("")
    }
  },
  URL: { createObjectURL: () => "blob:synthetic", revokeObjectURL() {} },
  document: { createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } },
  setExportDialogOpen() {},
  onClose: undefined,
})
const customImportData = JSON.parse(customDownload)
assert.equal(customImportData.customProviders[customRoundtrip.id].apiFlavor, "responses")
assert.equal(
  customImportData.customProviders[customRoundtrip.id].customHeaders["X-Tenant"],
  "synthetic-import-tenant"
)
const importNode = variable(exportFile, "handleImport")
const importHelpers = ["isRecord", "validateImportData"]
  .map((name) =>
    oneNode(
      exportFile,
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
      name
    ).getText(exportFile.ast)
  )
  .join("\n")
const roundtripResults = {}
for (const existing of [false, true]) {
  let importedCustom
  let importSuccess = false
  let importError = null
  const previousCustom = {
    ...customRoundtrip,
    customHeaders: { "X-Tenant": "synthetic-old-tenant" },
    apiFlavor: "chat",
    inferenceDefaults: { temperature: 0.9 },
  }
  const imports = runTs(
    `${importHelpers}\nexports.handleImport = ${importNode.initializer.getText(exportFile.ast)};`,
    {
      importData: customImportData,
      importConflicts: existing ? [{ id: customRoundtrip.id }] : [],
      importResolution: "overwrite",
      providerSettings: {},
      customProviders: existing ? { [customRoundtrip.id]: previousCustom } : {},
      setIsImporting() {},
      setImportError: (value) => {
        importError = value
      },
      setImportSuccess: (value) => {
        importSuccess = value
      },
      translateImportError: (key) => key,
      t: (key) => key,
      setProviderSettings: async () => {
        throw Error("unexpected built-in import")
      },
      addCustomProvider: async (value) => {
        importedCustom = value
      },
      updateCustomProvider: async (id, patch) => {
        importedCustom = { ...previousCustom, ...patch }
      },
      setTimeout() {},
    }
  ).exports
  await imports.handleImport()
  assert.equal(importError, null)
  assert.equal(importSuccess, true)
  assert.equal(importedCustom.apiKey, "synthetic-roundtrip-key")
  assert.equal(importedCustom.baseURL, customRoundtrip.baseURL)
  assert.equal(importedCustom.defaultModel, customRoundtrip.defaultModel)
  assert.equal(importedCustom.apiFlavor, existing ? "chat" : undefined)
  assert.equal(
    importedCustom.customHeaders?.["X-Tenant"],
    existing ? "synthetic-old-tenant" : undefined
  )
  assert.equal(importedCustom.inferenceDefaults?.temperature, existing ? 0.9 : undefined)
  roundtripResults[existing ? "overwriteExisting" : "createNew"] = {
    retainedSourceFields: [
      "apiKey",
      "baseURL",
      "defaultModel",
      "apiProtocol",
      "customModels",
      "customName",
      "enabled",
    ],
    sourceApiFlavorApplied: false,
    sourceCustomHeadersApplied: false,
    sourceInferenceDefaultsApplied: false,
    actualApiFlavor: importedCustom.apiFlavor ?? null,
    actualTenantHeader: importedCustom.customHeaders?.["X-Tenant"] ?? null,
  }
}
observe(
  "custom-provider-json-roundtrip-drops-transport-and-model-configuration",
  [
    ref(exportFile, importNode),
    "components/settings/provider/provider-import-export.tsx:556",
    "stores/settings/settings-store.ts:1753",
  ],
  roundtripResults,
  "Actual handleExport and handleImport AST plus actual import validation; includeApiKeys=true. Mutation boundaries captured. Existing-update object-spread semantics match the store source; no full store, database, or UI executed."
)

const profile = transfer.exportSettingsProfile(
  {
    id: "singleton",
    theme: "dark",
    providerSettings,
    customProviders: [{ id: "custom-synthetic", apiKey: "synthetic-custom-key" }],
  },
  "2026-11-14T00:00:00.000Z"
)
const strippedProvider = profile.settings.providerSettings.openrouter
assert.equal(strippedProvider.apiKey, undefined)
assert.equal(strippedProvider.oauthRefreshToken, undefined)
assert.equal(strippedProvider.bedrock.secretAccessKey, undefined)
assert.equal(JSON.parse(strippedProvider.verificationFingerprint).apiKey, "synthetic-api-key")
assert.equal(strippedProvider.cliProxyAPISettings.managementKey, "synthetic-management-key")
assert(strippedProvider.openRouterSettings.byokKeys[0].config.includes("synthetic-byok-key"))
observe(
  "profile-and-backup-scrubber-leaks-opaque-credentials",
  [
    "lib/settings/profile-transfer.ts:47",
    "lib/settings/profile-transfer.ts:81",
    "packages/provider-core/src/providers/completeness.ts:221",
    "lib/data/build-package.ts:223",
    "lib/data/build-stream.ts:108",
  ],
  {
    primaryKeyRemoved: true,
    refreshAndAwsSecretsRemoved: true,
    plaintextFingerprintSurvives: true,
    managementKeySurvives: true,
    byokConfigSurvives: true,
  },
  "Actual profile-transfer module; DEFAULTS keys extracted from owning AST plus appearance spread. Backup callers share this scrubber; no full backup executed."
)

const Dexie = require("dexie").default
const { indexedDB, IDBKeyRange } = require("fake-indexeddb")
const storageFixture = new Dexie("synthetic-provider-configuration-audit", {
  indexedDB,
  IDBKeyRange,
})
storageFixture.version(1).stores({ settings: "id" })
const protection = JSON.parse(
  await readFile(path.join(root, "lib/data-governance/content-protection-baseline.json"), "utf8")
)
assert.equal(protection.settings, "metadata-only", "settings content protection drift")
const catalogFile = await source("lib/data-governance/table-catalog.ts")
const tablePolicy = runTs(
  catalogFile.text,
  {},
  {
    "@/lib/modules/generated/host": { HOST_MODULES: [] },
  }
).exports
assert.equal(tablePolicy.policyForTable("settings").contentProtection, "metadata-only")
const middlewareFile = await source("lib/db/encrypted-content-middleware.ts")
const middleware = runTs(
  middlewareFile.text,
  {},
  {
    dexie: { default: Dexie },
    "@/lib/accounts/content-cipher": {
      getActiveAccountContentCipher: () => {
        throw Error("settings unexpectedly requested a cipher")
      },
    },
    "@/lib/data-governance/table-catalog": { policyForTable: tablePolicy.policyForTable },
  }
).exports
const originalSettingsTable = { name: "synthetic-settings-table" }
const wrappedDbCore = middleware
  .createEncryptedContentMiddleware("cognia-account-synthetic-encrypted-v1")
  .create({
    table: () => originalSettingsTable,
  })
assert.equal(wrappedDbCore.table("settings"), originalSettingsTable)
observe(
  "account-content-middleware-does-not-wrap-settings",
  [
    "lib/db/encrypted-content-middleware.ts:31",
    "lib/db/schema.ts:1712",
    "lib/data-governance/table-catalog.ts:2153",
  ],
  {
    settingsPolicy: "metadata-only",
    originalUnencryptedTableReturned: true,
    cipherRequested: false,
  },
  "Actual table-catalog module and createEncryptedContentMiddleware; generated module ownership manifests injected empty (ownership does not determine settings protection). DBCore table sentinel injected; no real account or database read."
)
const saveNode = oneNode(
  settingsFile,
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "saveSettings",
  "saveSettings implementation"
)
try {
  await storageFixture.settings.put({ id: "singleton", theme: "dark" })
  const dbSettings = runTs(
    `let saveQueue = Promise.resolve(); ${saveNode.getText(settingsFile.ast)}`,
    {
      SINGLETON_ID: "singleton",
      getDb: () => storageFixture,
      getSettings: async () => storageFixture.settings.get("singleton"),
      withDbReopenRetry: (callback) => callback(),
      migrateLegacyDefaultAccount() {},
      resolveLocalePreference: () => ({}),
    },
    {
      "@/lib/settings/provider-profile-sync": {
        syncProviderProfilesFromSettings: async () => null,
      },
    }
  ).exports
  await dbSettings.saveSettings({ providerSettings }, { mirrorToHost: false })
  const rawRow = await new Promise((resolve, reject) => {
    const request = storageFixture
      .backendDB()
      .transaction("settings", "readonly")
      .objectStore("settings")
      .get("singleton")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  assert.equal(rawRow.providerSettings.openrouter.apiKey, "synthetic-api-key")
  assert.equal(
    JSON.parse(rawRow.providerSettings.openrouter.verificationFingerprint).apiKey,
    "synthetic-api-key"
  )
  observe(
    "provider-key-and-fingerprint-reach-raw-settings-row",
    [
      ref(settingsFile, saveNode),
      "lib/db/settings.ts:629",
      "lib/data-governance/content-protection-baseline.json:308",
    ],
    {
      rawIndexedDbApiKey: "synthetic-api-key",
      rawIndexedDbFingerprintApiKey: "synthetic-api-key",
      settingsContentProtection: protection.settings,
    },
    "Actual saveSettings AST with synthetic fake-indexeddb/Dexie fixture and raw IDB readback; default/locale/subscription/projection integration dependencies injected. Account encryption middleware not instantiated; its settings policy independently source-checked."
  )
} finally {
  await storageFixture.delete()
}

const imported = transfer.importSettingsProfile(profile)
assert.equal(imported.ok, true)
assert.equal(imported.patch.theme, "dark")
assert.equal(imported.patch.providerSettings, undefined)
assert.equal(imported.patch.customProviders, undefined)
observe(
  "global-settings-profile-does-not-roundtrip-provider-config",
  ["lib/settings/profile-transfer.ts:173", ref(settingsFile, variable(settingsFile, "DEFAULTS"))],
  {
    exportContainsProviderSettings: true,
    exportContainsCustomProviders: true,
    importDropsProviderSettings: true,
    importDropsCustomProviders: true,
    correctedHypothesis:
      "No destination credential deletion: the provider keys are dropped before saveSettings.",
  },
  "Actual export/import functions and real default-key membership; no Dexie or settings UI executed."
)

const storeFile = await source("stores/settings/settings-store.ts")
const addNode = oneNode(
  storeFile,
  (node) =>
    ts.isPropertyAssignment(node) && node.name.getText(storeFile.ast) === "addCustomProvider",
  "addCustomProvider implementation"
)
let storedCustom
const addStore = runTs(`exports.add = ${addNode.initializer.getText(storeFile.ast)};`, {
  get: () => ({
    upsertCustomProvider: async (value) => {
      storedCustom = value
    },
  }),
}).exports
await addStore.add({
  id: "custom-synthetic",
  customName: "Synthetic Gateway",
  apiKey: "synthetic-key",
  baseURL: "https://gateway.example/v1",
  apiProtocol: "anthropic",
  customModels: ["synthetic-model"],
  customHeaders: { "X-Tenant": "synthetic-tenant" },
  experimentalAgentSdk: true,
})
assert.equal(storedCustom.customHeaders, undefined)
assert.equal(storedCustom.experimentalAgentSdk, undefined)
observe(
  "new-custom-provider-drops-dialog-transport-settings",
  [ref(storeFile, addNode), "components/settings/provider/custom-provider-dialog.tsx:279"],
  {
    passedCustomHeaders: true,
    passedExperimentalAgentSdk: true,
    storedCustomHeaders: false,
    storedExperimentalAgentSdk: false,
  },
  "Actual addCustomProvider AST; captured upsert boundary. No database, native runtime, or UI executed."
)

const keyless = completeness.evaluateCustomProviderCompleteness({
  id: "custom-keyless",
  enabled: true,
  apiKey: "",
  baseURL: "http://127.0.0.1:12345/v1",
  defaultModel: "synthetic-model",
  apiProtocol: "openai",
})
assert.equal(keyless.eligibility.runtime.allowed, false)
assert.equal(keyless.eligibility.runtime.code, "missing_credential")
assert.equal(keyless.eligibility.testConnection.allowed, false)
observe(
  "keyless-custom-provider-is-always-ineligible",
  [
    "packages/provider-core/src/providers/completeness.ts:486",
    "components/settings/provider/custom-provider-dialog.tsx:334",
    "components/settings/provider/custom-provider-dialog.tsx:471",
  ],
  {
    validLocalEndpoint: true,
    dialogLabelsKeyOptional: true,
    runtime: keyless.eligibility.runtime,
    testConnection: keyless.eligibility.testConnection,
  },
  "Actual evaluateCustomProviderCompleteness; dialog optional label/save guard source-inspected. No local HTTP server or UI executed."
)

const bedrockBefore = {
  apiKey: "",
  bedrock: {
    region: "us-east-1",
    authMode: "iam",
    accessKeyId: "synthetic-a",
    secretAccessKey: "synthetic-a",
  },
}
const bedrockAfter = {
  apiKey: "",
  bedrock: {
    region: "eu-west-1",
    authMode: "iam",
    accessKeyId: "synthetic-b",
    secretAccessKey: "synthetic-b",
  },
}
assert.equal(
  completeness.buildProviderVerificationFingerprint(bedrockBefore),
  completeness.buildProviderVerificationFingerprint(bedrockAfter)
)
assert.equal(
  completeness.buildProviderVerificationFingerprint({ apiKey: "synthetic", apiFlavor: "chat" }),
  completeness.buildProviderVerificationFingerprint({ apiKey: "synthetic", apiFlavor: "responses" })
)
observe(
  "verification-fingerprint-ignores-bedrock-and-api-flavor",
  [
    "packages/provider-core/src/providers/completeness.ts:221",
    "hooks/settings/use-provider-settings.ts:443",
  ],
  {
    differentAwsCredentialsAndRegionHaveSameFingerprint: true,
    chatAndResponsesHaveSameFingerprint: true,
  },
  "Actual fingerprint function; verification race/stale-status consequences source-inspected, no real provider request executed."
)

const syncFile = await source("lib/settings/provider-profile-sync.ts")
const profileDb = () => ({ providerProfiles: [], deploymentProfiles: [], transportProfiles: [] })
let currentProfileDb = profileDb()
let profileWrites = 0
const derive = () => ({
  providerProfiles: [{ id: "synthetic-provider" }],
  deploymentProfiles: [{ id: "synthetic-deployment" }],
  transportProfiles: [],
  legacyAliases: {},
})
const sync = runTs(
  syncFile.text,
  {},
  {
    "@cognia/provider-types/profile-migration": { deriveProfiles: derive },
    "@cognia/provider-types/built-in-provider-catalog": { getBuiltInProviderCatalog: () => ({}) },
    "@/lib/db/schema": {
      getDb: () =>
        Object.fromEntries(
          Object.entries(currentProfileDb).map(([name, rows]) => [
            name,
            { toArray: async () => rows },
          ])
        ),
    },
    "@/lib/db/provider-profiles": {
      putDerivedProfiles: async (value) => {
        Object.assign(currentProfileDb, value)
        return ++profileWrites
      },
    },
  }
).exports
assert.equal(await sync.syncProviderProfilesFromSettings({}), 1)
currentProfileDb = profileDb()
assert.equal(await sync.syncProviderProfilesFromSettings({}), null)
assert.equal(currentProfileDb.deploymentProfiles.length, 0)
observe(
  "provider-profile-derivation-memo-is-not-database-scoped",
  [
    "lib/settings/provider-profile-sync.ts:39",
    "lib/settings/provider-profile-sync.ts:85",
    "lib/db/schema.ts:2470",
    "lib/gateway/snapshot-publisher.ts:537",
  ],
  {
    firstDatabaseWritten: true,
    secondEmptyDatabaseWithSameDerivationSkipped: true,
  },
  "Actual sync module; deterministic derivation and in-memory profile DB injected. Account/runtime switching and Gateway consumers source-inspected; not a full account switch or Dexie integration."
)

await mkdir(outputDir, { recursive: true })
const report = {
  generatedAt: new Date().toISOString(),
  runtime: process.version,
  scope:
    "Synthetic module/AST probes only; no product changes, real credentials, network, browser or native state.",
  sourceHashes: Object.fromEntries(
    [...loaded].map(([name, value]) => [
      name,
      createHash("sha256").update(value.text).digest("hex"),
    ])
  ),
  probes,
}
const output = path.join(outputDir, "storage-probes.json")
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(
  JSON.stringify(
    {
      assertions: "passed",
      reproducedProbeCount: probes.length,
      output: path.relative(root, output),
      probes: probes.map(({ id, status }) => ({ id, status })),
    },
    null,
    2
  )
)
