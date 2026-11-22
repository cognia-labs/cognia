// Local audit probes for prompt contract caching, resolution provenance, and eval dependency digests.
// Runs production TypeScript through the installed compiler in isolated VM contexts.
// Database, logging, and PII dependencies are stubbed; no account, UI, provider, or network calls.
// Assertions demonstrate bounded local counterexamples, not real-provider acceptance.
// Run from the repository root: node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.contract-probes.cjs

const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")
const repositoryRoot = path.resolve(__dirname, "../..")
const ts = require(require.resolve("typescript", { paths: [repositoryRoot] }))
const { webcrypto } = require("node:crypto")
function load(file, deps) {
  const { outputText } = ts.transpileModule(
    fs.readFileSync(path.join(repositoryRoot, file), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  )
  const module = { exports: {} }
  vm.runInNewContext(
    outputText,
    {
      module,
      exports: module.exports,
      require(name) {
        if (name in deps) return deps[name]
        throw new Error("Unexpected dependency " + name)
      },
      console,
      Date,
      Map,
      Set,
      TextEncoder,
      Uint8Array,
      crypto: webcrypto,
      structuredClone,
    },
    { filename: file }
  )
  return module.exports
}
const template = load("lib/prompts/template.ts", {
  "@cognia/redact": { hasNoLeakingPii: () => true },
})
const types = load("packages/plugin-contract/src/lib/prompts/types.ts", {})
const registry = load("lib/prompts/plugin-prompts.ts", { "./template": template, "./types": types })
const log = load("lib/prompts/resolution-log.ts", {})
const resolve = load("lib/prompts/resolve.ts", {
  "@cognia/logging": { loggers: { ai: { child: () => ({ warn: () => {} }) } } },
  "./template": template,
  "./snapshot": { peekPromptOverrideSnapshot: () => null },
  "./resolution-log": log,
  "./types": types,
})
const override = {
  bindingId: "binding",
  promptId: "plugin:test/slot",
  scope: "account",
  targetId: "",
  revisionId: "revision",
  body: "Old wording",
  contractVersion: 1,
}
const snapshot = {
  databaseName: "test",
  byPrompt: new Map([[override.promptId, [override]]]),
  loadedAt: 0,
}
registry.registerPluginPrompts(
  "test",
  [{ id: "slot", title: "Test", defaultBody: "Old default" }],
  "test"
)
resolve.resolvePrompt(registry.getPluginPromptEntry(override.promptId).def, {
  snapshot,
})
registry.registerPluginPrompts(
  "test",
  [
    {
      id: "slot",
      title: "Test",
      defaultBody: "New default REQUIRED_MARKER",
      requiredFragments: ["REQUIRED_MARKER"],
    },
  ],
  "test"
)
const newDefinition = registry.getPluginPromptEntry(override.promptId).def
const validation = template.validatePromptBody(newDefinition, override.body)
const cached = resolve.resolvePrompt(newDefinition, { snapshot })
resolve.__resetPromptVerdictsForTests()
const fresh = resolve.resolvePrompt(newDefinition, { snapshot })
assert(validation.some((i) => i.code === "missing-fragment"))
assert.equal(cached.source.kind, "override")
assert.equal(fresh.source.fallback, "invalid-body")
console.log(
  JSON.stringify(
    {
      scenario:
        "plugin prompt re-registers same default contract version with a changed requirement",
      validator: validation,
      cachedSource: cached.source,
      freshSource: fresh.source,
      cachedBody: cached.body,
      freshBody: fresh.body,
    },
    null,
    2
  )
)
log.__resetPromptResolutionsForTests()
resolve.resolvePrompt(newDefinition, { snapshot, context: { workspaceId: "preview-only" } })
assert.equal(log.lastPromptResolution(override.promptId).context.workspaceId, "preview-only")
console.log(
  JSON.stringify(
    {
      scenario: "resolution without model dispatch updates last-used record",
      recorded: log.lastPromptResolution(override.promptId),
      providerCalls: 0,
    },
    null,
    2
  )
)
let binding = {
  id: "binding",
  promptId: "chat.brief",
  scope: "account",
  targetId: "",
  activeRevisionId: "published",
  draftRevisionId: null,
  rev: 1,
  updatedAt: 1,
}
const revision = { id: "published", body: "unchanged published wording", contractVersion: 1 }
const db = {
  promptOverrides: { toArray: async () => [structuredClone(binding)] },
  promptOverrideRevisions: { bulkGet: async () => [revision] },
  characters: { get: async () => ({ id: "agent", systemPrompt: "same" }) },
}
const evalService = load("lib/ai/eval/project-service.ts", {
  "@cognia/eval-core": {},
  "@/lib/db/eval-lab": {},
  "@/lib/db/schema": { getDb: () => db },
  "@cognia/eval-core/seeded-random": {},
  "@/lib/db/settings": { getSettings: async () => ({ defaultSystemPrompt: "same" }) },
})
;(async () => {
  const variant = { id: "candidate", kind: "chat", targetId: "agent" }
  const initial = await evalService.digestEvalDependency(
    await evalService.readEvalTargetDependency(variant)
  )
  binding = { ...binding, draftRevisionId: "unpublished-draft", rev: 2, updatedAt: 2 }
  const afterDraftSave = await evalService.digestEvalDependency(
    await evalService.readEvalTargetDependency(variant)
  )
  assert.notEqual(initial, afterDraftSave)
  console.log(
    JSON.stringify(
      {
        scenario:
          "saving unpublished draft changes eval target digest with identical active revision",
        initial,
        afterDraftSave,
        activeRevisionUnchanged: binding.activeRevisionId === revision.id,
        publishedBody: revision.body,
      },
      null,
      2
    )
  )
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
