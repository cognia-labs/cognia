/**
 * Read-only adversarial probes: real CogniaDB schema/account selection, real
 * Dexie transactions, fake-indexeddb in memory, and actual prompt modules.
 * No user database, network/provider, account vault, or product file is touched.
 * Peripheral encryption/sync/session-list middleware and application services
 * are explicitly inert below. The catalog contains one real plugin definition.
 * Assertions document current counterexamples AND controls, not fixed behavior.
 * Run from repo root with node; output is JSON lines.
 */
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { webcrypto } from "node:crypto"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(path.join(root, "package.json"))
const ts = require("typescript")
require("fake-indexeddb/auto")
const Dexie = require("dexie").default
const modules = new Map()
const stubs = new Map()
const noop = () => {}
const middleware = (name) => () => ({ stack: "dbcore", name, create: (down) => down })
const inertMiddleware = {
  "lib/db/message-sync-revision.ts": {
    createMessageSyncRevisionMiddleware: middleware("probe-message-sync"),
    backfillMessageSyncRevision: noop,
  },
  "lib/account-sync/data/capture-middleware.ts": {
    createAccountSyncCaptureMiddleware: middleware("probe-account-sync"),
  },
  "lib/db/encrypted-content-middleware.ts": {
    createEncryptedContentMiddleware: middleware("probe-encryption"),
  },
  "lib/db/session-list.ts": {
    createSessionListMiddleware: middleware("probe-session-list"),
    createSessionListWitnessMiddleware: middleware("probe-session-witness"),
    backfillSessionList: noop,
    SESSION_LIST_SCHEMA: {},
  },
}
for (const [file, exports] of Object.entries(inertMiddleware)) stubs.set(file, exports)
const logger = { warn: noop, info: noop, error: noop, debug: noop, child: () => logger }
for (const [file, exports] of Object.entries({
  "lib/execution/personal-sink.ts": { explicitHostPersonalSinkContext: noop },
  "lib/db/upgrade-blocked-signal.ts": { dispatchDbUpgradeBlocked: noop },
  "@cognia/diagnostics": { createDiagnostic: noop },
  "lib/diagnostics/bus.ts": { dispatchDiagnostic: noop },
  "lib/platform/detect.ts": { isTauri: () => false },
  "lib/accounts/content-cipher.ts": { activateAccountContentCipher: noop },
  "lib/notifications/identity-cache.ts": {
    setNotificationNamespaceAccount: noop,
    getNotificationIdentity: () => null,
  },
  "lib/runtime/browser-vault.ts": { getActiveBrowserVault: () => null },
  "lib/router-fusion/gate/database-name.ts": { withFusionDatabase: (name) => [name] },
  "@cognia/logging": { loggers: { ai: logger, shell: logger } },
  "@cognia/agent-config-types/agent-composition": {},
  "lib/db/settings.ts": { getSettings: async () => ({}), saveSettings: async () => {} },
  "lib/db/tombstones.ts": { recordTombstones: async () => {} },
  "lib/plugin/messaging/hooks-system.ts": {
    getPluginEventHooks: () => ({ dispatchProjectUpdate: noop, dispatchProjectCreate: noop }),
  },
  "lib/db/project-scope.ts": {},
  "lib/workspace/rebind-workspace-schedules.ts": {},
  "lib/task-workspace/execution-port-lease.ts": {},
  "lib/workspace/locate-workspace.ts": {},
  "lib/db/eval-lab.ts": {},
  "@cognia/eval-core": {},
  "@cognia/eval-core/seeded-random": {},
}))
  stubs.set(file, exports)

// Nothing below the executor's dependency-drift guard is permitted to run.
for (const file of [
  "lib/ai/provider-consumption.ts",
  "lib/ai/renderer-llm-client.ts",
  "lib/workflow/nodes/ai/pii-gate.ts",
  "lib/db/eval-datasets.ts",
  "lib/ai/eval/artifact-crypto.ts",
  "lib/ai/eval/orchestrator.ts",
  "lib/ai/eval/finalization.ts",
  "lib/ai/eval/targets/create-from-spec.ts",
  "lib/ai/eval/targets/chat.ts",
  "lib/ai/eval/targets/model.ts",
  "lib/ai/eval/targets/team-default-deps.ts",
  "lib/ai/eval/targets/workflow-default-deps.ts",
  "lib/ai/eval/provider-locality.ts",
  "lib/execution/personal-visibility.ts",
])
  stubs.set(file, {})

function resolveId(id, parent) {
  if (id === "@cognia/redact") return "packages/redact/src/index.ts"
  if (id.startsWith("@cognia/plugin-contract/")) {
    return `packages/plugin-contract/src/${id.slice("@cognia/plugin-contract/".length)}.ts`
  }
  const candidate = id.startsWith("@/")
    ? id.slice(2)
    : id.startsWith(".")
      ? path.relative(root, path.resolve(root, path.dirname(parent), id))
      : null
  if (!candidate) return id
  for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
    if (existsSync(path.join(root, candidate + suffix))) return candidate + suffix
  }
  return candidate + ".ts"
}

function load(file) {
  if (stubs.has(file)) return stubs.get(file)
  if (modules.has(file)) return modules.get(file).exports
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return require(file)
  const module = { exports: {} }
  modules.set(file, module)
  const { outputText } = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  })
  vm.runInNewContext(
    outputText,
    {
      module,
      exports: module.exports,
      require: (id) => load(resolveId(id, file)),
      console,
      crypto: webcrypto,
      TextEncoder,
      TextDecoder,
      process: { env: { NODE_ENV: "test" } },
      indexedDB: globalThis.indexedDB,
      IDBKeyRange: globalThis.IDBKeyRange,
      DOMException,
      Error,
      Map,
      Set,
      Date,
      Promise,
      AbortController,
      structuredClone,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
    },
    { filename: path.join(root, file) }
  )
  return module.exports
}

const schema = load("lib/db/schema.ts")
const releaseRuntime = schema.__enableDbRuntimeForTesting()
const databaseNames = new Set()
function activate(accountId) {
  schema.activateAccountDatabase(accountId)
  databaseNames.add(schema.getDb().name)
}
load("lib/db/prompt-overrides.ts")
const snapshots = load("lib/prompts/snapshot.ts")
const resolver = load("lib/prompts/resolve.ts")
const service = load("lib/prompts/service.ts")
const plugin = load("lib/prompts/plugin-prompts.ts")
const template = load("lib/prompts/template.ts")
stubs.set("lib/prompts/catalog.ts", {
  loadPromptCatalog: async () => {},
  getPromptDefinition: (id) => plugin.getPluginPromptEntry(id)?.def,
})
const profiles = load("lib/prompts/profile.ts")
const account = { scope: "account", targetId: "" }
const declaration = { id: "storage", title: "Storage probe", defaultBody: "Shipped probe" }
plugin.registerPluginPrompts("audit-storage", [declaration], "offline-probe")
const def = plugin.getPluginPromptEntry("plugin:audit-storage/storage").def
const report = (probe, result) => console.log(JSON.stringify({ probe, ...result }))
const publish = (body, expectedRev, target = account) =>
  service.publishPromptBody({ def, target, body, expectedRev })
async function fresh(accountId) {
  snapshots.invalidatePromptOverrideSnapshot()
  resolver.__resetPromptVerdictsForTests()
  activate(accountId)
  await schema.getDb().open()
}
async function importPreview(body, contractVersion = 1) {
  return profiles.previewPromptProfileImport({
    entries: [
      {
        promptId: def.id,
        scope: "account",
        targetId: "",
        contractVersion,
        baseDigest: await service.shippedBodyDigest(def),
        body,
      },
    ],
  })
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15))

try {
  await fresh("acct_probe_import")
  const original = await publish("Reviewed original", 0)
  const preview = await importPreview("Imported replacement")
  const concurrent = await publish("Concurrent author edit", original.rev)
  const applied = await profiles.applyPromptProfileImport(preview, new Set([0]))
  assert.equal(applied.applied, 1)
  assert.equal(applied.conflicted.length, 0)
  assert.equal((await service.readPromptSlot(def.id, account)).active.body, "Imported replacement")
  await assert.rejects(
    publish("Stale direct writer", concurrent.rev),
    (error) => error.code === "prompt_override_conflict"
  )
  report("F02-replace-after-concurrent-publish", {
    applied,
    directStaleWriter: "rejected",
    actualStorage: "CogniaDB + Dexie + fake-indexeddb",
  })

  await fresh("acct_probe_new")
  const newPreview = await importPreview("Imported replacement")
  await publish("Concurrent publish", 0)
  const newApplied = await profiles.applyPromptProfileImport(newPreview, new Set([0]))
  assert.equal(newApplied.applied, 0)
  assert.equal(newApplied.conflicted.length, 1)
  report("F02-new-preview-control", {
    applied: newApplied.applied,
    conflicts: newApplied.conflicted.length,
  })

  await fresh("acct_probe_eval")
  const projectService = load("lib/ai/eval/project-service.ts")
  const variant = { id: "chat-probe", kind: "chat", targetId: "absent-character" }
  const dependency = () => projectService.readEvalTargetDependency(variant)
  const digest = (value) => projectService.digestEvalDependency(value)
  const emptyDigest = await digest(await dependency())
  const draftOnly = await service.savePromptDraft({
    def,
    target: account,
    body: "Unpublished draft",
    expectedRev: 0,
  })
  assert.equal(await digest(await dependency()), emptyDigest)
  assert.equal((await resolver.resolvePromptAsync(def)).source.kind, "default")
  const published = await publish("Published stable text", draftOnly.rev)
  const before = await dependency()
  const beforeDigest = await digest(before)
  await service.savePromptDraft({
    def,
    target: account,
    body: "Second unpublished draft",
    expectedRev: published.rev,
  })
  const after = await dependency()
  const afterDigest = await digest(after)
  assert.notEqual(afterDigest, beforeDigest)
  assert.equal(after.prompts[0].revision.id, before.prompts[0].revision.id)
  assert.equal((await resolver.resolvePromptAsync(def)).text, "Published stable text")
  const executor = load("lib/ai/eval/browser-execution.ts").createBrowserEvalTaskExecutor(
    {},
    {
      loadExperiment: async () => ({
        manifest: { variants: [variant], targetDigests: { [variant.id]: beforeDigest } },
      }),
      loadCase: async () => ({ id: "case-probe" }),
      readTargetDependency: dependency,
      buildTarget: () => {
        throw new Error("UNEXPECTED_TARGET_BUILD")
      },
    }
  )
  let executorError
  try {
    await executor(
      { experimentId: "experiment-probe", variantId: variant.id, caseId: "case-probe" },
      new AbortController().signal
    )
  } catch (error) {
    executorError = error.message
  }
  assert.match(executorError, /Evaluation target chat-probe changed/)
  report("F06-draft-metadata-rejects-execution", {
    beforeDigest,
    afterDigest,
    publishedRevisionUnchanged: true,
    runtimeText: "Published stable text",
    draftOnlyControl: "digest unchanged",
    executorError,
  })

  const redefined = {
    ...declaration,
    defaultBody: "RequiredMarker shipped",
    requiredFragments: ["RequiredMarker"],
  }
  plugin.registerPluginPrompts("audit-storage", [redefined], "offline-probe")
  const currentDef = plugin.getPluginPromptEntry(def.id).def
  assert.ok(
    template
      .validatePromptBody(currentDef, "Published stable text")
      .some((issue) => issue.code === "missing-fragment")
  )
  assert.equal((await resolver.resolvePromptAsync(currentDef)).source.kind, "override")
  resolver.__resetPromptVerdictsForTests()
  assert.equal((await resolver.resolvePromptAsync(currentDef)).source.fallback, "invalid-body")
  plugin.registerPluginPrompts(
    "audit-storage",
    [{ ...redefined, contractVersion: 2 }],
    "offline-probe"
  )
  assert.equal(
    (await resolver.resolvePromptAsync(plugin.getPluginPromptEntry(def.id).def)).source.fallback,
    "contract-incompatible"
  )
  plugin.registerPluginPrompts("audit-storage", [declaration], "offline-probe")
  report("F07-same-version-plugin-contract-change", {
    cached: "override",
    fresh: "invalid-body",
    versionBumpControl: "contract-incompatible",
  })

  await fresh("acct_probe_import_upgrade")
  await publish("Same valid body", 0)
  plugin.registerPluginPrompts(
    "audit-storage",
    [{ ...declaration, contractVersion: 2 }],
    "offline-probe"
  )
  const versionTwoDef = plugin.getPluginPromptEntry(def.id).def
  const sameVersionTwoPreview = await importPreview("Same valid body", 2)
  assert.equal(sameVersionTwoPreview[0].status, "unchanged")
  const sameVersionTwoResult = await profiles.applyPromptProfileImport(
    sameVersionTwoPreview,
    new Set([0])
  )
  assert.equal(sameVersionTwoResult.applied, 0)
  const staleContractResolution = await resolver.resolvePromptAsync(versionTwoDef)
  assert.equal(staleContractResolution.source.fallback, "contract-incompatible")
  const changedVersionTwoPreview = await importPreview("Different valid body", 2)
  assert.equal(changedVersionTwoPreview[0].status, "replace")
  assert.equal(
    (await profiles.applyPromptProfileImport(changedVersionTwoPreview, new Set([0]))).applied,
    1
  )
  assert.equal((await resolver.resolvePromptAsync(versionTwoDef)).text, "Different valid body")
  report("omission-same-body-import-skips-contract-upgrade", {
    sameBodyPreview: sameVersionTwoPreview[0].status,
    sameBodyApplied: sameVersionTwoResult.applied,
    sameBodyFallback: staleContractResolution.source.fallback,
    changedBodyControl: "published version 2 and resolved override",
  })
  plugin.registerPluginPrompts("audit-storage", [declaration], "offline-probe")

  await fresh("acct_probe_workspace")
  const projectDb = schema.getDb()
  const projectStore = load("stores/project/project-store.ts").useProjectStore
  const adapter = load(
    "lib/prompts/adapters/workspace-instructions.ts"
  ).workspaceInstructionsPromptAdapter
  const project = {
    id: "workspace-probe",
    name: "Workspace probe",
    customInstructions: "Durable original",
    roots: [],
  }
  await projectDb.projects.put(project)
  projectStore.setState({ projects: [project], loaded: true })
  let attempted = 0
  const abortWrite = function () {
    attempted += 1
    throw new DOMException("Injected quota boundary", "QuotaExceededError")
  }
  projectDb.projects.hook("updating", abortWrite)
  const acknowledged = await adapter.save(
    "workspace-instructions:workspace-probe",
    "Acknowledged but lost",
    undefined,
    { workspace: project }
  )
  await settle()
  projectDb.projects.hook("updating").unsubscribe(abortWrite)
  assert.equal(attempted, 1)
  assert.equal(acknowledged.text, "Acknowledged but lost")
  assert.equal((await projectDb.projects.get(project.id)).customInstructions, "Durable original")
  const normal = await adapter.save(
    "workspace-instructions:workspace-probe",
    "Successful durable save",
    undefined,
    { workspace: project }
  )
  await settle()
  assert.equal((await projectDb.projects.get(project.id)).customInstructions, normal.text)
  report("F13-workspace-save-swallowed-storage-error", {
    acknowledged: acknowledged.text,
    persistedAfterFailure: "Durable original",
    attempted,
    successfulWriteControl: normal.text,
  })

  await fresh("acct_probe_write_a")
  const authoredOnA = publish("Authored while account A was active", 0)
  // WebCrypto hashing is genuinely asynchronous; no delay or write is mocked.
  activate("acct_probe_write_b")
  const writeResult = await authoredOnA
  const storedOnB = await service.readPromptSlot(def.id, account)
  assert.equal(storedOnB.active.body, "Authored while account A was active")
  activate("acct_probe_write_a")
  assert.equal((await service.readPromptSlot(def.id, account)).binding, undefined)
  report("omission-publish-crosses-account-during-digest", {
    revision: writeResult.rev,
    accountA: "no binding",
    accountB: storedOnB.active.body,
    boundary: "actual WebCrypto await + actual activateAccountDatabase; no artificial delay",
  })

  await fresh("acct_probe_switch_a")
  await publish("Account A static override", 0)
  await fresh("acct_probe_switch_b")
  await publish("Account B static override", 0)
  await fresh("acct_probe_switch_a")
  await snapshots.loadPromptOverrideSnapshot()
  activate("acct_probe_switch_b")
  assert.equal(snapshots.peekPromptOverrideSnapshot(), null)
  assert.equal(resolver.resolvePrompt(def).source.fallback, "snapshot-unavailable")
  assert.equal((await resolver.resolvePromptAsync(def)).text, "Account B static override")
  report("C-A-completed-load-switch-control", {
    sync: "snapshot-unavailable",
    async: "Account B static override",
  })

  await fresh("acct_probe_switch_a")
  const preReadLoad = snapshots.loadPromptOverrideSnapshot().catch((error) => error.name)
  activate("acct_probe_switch_b")
  const preReadResultB = await resolver.resolvePromptAsync(def)
  const preReadResult = await preReadLoad
  assert.notEqual(preReadResultB.text, "Account A static override")
  report("C-A-immediate-switch-after-load-start-control", {
    load: typeof preReadResult === "string" ? preReadResult : preReadResult.databaseName,
    resultB: preReadResultB.text,
    source: preReadResultB.source,
  })

  await fresh("acct_probe_switch_a")
  const dbA = schema.getDb()
  let resolvingB
  let switched = false
  // Real Dexie reading hook: the old account's IDB result is already decoded,
  // but readSnapshot/resolvePromptAsync have not received it. No read is mocked.
  const switchAfterIdbRead = (row) => {
    if (!switched) {
      switched = true
      activate("acct_probe_switch_b")
      resolvingB = resolver.resolvePromptAsync(def)
    }
    return row
  }
  dbA.promptOverrideRevisions.hook("reading", switchAfterIdbRead)
  const oldLoad = snapshots.loadPromptOverrideSnapshot()
  const oldResult = await oldLoad
  const resultB = await resolvingB
  assert.equal(dbA.isOpen(), false)
  assert.equal(resultB.text, "Account A static override")
  assert.equal(snapshots.peekPromptOverrideSnapshot(), null)
  assert.equal((await resolver.resolvePromptAsync(def)).text, "Account B static override")
  report("C-A-fulfilled-read-handoff-real-activation", {
    oldDatabase: oldResult.databaseName,
    activeDatabase: schema.getDb().name,
    oldDatabaseClosed: !dbA.isOpen(),
    resultB: resultB.text,
    guardedPeek: null,
    nextFreshResolution: "Account B static override",
    boundary:
      "actual activateAccountDatabase + real IDB result; deterministic reading-hook interleaving; no UI/vault/Host",
  })
} finally {
  snapshots.invalidatePromptOverrideSnapshot()
  schema.__resetDbForTesting()
  releaseRuntime()
  for (const name of databaseNames) await Dexie.delete(name)
}
